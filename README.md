# Linux command review with Laya

This repository captures Linux exec events, reviews uncertain commands through isolated
simulation and human approval, and prepares data for a local Allow/Hold/Block classifier.
The daemon calls the model interface in `src/jev.hpp`; `src/jev_laya.cpp` starts a
persistent Laya child before capture and sends Event JSON to it over a private socket.
The child uses the same renderer and verdict question as training and evaluation.

- [Data generation, annotation, training and evaluation](dataset/README.md)
- [Model input contract](dataset/MODEL_INPUT.md)
- [Model startup and configuration](runtime/README.md)
- [Proposed event-capture improvements](dataset/RUNTIME_BRIEF.md)
- [Dataset and experiment history](dataset/HISTORY.md)

## Installing SID on a Linux host (admins)

`./sandbox.sh` is the demo. A real install captures every exec host-wide with
fanotify + eBPF under systemd, so it needs a bare-metal or VM Linux host (x86_64
or arm64) with `CONFIG_FANOTIFY_ACCESS_PERMISSIONS=y` and kernel BTF — not Docker
Desktop. It runs as root.

```sh
# 1. build + model deps
sudo apt-get install -y build-essential clang llvm bpftool libbpf-dev libelf-dev \
    zlib1g-dev linux-tools-common linux-tools-generic python3-venv nodejs npm git-lfs
git lfs pull                                    # the bundled checkpoint
python3 -m venv /opt/sid-venv && /opt/sid-venv/bin/pip install laya torch
#   (torch: add --index-url https://download.pytorch.org/whl/cu128 for an NVIDIA GPU)

# 2. capture daemon  (builds, installs, starts sid.service)
sudo bash linux/install.sh "$PWD"

# 3. dashboard on 127.0.0.1:8080
make -C frontend install
sudo touch /var/log/sid/decisions.jsonl && sudo chown nobody /var/log/sid/decisions.jsonl
sudo install -m644 frontend/sid-web.service /etc/systemd/system/ && sudo systemctl enable --now sid-web
```

Point the daemon at the model in `/etc/sid/model.env` (read by `sid.service`), then
`sudo systemctl restart sid`:

```sh
SID_MODEL_PYTHON=/opt/sid-venv/bin/python
SID_MODEL_WORKER=/usr/local/lib/sid/runtime/laya_worker.py
SID_LAYA_CHECKPOINT=/opt/sid/checkpoint
SID_LAYA_DEVICE=auto          # cuda when present, else cpu
```

`journalctl -u sid -n 20 -o cat` should show `capture ACTIVE`. Notes: the daemon
needs the model to start; it **fails open** if it dies (hence `Restart=always`);
a denial severs the command's origin; put the dashboard behind an authenticating
proxy for remote operators.

## Repository layout

The approved dataset is `.data/pilot-v2/release/`; the selected checkpoint is
`.data/pilot-v2/finetune-04/checkpoint/`. Newer expansion files are proposals and remain
separate. `.data/`, `models/` and `.venv/` are ignored local symlinks.

Test the live model hook without capturing or executing the supplied command:

```sh
make build/sid-model-check
build/sid-model-check -- bash -c 'cat README.md'
```

The default checkpoint is the selected one above. Set `SID_LAYA_CHECKPOINT` to an
absolute directory to test a later fine-tune. The worker uses `.venv/bin/python` when
available and chooses CUDA when available; all settings are in [runtime/README.md](runtime/README.md).

Run the command-review, data integrity and model protocol tests together with:

```sh
make check
# Include the optional tokenizer regression test using the local environment:
make check PYTHON=.venv/bin/python
```

`make test` runs just the C++ command-review tests; overlay/whiteout cases need root
and skip otherwise. `make test-data` runs the Python data tests; `make test-model`
runs the model protocol tests with fake workers. Neither requires a GPU or checkpoint.

`make` builds the Linux daemon, simulation helper and eBPF program, requiring a C++17 compiler, clang,
bpftool, libbpf, libelf, zlib and kernel BTF. `sandbox.sh` runs the isolated Docker environment;
`linux/install.sh` installs the system-wide capture on a Linux host.
