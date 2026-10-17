#!/usr/bin/env bash
# Start the sid Linux VM (x86_64 Ubuntu 24.04), install sid into it, open a shell.
#   ./vm.sh            start VM if needed, install sid, open a shell
#   ./vm.sh --stop     stop the VM
#   ./vm.sh --logs     follow the capture log (the "THIS IS BEING RUN IN THE CAPTURE" banners)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM=sid

case "${1:-}" in
    --stop) limactl stop "$VM"; exit 0 ;;
    --logs) exec limactl shell --workdir / "$VM" sudo journalctl -fu sid -o cat ;;
    "") ;;
    *) sed -n '2,6p' "$0"; exit 1 ;;
esac

status="$(limactl list --format '{{.Status}}' "$VM" 2>/dev/null || true)"
case "$status" in
    Running) ;;
    Stopped) limactl start "$VM" ;;
    *)       limactl start --name="$VM" --tty=false "$ROOT/vm/sid.yaml" ;;
esac

limactl shell --workdir / "$VM" sudo bash /workspace/vm/install.sh /workspace
exec limactl shell --workdir /workspace "$VM"
