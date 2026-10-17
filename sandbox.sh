#!/usr/bin/env bash
# Build and start the sid sandbox container (x86_64 Ubuntu 24.04, with the sid
# capture running inside), then ssh into it.
#
#   ./sandbox.sh            start (or reuse) the container and open a shell
#   ./sandbox.sh --rebuild  rebuild the image and recreate the container
#   ./sandbox.sh --reset    recreate the container (keeps the image and caches)
#   ./sandbox.sh --stop     stop and remove the container
#   ./sandbox.sh --logs     follow sid's capture log (THIS IS BEING RUN IN THE CAPTURE)
#
# Where it runs:
#   native x86_64 Linux  a Docker container on this machine (shares the host kernel)
#   anything else        (Apple Silicon, ARM Linux, Intel Mac, ...) no container: the
#                        x86_64 Linux VM from vm/sid.yaml is the sandbox (see vm.sh).
#                        The capture needs a real x86 Linux kernel with fanotify
#                        permission events: Docker Desktop's kernel has none and
#                        emulated x86 cannot do it either.
#   SID_FORCE_VM=1 forces the VM path on x86 Linux too.
#
# Env overrides: SSH_PORT (2222), DASHBOARD_PORT (8080), SANDBOX_MEMORY (8g), SANDBOX_CPUS (4).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="sid-sandbox:latest"
NAME="sid-sandbox"
PLATFORM="linux/amd64"
DEV_USER="dev"
SSH_PORT="${SSH_PORT:-2222}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8080}"
STATE="$ROOT/.sandbox"
KEY="$STATE/id_ed25519"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 || "${SID_FORCE_VM:-0}" == 1 ]]; then
    # --rebuild/--reset have no meaning without a container: vm.sh reinstalls every run.
    case "${1:-}" in
        --rebuild | --reset) exec "$ROOT/vm.sh" ;;
        *) exec "$ROOT/vm.sh" "$@" ;;
    esac
fi

dk() { docker "$@"; }
SRC="$ROOT"

rebuild=0 reset=0
case "${1:-}" in
    --rebuild) rebuild=1 reset=1 ;;
    --reset) reset=1 ;;
    --stop) dk rm -f "$NAME" >/dev/null 2>&1 || true; echo "stopped $NAME"; exit 0 ;;
    --logs) dk exec "$NAME" tail -n 50 -F /var/log/sid/daemon.log; exit 0 ;;
    "") ;;
    *) sed -n '2,10p' "$0"; exit 1 ;;
esac

docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 1; }
if ! { zcat /proc/config.gz 2>/dev/null || cat "/boot/config-$(uname -r)" 2>/dev/null; } | grep -q '^CONFIG_FANOTIFY_ACCESS_PERMISSIONS=y'; then
    echo "warning: cannot confirm this kernel has CONFIG_FANOTIFY_ACCESS_PERMISSIONS; sid may not start" >&2
fi

# Dedicated keypair for the sandbox; never reuses the host's ~/.ssh keys.
mkdir -p "$STATE"
[[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N "" -C "sid-sandbox" -f "$KEY"
cp "$KEY.pub" "$STATE/authorized_keys"

if (( rebuild )) || ! dk image inspect "$IMAGE" >/dev/null 2>&1; then
    build_args=()
    # Match the host UID on Linux so /workspace stays writable; Docker
    # Desktop on macOS maps ownership for us.
    [[ "$(uname -s)" == Linux ]] && build_args+=(--build-arg "DEV_UID=$(id -u)")
    dk build --platform "$PLATFORM" ${build_args[@]+"${build_args[@]}"} -t "$IMAGE" "$SRC/sandbox"
fi

(( reset )) && dk rm -f "$NAME" >/dev/null 2>&1 || true

if [[ "$(dk inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]]; then
    dk rm -f "$NAME" >/dev/null 2>&1 || true
    # --privileged --pid=host: sid's fanotify and eBPF act on the shared kernel, and
    # eBPF reports host-namespace thread ids, which must match fanotify's.
    dk run -d \
        --name "$NAME" --hostname sid \
        --platform "$PLATFORM" \
        --init --privileged --pid=host \
        --memory "${SANDBOX_MEMORY:-8g}" --cpus "${SANDBOX_CPUS:-4}" --pids-limit 4096 \
        -p "127.0.0.1:${SSH_PORT}:22" \
        -p "127.0.0.1:${DASHBOARD_PORT}:8080" \
        --tmpfs /var/lib/sid/explore:rw,exec,suid,dev,size=2g,mode=0700 \
        -v "$SRC:/workspace" \
        -v "$SRC/.sandbox/authorized_keys:/run/sandbox/authorized_keys:ro" \
        -v sid-sandbox-cache:/home/$DEV_USER/.cache \
        "$IMAGE" >/dev/null
    echo "started $NAME"
fi

ssh_opts=(
    -i "$KEY" -p "$SSH_PORT"
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
)

# The first start builds sid before sshd comes up, so allow time.
echo "waiting for the sandbox (building sid on first start)..."
for _ in $(seq 1 180); do
    ssh -n "${ssh_opts[@]}" -o ConnectTimeout=2 -o BatchMode=yes \
        "$DEV_USER@127.0.0.1" true 2>/dev/null && break
    sleep 1
done

exec ssh "${ssh_opts[@]}" -t "$DEV_USER@127.0.0.1" "cd /workspace && exec bash -l"
