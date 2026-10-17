#!/bin/bash
# Runs inside the VM as root: copy sid out of the 9p mount and (re)start the service.
# The unit is Type=notify, so `systemctl restart` returns once the capture is live.
set -euo pipefail
SRC="${1:-/workspace}"
install -d /usr/local/lib/sid /var/log/sid
rm -rf /usr/local/lib/sid/sid
cp -r "$SRC/src/sid" /usr/local/lib/sid/sid
find /usr/local/lib/sid -name __pycache__ -prune -exec rm -rf {} +
install -m 644 "$SRC/vm/sid.service" /etc/systemd/system/sid.service
systemctl daemon-reload
systemctl enable sid >/dev/null 2>&1
systemctl restart sid || { journalctl -u sid -n 30 --no-pager -o cat; echo "sid failed to start" >&2; exit 1; }
echo "sid capture is active"
