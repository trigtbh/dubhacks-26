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

# Build sid from a copy of the mounted source: it strips CRLF line endings (a
# Windows checkout breaks make) and keeps the build off the slow bind mount.
# Uses the real bpftool (the /usr/sbin one wants tools matching the host kernel).
build_sid() {
    local src=/var/lib/sid/src bpftool_bin
    rm -rf "$src" && mkdir -p "$src" || return 1
    cp -r /workspace/Makefile /workspace/src "$src"/ || return 1
    find "$src" -type f -exec sed -i 's/\r$//' {} + || return 1
    bpftool_bin="$(ls /usr/lib/linux-tools/*/bpftool 2>/dev/null | head -n1 || true)"
    make -s -C "$src" BUILD=/var/lib/sid/build BPFTOOL="${bpftool_bin:-bpftool}" install || return 1
}

if [[ -f /workspace/Makefile ]]; then
    echo "sid: building"
    # Never let a failed build stop sshd: the shell is how you find out why.
    if build_sid >/var/log/sid/build.log 2>&1; then
        (
            # Come back if it dies: the sandbox is unguarded until it does.
            while true; do
                rc=0
                /usr/local/bin/sid-daemon >>/var/log/sid/daemon.log 2>&1 || rc=$?
                if [[ $rc -eq 2 ]]; then  # cannot work on this kernel; do not spin
                    echo "echo 'sid: the capture is NOT running; see /var/log/sid/daemon.log'" > /etc/profile.d/sid-warn.sh
                    break
                fi
                sleep 1
            done
        ) &
        for _ in $(seq 1 100); do
            grep -q "capture ACTIVE\|fatal" /var/log/sid/daemon.log 2>/dev/null && break
            sleep 0.2
        done
        grep "capture ACTIVE\|fatal\|libbpf" /var/log/sid/daemon.log | tail -n3 || true
    else
        tail -n 20 /var/log/sid/build.log
        echo "sid: BUILD FAILED, the capture is NOT running (see /var/log/sid/build.log)"
        echo "echo 'sid: the capture is NOT running; see /var/log/sid/build.log'" > /etc/profile.d/sid-warn.sh
    fi
fi

exec /usr/sbin/sshd -D -e
