# Dataset lineage

These are completed snapshots, not instructions to rerun the entire sequence. Candidate,
annotation, approval and score files remain under `.data/`. Frozen rubric/policy files keep
their original bytes because manifests bind their hashes.

## Approved pilot

1. `.data/pilot/`: 1,778 bounded candidates, allocated before annotation. Luna proposals,
   Sonnet reviews and an owner policy clarification produced 1,149 usable train, 168
   validation and 384 gold rows. Sixteen original gold exclusions remain in the history.
   The initial train/validation sets had no Block examples.
2. `.data/pilot-disruption-v1/`: 16 synthetic, training-only rows (6 Block, 6 Allow, 4 Hold)
   under [DISRUPTION_POLICY.md](DISRUPTION_POLICY.md), proposed by Luna and reviewed by
   Sonnet. Owner acceptance is hash-bound in `owner-approval.json`. `supplement.py` and
   `examples/disruption-v1.jsonl` reproduce its preparation/export.
3. `.data/pilot-eval-additions-v1/`: six validation and two gold additions, proposed by Luna
   and reviewed by Sonnet. `eval_additions.py` and `examples/evaluation-additions-v1.jsonl`
   prepare them and merge the versioned snapshot.
4. `.data/pilot-v2/`: the combined approved release, 1,165 train/174 validation/386 gold.
   Prior approvals carried over only for matching IDs/states; the two new gold approvals
   have separate records. Candidate manifests, excluded history, review registries and
   `release/readiness.json` are the detailed record.

Sonnet's first pilot review inspected command/user/sudo/cwd/inferred files across the
non-Block proposals, with fuller inspection of Block and policy follow-ups. It did not
inspect every context field on every original row. Some agreed Hold harm facts remained
unreliable; harm-based error rates are suppressed. Model review coverage must not be
inferred from an annotation's status string.

## Training experiments

The original 64-row technical trial in `.data/pilot/trial-reviewed/` showed training
compatibility without serving accuracy improvement. Its saved input snapshots and reports
remain; the superseded checkpoint weights were pruned.

Five approved-pilot runs compared frozen-head training (1/3/5 epochs) and encoder training
(1/3 epochs). `.data/pilot-v2/finetune-04/selection.json` selects the one-epoch encoder
run on validation only, before gold scoring. Reports, progress, logs and serving predictions
for all five runs remain. Only run 04's checkpoint is retained. Gold reports for the fixed
selected and base models remain under that run.

Three expansion runs (`.data/runs/laya-expansion-*`) added the 9,590 draft rows to the
approved train split via `finetune.py --extra-train`, training the encoder for 1, 2 and 3
epochs. Serving validation accuracy was 83.3%, 84.5% and 78.2%, with Brier 0.271, 0.287 and
0.420; each allowed 5 of 73 non-Allow rows. Three epochs overfit (final loss 0.03). None
predicted Block: one epoch allowed 2 of the 6 synthetic Block rows and held 4; two and three
epochs held all 6. Atomic Red Team rows stayed at 66-69%. The conclusion was that data, not
training length, limits further gains, especially varied Block examples. Gold was not scored.

Early D1/D3/Laya latency comparison JSON is retained under `.data/bench/legacy/`. The
unused D1/D3 downloads and their benchmark adapters were removed. `bench/latency.py` now
benchmarks local Laya checkpoints using the shared verdict question.

## Later proposals

`.data/expansion-v1/` freezes 5,000 new commands in two permission contexts each. It
excludes prior selected/rejected families and held-out source units. Ten Luna assignments
produced 9,551 kept proposals and 449 exclusions. Original worker checkpoints, frozen
annotations, hashes and the sample selected before labeling remain together. No Block
survived policy review; these proposals have not been trained or promoted into the release.

`.data/block-proposals-v1/` holds Luna's 24 synthetic cases; Opus reviewed those and added
15 under `.data/block-proposals-opus-v1/`. Luna's review changed six additions to Hold.
The final 39-row snapshot in `.data/block-proposals-reviewed-v1/` keeps original proposals
and external reviews. It is weighted toward credential transmission; different transports
are not independent mechanisms. Opus was requested as 5.5, but the owner enabled the
provider's 4.8 fallback; `runtime-provenance.json` records that limitation.

The second 32-row review sample is stratified by label/rejection, source and available
synthetic mechanism groups, excluding the first sample's IDs/families. Its manifest records
the sampling procedure. Reviewing a sample approves only those individual rows.

## Cleanup record

The October 17 cleanup consolidated the older step-by-step reports into this file and
the current README, removed the duplicate trial trainer and unused prototype threshold
selector, and pruned superseded weights. `.data/cleanup/` records deleted artifacts and
hashes; `source-before-*.tar.gz` preserves the original untracked source/documentation.
Training and evaluation now require explicit output directories; evaluation defaults to
version 2 validation. Token counters ignore saved truncation/padding, fixing a benchmark
loop caused by the selected checkpoint's saved 48-token window. Saved weights are unchanged.
The owner identified `bench/results/dubhacks-26/` as a misplaced Git connectivity test
clone and requested its removal. It was deleted after confirming no uncommitted changes,
untracked/ignored files, stashes or local branch commits absent from its remote references.
