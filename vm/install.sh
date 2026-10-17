#!/bin/bash
# Runs inside the VM as root: build sid from the 9p mount (into /tmp) and (re)start the service.
# The unit is Type=notify, so `systemctl restart` returns once the capture is live.
set -euo pipefail
SRC="${1:-/workspace}"
install -d /var/log/sid
rm -rf /usr/local/lib/sid/sid /usr/local/lib/sid/libsid_decide.so  # old Python daemon
make -s -C "$SRC" BUILD=/tmp/sid-build PREFIX=/usr/local install
install -m 644 "$SRC/vm/sid.service" /etc/systemd/system/sid.service
systemctl daemon-reload
systemctl enable sid >/dev/null 2>&1
systemctl restart sid || { journalctl -u sid -n 30 --no-pager -o cat; echo "sid failed to start" >&2; exit 1; }
echo "sid capture is active"
