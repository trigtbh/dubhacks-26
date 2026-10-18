#!/bin/bash
# Container init (runs as root under tini via `docker run --init`).
# sid-session traces each SSH shell's descendants. It does not depend on Docker's
# Linux kernel enabling fanotify permission events or on host PID visibility.
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
# sid-web records each dashboard decision here and requires the file to exist;
# create it (without clobbering a prior run's log) so /decide never 503s.
touch /var/log/sid/decisions.jsonl
cron

# Build sid from a copy of the mounted source: it strips CRLF line endings (a
# Windows checkout breaks make) and keeps the build off the slow bind mount.
build_sid() {
    local src=/var/lib/sid/src
    rm -rf "$src" && mkdir -p "$src" || return 1
    cp -r /workspace/Makefile /workspace/src /workspace/runtime "$src"/ || return 1
    mkdir -p "$src/dataset" || return 1
    cp /workspace/dataset/render.py "$src/dataset/" || return 1
    find "$src" -type f -exec sed -i 's/\r$//' {} + || return 1
    make -s -C "$src" BUILD=/var/lib/sid/build PREFIX=/usr/local install-session || return 1
}

# Build and serve the dashboard from a copy so node_modules and dist never
# touch the mounted source. Start it before capture so the page stays available
# when daemon startup fails.
build_web() {
    local w=/var/lib/sid/web
    rm -rf "$w" && cp -r /workspace/frontend "$w" || return 1
    find "$w" -type f -exec sed -i 's/\r$//' {} + 2>/dev/null || true
    ln -snf /opt/webdeps/node_modules "$w/node_modules"
    (cd "$w" && node build.mjs) || return 1
    gcc -O2 -std=gnu11 -o /usr/local/bin/sid-web "$w/server/sid-web.c" || return 1
}

if [[ -d /workspace/frontend ]]; then
    if build_web >/var/log/sid/web-build.log 2>&1; then
        # Supervise the dashboard: if it ever exits, bring it straight back, so the
        # page stays reachable for the whole life of the container. Independent of
        # the capture, so the dashboard is up even if the daemon is still starting
        # or failed. SID_WEB_PORT falls back to 8080 inside; the published port is
        # whatever sandbox.sh mapped on the host.
        (
            while true; do
                SID_WEB_ADDR=0.0.0.0 SID_WEB_PORT="${SID_WEB_PORT:-8080}" SID_WEB_ROOT=/var/lib/sid/web/dist \
                    /usr/local/bin/sid-web >>/var/log/sid/web.log 2>&1 || true
                echo "sid: dashboard server exited; restarting in 1s" >>/var/log/sid/web.log
                sleep 1
            done
        ) &
        for _ in $(seq 1 50); do
            grep -q '^sid-web: http://' /var/log/sid/web.log 2>/dev/null && { echo "sid: dashboard on :8080"; break; }
            sleep 0.1
        done
        grep -q '^sid-web: http://' /var/log/sid/web.log 2>/dev/null ||
            { echo "sid: dashboard starting (it will keep retrying)"; tail -n 20 /var/log/sid/web.log >&2 || true; }
    else
        tail -n 10 /var/log/sid/web-build.log
        echo "sid: dashboard build failed (see /var/log/sid/web-build.log); capture is unaffected"
    fi
fi

if [[ -f /workspace/Makefile ]]; then
    echo "sid: building"
    # A failed build cannot provide the session helper; keep the dashboard up and report it.
    if build_sid >/var/log/sid/build.log 2>&1; then
        (
            # Come back if it dies: the sandbox is unguarded until it does.
            while true; do
                if [[ -f /run/sid/startup-failed ]]; then
                    break
                fi
                rc=0
                SID_CAPTURE_BACKEND=seccomp /usr/local/bin/sid-daemon >>/var/log/sid/daemon.log 2>&1 || rc=$?
                if [[ $rc -eq 2 ]]; then  # backend setup failure is not fixed by restarting
                    echo "echo 'sid: the capture is NOT running; see /var/log/sid/daemon.log'" > /etc/profile.d/sid-warn.sh
                    break
                fi
                sleep 1
            done
        ) &
        daemon_supervisor=$!
        ready=0
        # Model loading can take up to SID_MODEL_START_TIMEOUT_MS (120s by default).
        # Do not start sshd until the session socket exists; sid-session must register
        # its seccomp listener before it can safely run the login shell.
        for _ in $(seq 1 750); do
            if [[ -S /run/sid/session.sock ]]; then
                ready=1
                break
            fi
            if grep -q "sid-daemon: fatal:" /var/log/sid/daemon.log 2>/dev/null; then
                break
            fi
            if ! kill -0 "$daemon_supervisor" 2>/dev/null; then
                break
            fi
            sleep 0.2
        done
        if [[ $ready -ne 1 ]]; then
            echo "sid: capture did not become ready; daemon log follows" >&2
            tail -n 50 /var/log/sid/daemon.log >&2 || true
            mkdir -p /run/sid
            : > /run/sid/startup-failed
            if [[ -n "${dashboard_pid:-}" ]] && kill -0 "$dashboard_pid" 2>/dev/null; then
                echo "sid: dashboard remains available; SSH is disabled because capture did not start"
                wait "$dashboard_pid" || true
            fi
            exit 1
        fi
        grep "capture ACTIVE" /var/log/sid/daemon.log | tail -n1 || true
    else
        tail -n 20 /var/log/sid/build.log
        echo "sid: BUILD FAILED, the capture is NOT running (see /var/log/sid/build.log)"
        echo "echo 'sid: the capture is NOT running; see /var/log/sid/build.log'" > /etc/profile.d/sid-warn.sh
        mkdir -p /run/sid
        : > /run/sid/startup-failed
        if [[ -n "${dashboard_pid:-}" ]] && kill -0 "$dashboard_pid" 2>/dev/null; then
            echo "sid: dashboard remains available; SSH is disabled because capture did not start"
            wait "$dashboard_pid" || true
        fi
        exit 1
    fi
fi

exec /usr/sbin/sshd -D -e
