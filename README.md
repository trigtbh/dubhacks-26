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
bpftool, libbpf, libelf, zlib and kernel BTF. `sandbox.sh` and `vm.sh` provide the existing
isolated demo environments; read their usage comments before starting them.
