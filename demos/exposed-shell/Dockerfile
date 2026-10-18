FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ make libc6-dev libbpf-dev libelf-dev zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /sid
COPY Makefile ./
COPY src ./src
COPY runtime/laya_worker.py ./runtime/laya_worker.py
COPY dataset/render.py ./dataset/render.py
RUN make build/sid-daemon build/sid-explore build/sid-session \
  && mkdir -p /out/bin /out/lib/sid/runtime /out/lib/sid/dataset \
  && install -m 755 build/sid-daemon /out/bin/sid-daemon \
  && install -m 755 build/sid-explore /out/bin/sid-explore \
  && install -o root -g root -m 4755 build/sid-session /out/bin/sid-session \
  && install -m 644 runtime/laya_worker.py /out/lib/sid/runtime/laya_worker.py \
  && install -m 644 dataset/render.py /out/lib/sid/dataset/render.py

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils curl file findutils less passwd procps python3 python3-venv sudo tar util-linux wget \
    libbpf1 libelf1 zlib1g libstdc++6 libgcc-s1 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /bin/bash guest

COPY --from=build /out/bin /usr/local/bin
COPY --from=build /out/lib/sid /usr/local/lib/sid
COPY demos/exposed-shell/server.mjs /app/server.mjs
COPY demos/exposed-shell/index.html /app/index.html
COPY demos/exposed-shell/app.css /app/app.css
COPY demos/exposed-shell/app.js /app/app.js
COPY demos/exposed-shell/assets /app/assets
COPY demos/exposed-shell/project /opt/seed-workspace
COPY demos/exposed-shell/entrypoint.sh /usr/local/sbin/demo-entrypoint

RUN chmod 755 /usr/local/sbin/demo-entrypoint \
  && chmod 4755 /usr/local/bin/sid-session \
  && install -d -m 0755 /var/lib/sid/explore \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip wheel \
  && /opt/venv/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
  && /opt/venv/bin/pip install --no-cache-dir laya==0.4.11 \
  && chmod -R a-w /app /opt/seed-workspace

ENV PATH=/opt/venv/bin:$PATH \
    SID_MODEL_PYTHON=/opt/venv/bin/python \
    SID_MODEL_WORKER=/usr/local/lib/sid/runtime/laya_worker.py \
    SID_LAYA_DEVICE=cpu \
    SID_LAYA_CHECKPOINT=/opt/sid-checkpoint \
    SID_EVENT_LOG=/var/log/sid/events.jsonl \
    SID_DECISION_LOG=/var/log/sid/decisions.jsonl \
    SID_SESSION_SOCKET=/run/sid/session.sock \
    SID_REVIEW_SOCK=/run/sid/review.sock \
    SID_CAPTURE_BACKEND=seccomp \
    SID_DECIDE_TIMEOUT=15 \
    SID_MODEL_TIMEOUT_MS=10000 \
    SID_REVIEW_TIMEOUT=30 \
    SID_EXPLORE_BIN=/usr/local/bin/sid-explore \
    SID_EXPLORE_TIMEOUT=2

ENV HOME=/home/guest
WORKDIR /workspace
EXPOSE 4173
ENTRYPOINT ["/usr/local/sbin/demo-entrypoint"]
