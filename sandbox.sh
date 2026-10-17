#!/usr/bin/env bash
# Build and start the sid sandbox container, then ssh into it.
#
#   ./sandbox.sh            start (or reuse) the container and open a shell
#   ./sandbox.sh --rebuild  rebuild the image and recreate the container
#   ./sandbox.sh --reset    recreate the container (keeps the image and caches)
#   ./sandbox.sh --stop     stop and remove the container
#
# NOTE: Docker Desktop's kernel has no fanotify permission events, so the capture
# does not run here. Use ./vm.sh for that.
#
# Env overrides: SSH_PORT (2222), DASHBOARD_PORT (8080), SANDBOX_MEMORY (8g),
# SANDBOX_CPUS (4), SANDBOX_PRIVILEGED=1 (full --privileged, e.g. for BPF work).
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

rebuild=0 reset=0
case "${1:-}" in
    --rebuild) rebuild=1 reset=1 ;;
    --reset) reset=1 ;;
    --stop) docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "stopped $NAME"; exit 0 ;;
    "") ;;
    *) sed -n '2,11p' "$0"; exit 1 ;;
esac

docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 1; }

# amd64 on a non-x86 Docker host runs under binary translation (Rosetta/QEMU),
# where seccomp filter installs fail with EINVAL and strace is unreliable.
host_arch="$(docker info -f '{{.Architecture}}')"
[[ "$host_arch" == x86_64 ]] || echo "warning: amd64 is emulated on this $host_arch" \
    "docker host; seccomp user notification and strace will not work here" >&2

# Dedicated keypair for the sandbox; never reuses the host's ~/.ssh keys.
mkdir -p "$STATE"
[[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N "" -C "sid-sandbox" -f "$KEY"
cp "$KEY.pub" "$STATE/authorized_keys"

if (( rebuild )) || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    build_args=()
    # Match the host UID on Linux so /workspace stays writable; Docker
    # Desktop on macOS maps ownership for us.
    [[ "$(uname -s)" == Linux ]] && build_args+=(--build-arg "DEV_UID=$(id -u)")
    docker build --platform "$PLATFORM" ${build_args[@]+"${build_args[@]}"} \
        -t "$IMAGE" "$ROOT/sandbox"
fi

(( reset )) && docker rm -f "$NAME" >/dev/null 2>&1 || true

if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true

    if [[ "${SANDBOX_PRIVILEGED:-0}" == 1 ]]; then
        security=(--privileged)
    else
        # SYS_ADMIN:  seccomp filter without no_new_privs, setcap, overlayfs, unshare
        # SYS_PTRACE: strace, reading /proc/<pid>/mem of paused processes
        # NET_ADMIN:  nftables bans, network namespaces
        # seccomp/apparmor unconfined: Docker's profiles block mount/unshare and
        # we stack our own seccomp filters on top anyway.
        security=(
            --cap-add SYS_ADMIN --cap-add SYS_PTRACE --cap-add NET_ADMIN
            --security-opt seccomp=unconfined --security-opt apparmor=unconfined
        )
    fi

    docker run -d \
        --name "$NAME" --hostname sid \
        --platform "$PLATFORM" \
        --init \
        "${security[@]}" \
        --memory "${SANDBOX_MEMORY:-8g}" --cpus "${SANDBOX_CPUS:-4}" --pids-limit 4096 \
        -p "127.0.0.1:${SSH_PORT}:22" \
        -p "127.0.0.1:${DASHBOARD_PORT}:8080" \
        --tmpfs /var/lib/sid/explore:rw,exec,suid,dev,size=2g,mode=0700 \
        -v "$ROOT:/workspace" \
        -v "$STATE/authorized_keys:/run/sandbox/authorized_keys:ro" \
        -v sid-sandbox-cache:/home/$DEV_USER/.cache \
        "$IMAGE" >/dev/null
    echo "started $NAME"
fi

ssh_opts=(
    -i "$KEY" -p "$SSH_PORT"
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
)

for _ in $(seq 1 30); do
    ssh -n "${ssh_opts[@]}" -o ConnectTimeout=2 -o BatchMode=yes \
        "$DEV_USER@127.0.0.1" true 2>/dev/null && break
    sleep 1
done

exec ssh "${ssh_opts[@]}" -t "$DEV_USER@127.0.0.1" "cd /workspace && exec bash -l"
