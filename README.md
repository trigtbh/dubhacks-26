# Linux command review with Laya

This repository captures Linux exec events, reviews uncertain commands through isolated
simulation and human approval, and prepares data for a local Allow/Hold/Block classifier.
The daemon calls the model interface in `src/jev.hpp`; its current implementation in
`src/jev_stub.cpp` always allows. The selected Laya checkpoint has not been connected to
that interface.

- [Data generation, annotation, training and evaluation](dataset/README.md)
- [Model input contract](dataset/MODEL_INPUT.md)
- [Proposed runtime integration](dataset/RUNTIME_BRIEF.md)
- [Dataset and experiment history](dataset/HISTORY.md)

The approved dataset is `.data/pilot-v2/release/`; the selected checkpoint is
`.data/pilot-v2/finetune-04/checkpoint/`. Newer expansion files are proposals and remain
separate. `.data/`, `models/` and `.venv/` are ignored local symlinks.

Run the command-review and data integrity tests together with:

```sh
make check
# Include the optional tokenizer regression test using the local environment:
make check PYTHON=.venv/bin/python
```

`make test` runs just the C++ command-review tests; overlay/whiteout cases need root
and skip otherwise. `make test-data` runs just the Python data tests without a GPU.

`make` builds the Linux daemon, simulation helper and eBPF program, requiring a C++17 compiler, clang,
bpftool, libbpf, libelf, zlib and kernel BTF. `sandbox.sh` and `vm.sh` provide the existing
isolated demo environments; read their usage comments before starting them.
