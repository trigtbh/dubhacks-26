# Live Laya inference

`jev_init()` starts one `laya_worker.py` child, loads and warms the checkpoint, and waits
for readiness before fanotify marks are installed. `jev_classify()` sends Event JSON
over a private inherited socket; the worker calls `dataset/render.py` and
`agent.predict(state, {"verdict": VERDICT_QUESTION}, max_len=1024)`. Calls are serialized
with a bounded wait that includes queue time. Reviewed commands are never executed
by the model worker.

Allow and Block feed the existing immediate decision path. Hold enters simulation
and human review. Startup fails if the model cannot load. A worker crash or transport
timeout raises a decision exception, which the daemon blocks. The worker is stopped
and remains unavailable until daemon restart; it is never respawned during capture.
Model children bypass capture through the daemon's existing descendant check and
are killed when their parent dies. The old Allow stub has been removed.

Run from the repository root with the existing environment (Laya 0.4.11):

```sh
make build/sid-model-check
build/sid-model-check -- bash -c 'cat README.md'
# Change checkpoints without rebuilding:
SID_LAYA_CHECKPOINT=/absolute/path/to/checkpoint build/sid-model-check -- ls -l
```

The check binary prints the model verdict without installing capture or executing its
arguments. `make check PYTHON=.venv/bin/python` covers transport failures, concurrency,
rendering and the existing review flow using CPU-only fixtures.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SID_LAYA_CHECKPOINT` | `.data/pilot-v2/finetune-04/checkpoint` | Local checkpoint directory; no downloads |
| `SID_LAYA_DEVICE` | `auto` | `auto`, `cuda`, or `cpu` |
| `SID_MODEL_PYTHON` | `.venv/bin/python` if executable, otherwise `python3` | Python with Laya installed |
| `SID_MODEL_WORKER` | `runtime/laya_worker.py` if readable, otherwise `/usr/local/lib/sid/runtime/laya_worker.py` | Worker entry point |
| `SID_MODEL_START_TIMEOUT_MS` | `120000` | Model load and warmup deadline |
| `SID_MODEL_TIMEOUT_MS` | `1500` | Queue plus inference deadline per Event |

Timeout values must be integers in 1..3600000 milliseconds. The daemon also enforces
`SID_DECIDE_TIMEOUT` (2 seconds by default, including context gathering); keep the
model deadline below it. A slow CPU may need both deadlines increased. This changes
waiting time only, without changing class thresholds or the selected checkpoint.

`make install` installs the worker and shared renderer beside the native binaries.
The sandbox image installs CPU Laya dependencies and `sandbox.sh` mounts the selected
host checkpoint read-only at `/opt/sid-checkpoint`, including when `.data` is a symlink.
Rebuild an existing image after this change: `./sandbox.sh --rebuild`.

For the VM, provide Laya in the guest Python environment and copy/mount a checkpoint
into the guest. The systemd service runs from `/workspace` and reads optional
`/etc/sid/model.env`, for example:

```sh
SID_MODEL_PYTHON=/opt/venv/bin/python
SID_LAYA_CHECKPOINT=/var/lib/sid/checkpoint
SID_LAYA_DEVICE=cpu
SID_MODEL_TIMEOUT_MS=10000
SID_DECIDE_TIMEOUT=15
```

Checkpoints, model downloads and virtual environments remain ignored local artifacts.
Permission-field capture and builtin-only shell commands remain the limitations listed
in [RUNTIME_BRIEF.md](../dataset/RUNTIME_BRIEF.md); this integration does not change capture.
