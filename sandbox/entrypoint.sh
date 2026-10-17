#!/bin/bash
# Container init (runs as root under tini via `docker run --init`).
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
mkdir -p /run/sshd
cron

exec /usr/sbin/sshd -D -e
