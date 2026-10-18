#!/bin/bash
# Install sid on a Linux host and start its system-wide capture service.
# The capture uses fanotify permission events and eBPF from the host kernel.
set -euo pipefail
SRC="${1:-/workspace}"
install -d /var/log/sid
rm -rf /usr/local/lib/sid/sid /usr/local/lib/sid/libsid_decide.so  # old Python daemon
make -s -C "$SRC" BUILD=/tmp/sid-build PREFIX=/usr/local install
install -m 644 "$SRC/linux/sid.service" /etc/systemd/system/sid.service
systemctl daemon-reload
systemctl enable sid >/dev/null 2>&1
systemctl restart sid || { journalctl -u sid -n 30 --no-pager -o cat; echo "sid failed to start" >&2; exit 1; }
echo "sid capture is active"
