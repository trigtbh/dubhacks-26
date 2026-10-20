#!/bin/bash
# Install sid on a Linux host and start its system-wide capture service.
# The capture uses fanotify permission events and eBPF from the host kernel.
#
# Usage: sudo bash linux/install.sh [SRC] [options]
#   SRC               repository root (default: this script's parent directory)
#   --venv            create /opt/sid-venv and install laya + torch
#   --gpu             with --venv, install the CUDA build of torch
#   --with-dashboard  also build, install, and start the web dashboard
#
# Without options it builds the daemon, writes /etc/sid/model.env if absent,
# installs the service, and starts capture. The model environment (a venv with
# laya and torch) must already exist unless --venv is given.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX=/usr/local
MK_VENV=""
GPU=""
DASHBOARD=""
for arg in "$@"; do
	case "$arg" in
		--venv) MK_VENV=1 ;;
		--gpu) GPU=1 ;;
		--with-dashboard) DASHBOARD=1 ;;
		--*) echo "unknown option: $arg" >&2; exit 2 ;;
		*) SRC="$(cd "$arg" && pwd)" ;;
	esac
done

if [ "$(id -u)" -ne 0 ]; then
	echo "install.sh must run as root" >&2
	exit 1
fi

# Optional: create the model environment so the daemon has a Python with laya + torch.
if [ -n "$MK_VENV" ]; then
	python3 -m venv /opt/sid-venv
	if [ -n "$GPU" ]; then
		/opt/sid-venv/bin/pip install --quiet laya torch --index-url https://download.pytorch.org/whl/cu128
	else
		/opt/sid-venv/bin/pip install --quiet laya torch
	fi
fi

# Build and install the daemon, eBPF object, and model worker.
install -d /var/log/sid
rm -rf /usr/local/lib/sid/sid /usr/local/lib/sid/libsid_decide.so  # old Python daemon
make -s -C "$SRC" BUILD=/tmp/sid-build PREFIX="$PREFIX" install
touch /var/log/sid/decisions.jsonl
chown nobody /var/log/sid/decisions.jsonl 2>/dev/null || true

# Write the service config if the admin has not already provided one. Paths are
# absolute so the daemon finds the model regardless of its working directory.
if [ ! -f /etc/sid/model.env ]; then
	install -d /etc/sid
	if [ -x /opt/sid-venv/bin/python ]; then
		PY=/opt/sid-venv/bin/python
	elif [ -x "$SRC/.venv/bin/python" ]; then
		PY="$SRC/.venv/bin/python"
	else
		PY=python3
	fi
	cat > /etc/sid/model.env <<EOF
SID_MODEL_PYTHON=$PY
SID_MODEL_WORKER=$PREFIX/lib/sid/runtime/laya_worker.py
SID_LAYA_CHECKPOINT=$SRC/.data/pilot-v2/finetune-04/checkpoint
SID_LAYA_DEVICE=auto
EOF
	echo "wrote /etc/sid/model.env (edit it to change the model or checkpoint)"
fi

# Install the service, pointing its working directory at this checkout.
sed "s|^WorkingDirectory=.*|WorkingDirectory=$SRC|" "$SRC/linux/sid.service" \
	> /etc/systemd/system/sid.service
systemctl daemon-reload
systemctl enable sid >/dev/null 2>&1
systemctl restart sid || { journalctl -u sid -n 30 --no-pager -o cat; echo "sid failed to start" >&2; exit 1; }
echo "sid capture is active"

# Optional: the web dashboard on 127.0.0.1:8080. Building the page needs Node.
if [ -n "$DASHBOARD" ]; then
	make -s -C "$SRC/frontend" dist
	make -s -C "$SRC/frontend" PREFIX="$PREFIX" install
	install -m 644 "$SRC/frontend/sid-web.service" /etc/systemd/system/sid-web.service
	systemctl daemon-reload
	systemctl enable --now sid-web >/dev/null 2>&1
	echo "sid dashboard is active on 127.0.0.1:8080"
fi
