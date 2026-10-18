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

mkdir -p /run/sid /run/sshd /var/log/sid /var/lib/sid/explore /workspace
: > /var/log/sid/events.jsonl
: > /var/log/sid/decisions.jsonl
chmod 1777 /workspace
ssh-keygen -q -t ed25519 -N '' -f /run/sid/ssh_host_ed25519_key
setpriv --reuid=10001 --regid=10001 --init-groups mkdir -p /home/guest/.ssh
setpriv --reuid=10001 --regid=10001 --init-groups ssh-keygen -q -t ed25519 -N '' -f /home/guest/.ssh/tthm_client_key
install -m 0644 /home/guest/.ssh/tthm_client_key.pub /run/sid/tthm_authorized_keys

export HF_HOME=/tmp/huggingface XDG_CACHE_HOME=/tmp/cache TORCH_HOME=/tmp/torch
SID_WEB_ADDR=127.0.0.1 SID_WEB_PORT=4175 SID_WEB_ROOT=/opt/sid/dashboard /usr/local/bin/sid-web &
web_pid=$!
/usr/local/bin/sid-daemon &
daemon_pid=$!
sshd_pid=
app_pid=
trap 'for pid in "${app_pid:-}" "${sshd_pid:-}" "$daemon_pid" "$web_pid"; do [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true; done' TERM INT

ready=0
for _ in {1..900}; do
  if [[ -S /run/sid/session.sock ]]; then ready=1; break; fi
  if ! kill -0 "$daemon_pid" 2>/dev/null || ! kill -0 "$web_pid" 2>/dev/null; then break; fi
  sleep 0.2
done
if [[ $ready != 1 ]]; then
  echo 'sid: daemon did not become ready; shell startup cancelled' >&2
  exit 1
fi

sshd_options=(
  -f /dev/null
  -h /run/sid/ssh_host_ed25519_key
  -o Port=2222
  -o ListenAddress=127.0.0.1
  -o PidFile=/run/sid/sshd.pid
  -o AuthorizedKeysFile=/run/sid/tthm_authorized_keys
  -o ForceCommand=/usr/local/sbin/tthm-session
  -o AllowUsers=guest
  -o UsePAM=no
  -o PasswordAuthentication=no
  -o PubkeyAuthentication=yes
  -o AuthenticationMethods=publickey
  -o PermitRootLogin=no
  -o PermitTTY=yes
  -o StrictModes=no
  -o PermitUserRC=no
  -o AllowAgentForwarding=no
  -o AllowTcpForwarding=no
  -o X11Forwarding=no
  -o LogLevel=ERROR
)
/usr/sbin/sshd -t "${sshd_options[@]}"
/usr/sbin/sshd -D -e "${sshd_options[@]}" &
sshd_pid=$!
ssh_ready=0
for _ in {1..50}; do
  if ! kill -0 "$sshd_pid" 2>/dev/null; then break; fi
  if /usr/bin/ssh-keyscan -T 1 -p 2222 127.0.0.1 >/dev/null 2>&1; then ssh_ready=1; break; fi
  sleep 0.1
done
if [[ $ssh_ready != 1 ]]; then
  echo 'sid: local SSH server did not become ready; shell startup cancelled' >&2
  kill -TERM "$sshd_pid" 2>/dev/null || true
  exit 1
fi

setpriv --bounding-set=-sys_ptrace,-kill,-setpcap,-setuid,-setgid --reuid=10001 --regid=10001 --init-groups node /app/server.mjs &
app_pid=$!
if wait -n "$daemon_pid" "$web_pid" "$sshd_pid" "$app_pid"; then status=0; else status=$?; fi
echo "sid: a supervised process exited ($status); stopping the demo" >&2
kill -TERM "$app_pid" "$sshd_pid" "$daemon_pid" "$web_pid" 2>/dev/null || true
wait "$app_pid" 2>/dev/null || true
wait "$sshd_pid" 2>/dev/null || true
wait "$daemon_pid" 2>/dev/null || true
wait "$web_pid" 2>/dev/null || true
exit 1
