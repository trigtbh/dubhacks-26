#!/bin/bash
# Container init (runs as root under tini via `docker run --init`).
# Needs --privileged --pid=host: fanotify and eBPF act on the shared kernel, and
# the eBPF thread ids must match the ones fanotify reports (host pid namespace).
set -euo pipefail

home="/home/${DEV_USER}"

# Copy (not bind-mount) the key in, so sid can rewrite or strip
# authorized_keys without touching the host's file.
if [[ -f /run/sandbox/authorized_keys ]]; then
    install -m 600 -o "${DEV_USER}" -g "${DEV_USER}" \
        /run/sandbox/authorized_keys "${home}/.ssh/authorized_keys"
fi

# Named volumes are created root-owned on first use.
chown "${DEV_USER}:${DEV_USER}" "${home}/.cache"

ssh-keygen -A >/dev/null
mkdir -p /run/sshd /var/log/sid
cron

# libbpf attaches tracepoints through tracefs, which containers don't get by default.
mountpoint -q /sys/kernel/tracing || mount -t tracefs nodev /sys/kernel/tracing 2>/dev/null || true

# Build and start sid from the mounted source. The build is container-local, and
# uses the real bpftool (the /usr/sbin one wants tools matching the host kernel).
if [[ -f /workspace/Makefile ]]; then
    bpftool_bin="$(ls /usr/lib/linux-tools/*/bpftool 2>/dev/null | head -n1 || true)"
    echo "sid: building"
    make -s -C /workspace BUILD=/var/lib/sid/build BPFTOOL="${bpftool_bin:-bpftool}" install
    (
        # Come back if it dies: the sandbox is unguarded until it does.
        while true; do
            /usr/local/bin/sid-daemon >>/var/log/sid/daemon.log 2>&1 || true
            sleep 1
        done
    ) &
    for _ in $(seq 1 100); do
        grep -q "capture ACTIVE" /var/log/sid/daemon.log 2>/dev/null && break
        sleep 0.2
    done
    grep "capture ACTIVE\|fatal\|libbpf" /var/log/sid/daemon.log | tail -n3 || true
fi

exec /usr/sbin/sshd -D -e
