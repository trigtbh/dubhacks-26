#!/bin/bash
set -euo pipefail

checkpoint=/opt/sid-checkpoint/model.safetensors
if [[ ! -s "$checkpoint" ]]; then
  echo "sid: missing checkpoint at /opt/sid-checkpoint; set SID_LAYA_CHECKPOINT to a local checkpoint directory" >&2
  exit 1
fi
if python3 -c 'import sys; sys.exit(not open("/opt/sid-checkpoint/model.safetensors", "rb").read(80).startswith(b"version https://git-lfs.github.com/spec/v1"))'; then
  echo "sid: checkpoint is a Git LFS pointer; fetch its model.safetensors before starting" >&2
  exit 1
fi

mkdir -p /run/sid /var/log/sid /var/lib/sid/explore /workspace
: > /var/log/sid/events.jsonl
: > /var/log/sid/decisions.jsonl
cp -a /opt/seed-workspace/. /workspace/
chmod -R a+rwX /workspace
chmod 1777 /workspace

export HF_HOME=/tmp/huggingface XDG_CACHE_HOME=/tmp/cache TORCH_HOME=/tmp/torch
/usr/local/bin/sid-daemon &
daemon_pid=$!
trap 'kill -TERM "$daemon_pid" 2>/dev/null || true' TERM INT

ready=0
for _ in {1..900}; do
  if [[ -S /run/sid/session.sock ]]; then ready=1; break; fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then break; fi
  sleep 0.2
done
if [[ $ready != 1 ]]; then
  echo 'sid: daemon did not become ready; shell startup cancelled' >&2
  exit 1
fi

setpriv --bounding-set=-sys_ptrace,-kill,-setpcap,-setuid,-setgid --reuid=10001 --regid=10001 --init-groups node /app/server.mjs &
app_pid=$!
if wait -n "$daemon_pid" "$app_pid"; then status=0; else status=$?; fi
echo "sid: a supervised process exited ($status); stopping the demo" >&2
kill -TERM "$app_pid" "$daemon_pid" 2>/dev/null || true
wait "$app_pid" 2>/dev/null || true
wait "$daemon_pid" 2>/dev/null || true
exit 1
