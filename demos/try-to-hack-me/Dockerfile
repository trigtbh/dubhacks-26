FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ make python3 libc6-dev libbpf-dev libelf-dev zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /sid
COPY Makefile ./
COPY src ./src
COPY runtime/laya_worker.py ./runtime/laya_worker.py
COPY dataset/render.py ./dataset/render.py
COPY frontend/server/sid-web.c ./frontend/server/sid-web.c
COPY demos/try-to-hack-me/archive-report.c ./demos/try-to-hack-me/archive-report.c
RUN make build/sid-daemon build/sid-explore build/sid-session \
  && gcc -O2 -Wall -Wextra -o /tmp/archive-report demos/try-to-hack-me/archive-report.c \
  && mkdir -p /out/bin /out/lib/sid/runtime /out/lib/sid/dataset \
  && install -m 755 build/sid-daemon /out/bin/sid-daemon \
  && install -m 755 build/sid-explore /out/bin/sid-explore \
  && install -o root -g root -m 4755 build/sid-session /out/bin/sid-session \
  && install -m 644 runtime/laya_worker.py /out/lib/sid/runtime/laya_worker.py \
  && install -m 644 dataset/render.py /out/lib/sid/dataset/render.py \
  && gcc -O2 -std=gnu11 -o /out/bin/sid-web frontend/server/sid-web.c

RUN mkdir -p /opt/webdeps \
  && npm install --prefix /opt/webdeps --no-save --no-audit --no-fund \
    esbuild@0.24.0 @fontsource/syne@5.0.19 @fontsource/tasa-explorer@5.2.1 @fontsource/commit-mono@5.2.4 \
    @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0 node-pty@1.1.0 ws@8.18.0

COPY frontend/build.mjs ./frontend/build.mjs
COPY frontend/design ./frontend/design
COPY frontend/src ./frontend/src
RUN ln -s /opt/webdeps/node_modules frontend/node_modules \
  && node frontend/build.mjs

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils curl file findutils less openssh-client openssh-server passwd procps python3 python3-venv sudo tar util-linux wget \
    libbpf1 libelf1 zlib1g libstdc++6 libgcc-s1 \
  && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
  && useradd --create-home --uid 10001 --shell /bin/bash guest
RUN passwd -d guest

COPY --from=build /out/bin /usr/local/bin
COPY --from=build /out/lib/sid /usr/local/lib/sid
COPY --from=build /tmp/archive-report /usr/local/libexec/archive-report
COPY --from=build /sid/frontend/dist /opt/sid/dashboard
COPY --from=build /opt/webdeps/node_modules/ws /app/node_modules/ws
COPY --from=build /opt/webdeps/node_modules/node-pty /app/node_modules/node-pty
COPY --from=build /opt/webdeps/node_modules/@xterm/xterm/lib/xterm.js /app/assets/xterm.js
COPY --from=build /opt/webdeps/node_modules/@xterm/xterm/css/xterm.css /app/assets/xterm.css
COPY --from=build /opt/webdeps/node_modules/@xterm/addon-fit/lib/addon-fit.js /app/assets/addon-fit.js
COPY --from=build /sid/frontend/dist/fonts/CommitMono-400.woff2 /app/assets/CommitMono-400.woff2

RUN chmod 4755 /usr/local/bin/sid-session \
  && install -o root -g root -m 4755 /usr/local/libexec/archive-report /usr/local/bin/archive-report \
  && mkdir -p /root \
  && printf '%s\n' 'SID{path_search_is_not_a_boundary}' > /root/flag \
  && chmod 400 /root/flag \
  && install -d -m 0755 /var/lib/sid/explore \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip wheel \
  && /opt/venv/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
  && /opt/venv/bin/pip install --no-cache-dir laya==0.4.11

COPY demos/try-to-hack-me/server.mjs /app/server.mjs
COPY demos/try-to-hack-me/index.html /app/index.html
COPY demos/try-to-hack-me/app.css /app/app.css
COPY demos/try-to-hack-me/app.js /app/app.js
COPY demos/try-to-hack-me/assets /app/assets
COPY demos/try-to-hack-me/entrypoint.sh /usr/local/sbin/demo-entrypoint
COPY demos/try-to-hack-me/tthm-session /usr/local/sbin/tthm-session
RUN chmod 755 /usr/local/sbin/demo-entrypoint /usr/local/sbin/tthm-session \
  && chmod -R a-w /app /opt/sid/dashboard

ENV HOME=/home/guest \
    PATH=/opt/venv/bin:$PATH \
    SID_MODEL_PYTHON=/opt/venv/bin/python \
    SID_MODEL_WORKER=/usr/local/lib/sid/runtime/laya_worker.py \
    SID_LAYA_DEVICE=cpu \
    SID_LAYA_CHECKPOINT=/opt/sid-checkpoint \
    SID_EVENT_LOG=/var/log/sid/events.jsonl \
    SID_DECISION_LOG=/var/log/sid/decisions.jsonl \
    SID_SESSION_SOCKET=/run/sid/session.sock \
    SID_REVIEW_SOCK=/run/sid/review.sock \
    SID_CAPTURE_BACKEND=seccomp \
    SID_DECIDE_TIMEOUT=45 \
    SID_MODEL_TIMEOUT_MS=10000 \
    SID_REVIEW_TIMEOUT=60 \
    SID_EXPLORE_BIN=/usr/local/bin/sid-explore \
    SID_EXPLORE_TIMEOUT=2

WORKDIR /workspace
EXPOSE 4174
ENTRYPOINT ["/usr/local/sbin/demo-entrypoint"]
