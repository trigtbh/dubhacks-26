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
# Where it runs is decided by the Docker host, not by the shell you ran this from
# (Git Bash on Windows reports itself as MINGW, but its Docker host is still Linux):
#   Docker host is x86_64 Linux, kernel has fanotify permission events
#                        a Docker container (Linux, WSL2, Docker Desktop on Windows)
#   anything else        no container: the x86_64 Linux VM from vm/sid.yaml is the
#                        sandbox (see vm.sh; needs Lima, macOS/Linux only). That
#                        covers Apple Silicon, ARM Linux, no Docker running, and
#                        Docker hosts whose kernel can't pause execs (Docker
#                        Desktop on Mac). The capture needs a real x86 Linux
#                        kernel; emulated x86 cannot do it.
#   SID_FORCE_VM=1 forces the VM path.
#
# Env overrides: SSH_PORT (2222), DASHBOARD_PORT (8080; both fall back to free ports if taken), SANDBOX_MEMORY (8g), SANDBOX_CPUS (4).
# SID_LAYA_CHECKPOINT selects a local checkpoint to mount read-only for inference.
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

go_vm() {  # $1: why
    if ! command -v limactl >/dev/null; then
        echo "sid: $1" >&2
        echo "sid: the container path needs Docker running on an x86_64 Linux kernel with fanotify" >&2
        echo "     permission events; the VM path needs Lima (brew install lima lima-additional-guestagents qemu)." >&2
        exit 1
    fi
    echo "sid: $1; using the VM instead of Docker" >&2
    # --rebuild/--reset have no meaning without a container: vm.sh reinstalls every run.
    case "${2:-}" in
        --rebuild | --reset) exec "$ROOT/vm.sh" ;;
        *) exec "$ROOT/vm.sh" "${@:2}" ;;
    esac
}

# Git Bash/MSYS rewrites anything that looks like a unix path in arguments
# (/workspace, /run/...) and hands docker Windows-style host paths.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

dk() { docker "$@"; }
SRC="$ROOT"
command -v cygpath >/dev/null 2>&1 && SRC="$(cygpath -m "$ROOT")"

if [[ "${SID_FORCE_VM:-0}" == 1 ]]; then
    go_vm "SID_FORCE_VM is set" "$@"
elif ! docker info >/dev/null 2>&1; then
    go_vm "docker is not running" "$@"
elif [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]]; then
    # (a running sandbox container already passed these checks)
    read -r host_os host_arch < <(docker info --format '{{.OSType}} {{.Architecture}}')
    if [[ "$host_os" != linux || "$host_arch" != x86_64 ]]; then
        go_vm "the Docker host is $host_os/$host_arch, not x86_64 Linux" "$@"
    fi
    # Containers share the Docker host's kernel, so ask that kernel what it supports.
    kcfg="$(docker run --rm alpine sh -c 'zcat /proc/config.gz 2>/dev/null' 2>/dev/null || true)"
    if [[ -n "$kcfg" ]] && ! grep -q '^CONFIG_FANOTIFY_ACCESS_PERMISSIONS=y' <<<"$kcfg"; then
        go_vm "this Docker host's kernel has no fanotify permission events" "$@"
    fi
    [[ -n "$kcfg" ]] || echo "warning: cannot read the Docker host's kernel config; sid may not start" >&2
fi

rebuild=0 reset=0
case "${1:-}" in
    --rebuild) rebuild=1 reset=1 ;;
    --reset) reset=1 ;;
    --stop) dk rm -f "$NAME" >/dev/null 2>&1 || true; echo "stopped $NAME"; exit 0 ;;
    --logs) dk exec "$NAME" tail -n 50 -F /var/log/sid/daemon.log; exit 0 ;;
    "") ;;
    *) sed -n '2,10p' "$0"; exit 1 ;;
esac

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

run_container() {  # $1, $2: host side of the ssh and dashboard port mappings
    local checkpoint="${SID_LAYA_CHECKPOINT:-$ROOT/.data/pilot-v2/finetune-04/checkpoint}"
    local model_mount=()
    if [[ -d "$checkpoint" ]]; then
        # The repository's .data is often a symlink outside the workspace mount.
        checkpoint="$(cd "$checkpoint" && pwd -P)"
        command -v cygpath >/dev/null 2>&1 && checkpoint="$(cygpath -m "$checkpoint")"
        model_mount=(-v "$checkpoint:/opt/sid-checkpoint:ro" -e SID_LAYA_CHECKPOINT=/opt/sid-checkpoint)
    else
        echo "sid: no checkpoint at $checkpoint; model startup will fail until one is supplied" >&2
    fi
    # --privileged --pid=host: sid's fanotify and eBPF act on the shared kernel, and
    # eBPF reports host-namespace thread ids, which must match fanotify's.
    dk run -d \
        --name "$NAME" --hostname sid \
        --platform "$PLATFORM" \
        --init --privileged --pid=host \
        --memory "${SANDBOX_MEMORY:-8g}" --cpus "${SANDBOX_CPUS:-4}" --pids-limit 4096 \
        -e SID_MODEL_PYTHON=/opt/venv/bin/python -e SID_LAYA_DEVICE=cpu \
        "${model_mount[@]}" \
        -p "$1:22" \
        -p "$2:8080" \
        --tmpfs /var/lib/sid/explore:rw,exec,suid,dev,size=2g,mode=0700 \
        -v "$SRC:/workspace" \
        -v "$SRC/.sandbox/authorized_keys:/run/sandbox/authorized_keys:ro" \
        -v sid-sandbox-cache:/home/$DEV_USER/.cache \
        "$IMAGE" 2>&1
}

if [[ "$(dk inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]]; then
    dk rm -f "$NAME" >/dev/null 2>&1 || true
    if ! err="$(run_container "127.0.0.1:${SSH_PORT}" "127.0.0.1:${DASHBOARD_PORT}")"; then
        if grep -qiE "ports are not available|port is already allocated|address already in use|forbidden by its access" <<<"$err"; then
            # Windows reserves port ranges (Hyper-V/WSL), and other programs hold ports too.
            echo "ports ${SSH_PORT}/${DASHBOARD_PORT} are unavailable here; letting Docker pick free ones" >&2
            dk rm -f "$NAME" >/dev/null 2>&1 || true
            err="$(run_container "127.0.0.1:" "127.0.0.1:")" || { echo "$err" >&2; exit 1; }
        else
            echo "$err" >&2
            exit 1
        fi
    fi
    echo "started $NAME"
fi

dead() {
    echo "sid: the sandbox container is not running. Its output:" >&2
    dk logs --tail 40 "$NAME" >&2 || true
    echo "sid: (try ./sandbox.sh --reset; if the build is the problem, --rebuild)" >&2
    exit 1
}
running() { [[ "$(dk inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" == true ]]; }

# Give a crashing entrypoint a moment to show itself before trusting the container.
for _ in 1 2 3 4 5 6; do running || break; sleep 0.5; done
running || dead

# Read the ports back: they may not be the ones we asked for.
SSH_PORT="$(dk port "$NAME" 22/tcp 2>/dev/null | head -n1 | sed 's/.*://' || true)"
DASH_PORT="$(dk port "$NAME" 8080/tcp 2>/dev/null | head -n1 | sed 's/.*://' || true)"
if [[ -z "$SSH_PORT" ]]; then
    echo "sid: the container has no published ssh port (created by an older version of this script?)" >&2
    echo "sid: run ./sandbox.sh --reset" >&2
    exit 1
fi
echo "ssh: 127.0.0.1:${SSH_PORT}   dashboard: http://127.0.0.1:${DASH_PORT:-?}"

ssh_opts=(
    -i "$KEY" -p "$SSH_PORT"
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
)

# The first start builds sid before sshd comes up, so allow time.
echo "waiting for the sandbox (building sid on first start)..."
for _ in $(seq 1 180); do
    running || dead
    ssh -n "${ssh_opts[@]}" -o ConnectTimeout=2 -o BatchMode=yes \
        "$DEV_USER@127.0.0.1" true 2>/dev/null && break
    sleep 1
done

exec ssh "${ssh_opts[@]}" -t "$DEV_USER@127.0.0.1" "cd /workspace && exec bash -l"
