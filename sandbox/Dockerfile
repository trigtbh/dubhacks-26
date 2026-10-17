# check=skip=FromPlatformFlagConstDisallowed
# sid dev sandbox: Ubuntu 24.04 on x86_64, matching the target VM.
# Built and run by ../sandbox.sh, which always passes --platform linux/amd64.
FROM --platform=linux/amd64 ubuntu:24.04

ARG DEV_USER=dev
ARG DEV_UID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    TZ=Etc/UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
                build-essential gcc g++ make pkg-config gdb \
        # sid-daemon (C++/eBPF): built at container start against the host kernel's BTF
        clang llvm libbpf-dev libelf-dev zlib1g-dev linux-tools-common linux-tools-generic \
        libseccomp-dev seccomp libcap-dev libcap2-bin linux-libc-dev \
        # daemon / explore (Python, overlayfs, netns, strace)
        python3 python3-dev python3-venv python3-pip \
        strace ltrace util-linux iproute2 nftables procps psmisc lsof file \
        # ssh origin path + persistence targets the demo attacks
        openssh-server openssh-client sudo cron \
        # general tooling
        ca-certificates curl wget git jq vim nano less tmux \
        netcat-openbsd socat iputils-ping dnsutils tcpdump \
    && rm -rf /var/lib/apt/lists/*

# Replace the stock "ubuntu" user so the dev user can own UID 1000.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -s /bin/bash -u "${DEV_UID}" -U "${DEV_USER}" \
    && echo "${DEV_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-dev \
    && chmod 0440 /etc/sudoers.d/90-dev \
    && install -d -m 700 -o "${DEV_USER}" -g "${DEV_USER}" /home/${DEV_USER}/.ssh \
    && install -d -o "${DEV_USER}" -g "${DEV_USER}" /home/${DEV_USER}/.cache

# Python venv for sid-explore / Laya.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip wheel \
    && chown -R "${DEV_USER}:${DEV_USER}" /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    HF_HOME=/home/${DEV_USER}/.cache/huggingface

# Scratch space for outcome exploration. sandbox.sh mounts a tmpfs here,
# since an overlayfs upperdir can't live on Docker's own overlay root.
RUN install -d -m 700 /var/lib/sid/explore

COPY sshd_config /etc/ssh/sshd_config.d/10-sandbox.conf
COPY entrypoint.sh /usr/local/sbin/entrypoint.sh
# A Windows checkout may have CRLF line endings; "bash\r: not found" would kill the container.
RUN sed -i 's/\r$//' /usr/local/sbin/entrypoint.sh /etc/ssh/sshd_config.d/10-sandbox.conf \
    && chmod 755 /usr/local/sbin/entrypoint.sh \
    && echo 'export PATH=/opt/venv/bin:$PATH' > /etc/profile.d/venv.sh \
    && echo "export HF_HOME=/home/${DEV_USER}/.cache/huggingface" >> /etc/profile.d/venv.sh

ENV DEV_USER=${DEV_USER}
WORKDIR /workspace
EXPOSE 22 8080
ENTRYPOINT ["/usr/local/sbin/entrypoint.sh"]
