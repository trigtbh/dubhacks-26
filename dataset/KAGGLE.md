# Kaggle GPU test

Import `kaggle.ipynb` into a private Kaggle notebook, enable **GPU T4x2** and
**Internet**, then run the cells in order. No dataset upload or API credential is
needed. The notebook downloads its checksummed runner from a pinned Git blob.

`kaggle.py prepare` downloads an explicit allowlist from commit
`24da0b1e7fb7e2b377d7963add462c482ee6926a`: the published experimental test checkpoint,
the original comparison checkpoint, approved pilot train/validation data and approval
records, synthetic-case sources, and prior Block regression cases. It verifies every
checkpoint file against the published manifest, keeps approval records for the train
and validation IDs, and reproduces the exact 4,758 weighted local training rows.
The gold split is excluded. Existing public GitHub files supply all inputs; notebook
results stay private.

The notebook preserves the installed CUDA PyTorch while installing Laya 0.4.11,
Transformers 5.20.1, and Tokenizers 0.23.3 with their required dependencies. It requires
CUDA Torch 2.6 or newer and rejects CPU/ROCm fallback. A 64-row training smoke checks
actual compatibility and checkpoint writing. Its elapsed time includes model loading
and saving, so compare full-stage timings to measure the training speedup.

Training uses one T4, micro-batch 16, and effective batch 16. If the smoke runs out of
memory, change `--micro-batch` to `8` or `4` in both training cells. The next cell
continues the published `partial-01` candidate for two passes, updating the last two
encoder layers and classification head. It recomputes the original control baseline
on that GPU and uses the same demo, control accuracy, incorrect-Allow, and prior Block
acceptance checks. These are development checks, not an independent quality benchmark.

Reports and checkpoints are written under `/kaggle/working/laya-pilot`. Download those
outputs after the run. The default application checkpoint changes only when an owner
explicitly selects a different model.

For a local preparation check without downloading another copy of the models:

```sh
python3 -B dataset/kaggle.py prepare --input .data/kaggle-input-check --local-source "$PWD"
python3 -B dataset/kaggle.py verify --files-only --input .data/kaggle-input-check
```

The local checkout must contain the files from the pinned commit, including its LFS
weights. This check loads no models and performs no training.
