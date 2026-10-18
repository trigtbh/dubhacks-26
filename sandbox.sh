#!/usr/bin/env bash
# Build and start the sid sandbox container (Ubuntu 24.04 on the Docker host's
# architecture, with the sid capture running inside), then ssh into it.
#
#   ./sandbox.sh            start (or reuse) the container and open a shell
#   ./sandbox.sh --build    rebuild the image and recreate the container
#   ./sandbox.sh --stop     stop and remove the container
#   ./sandbox.sh --logs     follow sid's capture log (THIS IS BEING RUN IN THE CAPTURE)
#
# Docker-only. Images and containers use the Docker host's native x86_64 or
# arm64 architecture. SSH session commands are gated by seccomp notifications.
#
# Env overrides: SSH_PORT (2222), DASHBOARD_PORT (8080; both fall back to free ports if taken), SANDBOX_MEMORY (8g), SANDBOX_CPUS (4).
# SID_LAYA_CHECKPOINT selects a local checkpoint to mount read-only for inference
# (default: the latest demo fine-tune, .data/runs/laya-demo-test-01/checkpoint).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="sid-sandbox:latest"
NAME="sid-sandbox"
PLATFORM=""
DEV_USER="dev"
SSH_PORT="${SSH_PORT:-2222}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8080}"
STATE="$ROOT/.sandbox"
KEY="$STATE/id_ed25519"

fail() { echo "sid: $*" >&2; exit 1; }

# Git Bash/MSYS rewrites anything that looks like a unix path in arguments
# (/workspace, /run/...) and hands docker Windows-style host paths.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

dk() { docker "$@"; }
SRC="$ROOT"
command -v cygpath >/dev/null 2>&1 && SRC="$(cygpath -m "$ROOT")"

if ! docker info >/dev/null 2>&1; then
    fail "Docker is not running; start Docker and try again"
else
    read -r host_os host_arch < <(docker info --format '{{.OSType}} {{.Architecture}}')
    case "$host_arch" in
        x86_64 | amd64) PLATFORM="linux/amd64" ;;
        aarch64 | arm64) PLATFORM="linux/arm64" ;;
        *) fail "the Docker host architecture $host_arch is not supported (use x86_64 or arm64 Linux)" ;;
    esac
    if [[ "$host_os" != linux ]]; then
        fail "Docker must target a Linux host; the current Docker host reports $host_os"
    fi
fi

# Use an NVIDIA GPU when the host has one, so Laya runs on CUDA (far faster than
# CPU). SANDBOX_GPU=1 forces it, =0 disables; unset auto-detects via nvidia-smi.
# The image is built with a CUDA torch and run with --gpus; both fall back to CPU.
use_gpu=0
case "${SANDBOX_GPU:-auto}" in
    1 | yes | true) use_gpu=1 ;;
    0 | no | false) use_gpu=0 ;;
    *) command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 && use_gpu=1 ;;
esac
gpu_flags=()
sid_device=cpu
if (( use_gpu )); then gpu_flags=(--gpus all); sid_device=auto; fi

rebuild=0
case "${1:-}" in
    --build) rebuild=1 ;;
    --stop) dk rm -f "$NAME" >/dev/null 2>&1 || true; echo "stopped $NAME"; exit 0 ;;
    --logs) dk exec "$NAME" tail -n 50 -F /var/log/sid/daemon.log; exit 0 ;;
    "") ;;
    *) sed -n '2,10p' "$0"; exit 1 ;;
esac

# The container builds and serves the dashboard itself (see sandbox/entrypoint.sh),
# so a host build is only an optional optimization. Attempt it when Node and make
# are both present, but never abort the sandbox when the host cannot build the page
# (e.g. Git Bash on Windows, which has no make).
if command -v node >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
    make -C "$ROOT/frontend" dist || echo "sid: host dashboard build failed; the container will build it" >&2
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
    # A CUDA torch when the host has a GPU (cu128 = CUDA 12.8; runs on CPU too).
    (( use_gpu )) && build_args+=(--build-arg "TORCH_INDEX=https://download.pytorch.org/whl/cu128")
    dk build --platform "$PLATFORM" ${build_args[@]+"${build_args[@]}"} -t "$IMAGE" "$SRC/sandbox"
fi

(( rebuild )) && dk rm -f "$NAME" >/dev/null 2>&1 || true

# The checkpoint is resolved once so a running container with another mount is recreated.
checkpoint="${SID_LAYA_CHECKPOINT:-$ROOT/.data/runs/laya-demo-test-01/checkpoint}"
model_mount=()
if [[ -d "$checkpoint" ]]; then
    lfs_path="${checkpoint#"$ROOT"/}/model.safetensors"
    # The repository's .data is often a symlink outside the workspace mount.
    checkpoint="$(cd "$checkpoint" && pwd -P)"
    if [[ -f "$checkpoint/model.safetensors" ]] &&
        head -c 100 "$checkpoint/model.safetensors" | grep -aFxq 'version https://git-lfs.github.com/spec/v1'; then
        echo "sid: checkpoint weights are a Git LFS pointer; the dashboard will still start, but capture needs 'git lfs pull --include=$lfs_path'" >&2
    fi
    command -v cygpath >/dev/null 2>&1 && checkpoint="$(cygpath -m "$checkpoint")"
    model_mount=(-v "$checkpoint:/opt/sid-checkpoint:ro" -e SID_LAYA_CHECKPOINT=/opt/sid-checkpoint)
    echo "sid: model checkpoint $checkpoint" >&2
else
    echo "sid: no checkpoint at $checkpoint; model startup will fail until one is supplied" >&2
fi

run_container() {  # $1, $2: host side of the ssh and dashboard port mappings
    # --privileged keeps the development sandbox's nested system tooling usable.
    # sid-session traces only commands launched by SSH sessions in this container.
    dk run -d \
        --name "$NAME" --hostname sid \
        --platform "$PLATFORM" \
        --init --privileged \
        ${gpu_flags[@]+"${gpu_flags[@]}"} \
        --memory "${SANDBOX_MEMORY:-8g}" --cpus "${SANDBOX_CPUS:-4}" --pids-limit 4096 \
        -e SID_MODEL_PYTHON=/opt/venv/bin/python -e SID_LAYA_DEVICE="$sid_device" \
        "${model_mount[@]}" \
        -p "$1:22" \
        -p "$2:8080" \
        --tmpfs /var/lib/sid/explore:rw,exec,suid,dev,size=2g,mode=0700 \
        -v "$SRC:/workspace" \
        -v "$SRC/.sandbox/authorized_keys:/run/sandbox/authorized_keys:ro" \
        -v sid-sandbox-cache:/home/$DEV_USER/.cache \
        "$IMAGE" 2>&1
}

# Docker Desktop on Windows reports mount sources in its own form, so only compare elsewhere.
if ((${#model_mount[@]})) && ! command -v cygpath >/dev/null 2>&1 &&
    mounted="$(dk inspect -f '{{range .Mounts}}{{if eq .Destination "/opt/sid-checkpoint"}}{{.Source}}{{end}}{{end}}' "$NAME" 2>/dev/null)" &&
    [[ "$mounted" != "$checkpoint" ]]; then
    echo "sid: recreating $NAME to mount ${checkpoint} (was ${mounted:-none})" >&2
    dk rm -f "$NAME" >/dev/null 2>&1 || true
fi

if [[ "$(dk inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]]; then
    dk rm -f "$NAME" >/dev/null 2>&1 || true
    if ! err="$(run_container "127.0.0.1:${SSH_PORT}" "127.0.0.1:${DASHBOARD_PORT}")"; then
        if grep -qiE "ports are not available|port is already allocated|address already in use|forbidden by its access" <<<"$err"; then
            # Windows reserves port ranges (Hyper-V/WSL), and other programs hold ports too.
            echo "ports ${SSH_PORT}/${DASHBOARD_PORT} are unavailable here; letting Docker pick free ones" >&2
            dk rm -f "$NAME" >/dev/null 2>&1 || true
            err="$(run_container "127.0.0.1:" "127.0.0.1:")" || { echo "$err" >&2; exit 1; }
        elif ((${#gpu_flags[@]})) && grep -qiE "nvidia|gpu|could not select device driver|cdi|capabilities" <<<"$err"; then
            # Host has a GPU but Docker cannot pass it through (no container toolkit).
            echo "sid: GPU passthrough unavailable here; starting on CPU (set SANDBOX_GPU=0 to skip this)" >&2
            gpu_flags=() sid_device=cpu
            dk rm -f "$NAME" >/dev/null 2>&1 || true
            err="$(run_container "127.0.0.1:${SSH_PORT}" "127.0.0.1:${DASHBOARD_PORT}")" || { echo "$err" >&2; exit 1; }
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
    echo "sid: try ./sandbox.sh --build to rebuild the image and recreate the sandbox" >&2
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
    echo "sid: run ./sandbox.sh --build to rebuild the image and recreate the sandbox" >&2
    exit 1
fi
echo "ssh: 127.0.0.1:${SSH_PORT}"

# The dashboard starts before capture/model initialization and is available while
# the sandbox finishes building sid on first start.
dashboard_ready=0
for _ in $(seq 1 30); do
    running || dead
    if dk exec "$NAME" curl -fsS -o /dev/null http://127.0.0.1:8080/ 2>/dev/null; then
        dashboard_ready=1
        break
    fi
    sleep 0.2
done
if (( dashboard_ready )); then
    echo "dashboard: http://127.0.0.1:${DASH_PORT:-?}"
else
    echo "dashboard: unavailable"
    if [[ ! -f "$ROOT/frontend/dist/index.html" ]]; then
        echo "sid: build the page on the host with 'make -C frontend dist' (Node and dependencies required)"
    else
        dk exec "$NAME" sh -c 'tail -n 30 /var/log/sid/web.log 2>/dev/null || true' >&2 || true
    fi
fi

ssh_opts=(
    -i "$KEY" -p "$SSH_PORT"
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
)

# The first start builds sid before sshd comes up, so allow time.
echo "waiting for the sandbox (building sid on first start)..."
ssh_ready=0
for _ in $(seq 1 180); do
    running || dead
    if ssh -n "${ssh_opts[@]}" -o ConnectTimeout=2 -o BatchMode=yes \
        "$DEV_USER@127.0.0.1" true 2>/dev/null; then
        ssh_ready=1
        break
    fi
    if dk exec "$NAME" test -f /run/sid/startup-failed 2>/dev/null; then
        echo "sid: capture startup failed; dashboard remains available at http://127.0.0.1:${DASH_PORT:-?}" >&2
        echo "sid: inspect logs with 'docker logs sid-sandbox' and 'docker exec sid-sandbox tail -n 50 /var/log/sid/daemon.log'" >&2
        exit 1
    fi
    sleep 1
done
if (( ! ssh_ready )); then
    if (( dashboard_ready )); then
        echo "sid: dashboard is running, but SSH did not become ready; inspect 'docker logs sid-sandbox'" >&2
    else
        echo "sid: SSH did not become ready; inspect 'docker logs sid-sandbox'" >&2
    fi
    exit 1
fi

exec ssh "${ssh_opts[@]}" -t "$DEV_USER@127.0.0.1"
