# Laya data and training

Run commands from the repository root. Generated inputs, reviews, reports and checkpoints
live in ignored `.data/`; downloaded models live in ignored `models/`. Both are local symlinks.
Use the existing `.venv` for Laya, tokenizers, PyArrow and PyYAML. Generation and integrity
tests otherwise use the Python standard library; the tokenizer regression test skips when
tokenizers is unavailable. `-I` keeps imports independent of the
working directory; scripts load sibling modules explicitly.

## Current artifacts

- **Approved pilot:** `.data/pilot-v2/release/` has 1,165 train, 174 validation and 386 gold
  rows. Train/validation labels are model-proposed and reviewed; all gold rows have recorded
  owner approval. `readiness.json` records the release checks.
- **Selected checkpoint:** `.data/pilot-v2/finetune-04/checkpoint/`. Its `selection.json`
  records selection using validation before gold scoring. It trained the encoder for one
  epoch on the approved pilot, reaching 75.86% serving validation accuracy. Base Laya is
  `models/laya/multilingual/`. The selected checkpoint and base have already been scored
  on gold; that result is a fixed report, not a fresh holdout for further tuning.
- **Expansion draft:** `.data/expansion-v1/train-proposed.jsonl` has 9,551 kept proposals
  from 10,000 candidates: 3,783 Allow, 5,768 Hold, 449 exclusions, no Block. It has not been
  merged into the approved release.
- **Synthetic draft:** `.data/block-proposals-reviewed-v1/train-proposed.jsonl` has 39
  model-reviewed rows: 21 Block, 12 Hold, 6 Allow. `train-with-expansion-proposed.jsonl`
  combines these with the expansion (9,590 rows), with mixed review coverage.
- **Expansion experiments:** `.data/runs/laya-expansion-01`, `-02-ep2` and `-03-ep3` train
  the encoder for 1/2/3 epochs on the approved train split plus the 9,590 draft rows.
  Serving validation: 83.3%, 84.5% and 78.2% (selected checkpoint: 75.9%); false Allow
  drops from 21 to 5 of 73 non-Allow rows. No run predicts Block. These are experimental
  checkpoints trained mostly on unapproved labels; the selected checkpoint is unchanged.
- **Review pages:** `.data/expansion-v1/sample-review.html` is the original 30-row sample;
  `.data/expansion-v1/review-samples/sample-02/review.html` has eight each of Allow, Hold,
  Block and rejected. The second sample is stratified after labeling, not a prevalence
  estimate. `.data/block-proposals-reviewed-v1/review.html` shows all 39 synthetic rows.
  Export review JSONL before closing a page; import it to resume. Only explicitly reviewed
  examples are approved.

The draft exports are separate from the approved release. [HISTORY.md](HISTORY.md) records
their lineage, review limitations and the retained records of older experiments.

## Demo regressions

`examples/demo-v1.jsonl` records the demo policy: known system `whoami`, `clear`, and
`clear_console` calls are Allow; opening Vim is Hold; recursive forced deletion of `/`
and protected system paths is Block, while other deletion targets need review, including
when the caller is root. Known help-only requests are Allow, including `vim -h` and
`vim --help` ([Vim startup options](https://github.com/vim/vim/blob/master/runtime/doc/starting.txt)).
Python's own help flags are distinct from arguments passed to an unseen script
([Python command-line options](https://docs.python.org/3/using/cmdline.html)).

The cases include command chains, literal command text, help flags after `--`, and
untrusted executables so an innocent tool name or help token cannot approve the entire
command. `demo.py` renders synthetic root/dev contexts through the existing renderer;
it never executes the supplied commands or adds runtime verdict rules.

```sh
# Prepare a new snapshot: 2,880 training contexts and 768 regression contexts.
python3 -I -B dataset/demo.py prepare --out .data/demo-next

# Check a checkpoint with the serving question and prediction API.
# Every regression is predicted twice; any wrong or unstable answer exits nonzero.
.venv/bin/python -I -B dataset/demo.py check \
  --base .data/runs/laya-demo-test-01/checkpoint \
  --out .data/demo-test-check.json --device cuda
```

These are policy-derived synthetic labels, not individual human reviews. Training and
regression states differ, but share command families; their pass rate measures demo
regressions, not independent model quality. Existing approved exports and gold stay
unchanged. Demo experiment inputs, candidate reports, and checkpoint selection remain
under `.data/runs/laya-demo-*`.

`finetune.py` includes these 2,880 demo training contexts by default alongside the approved
release. Its preflight checks rendering, token limits and exact input separation from
validation, gold and demo regression contexts. The run writes the combined `train.jsonl`
and records the demo labels and source hashes separately in `report.json`. Use `--no-demo`
to train on the original release without the demo additions. The 768 demo regression
contexts remain separate and can be checked with `demo.py check` after training.

An earlier checkpoint is published for testing at
`.data/runs/laya-demo-test-01/checkpoint/`. Fetch its weights with:

```sh
git lfs pull --include=".data/runs/laya-demo-test-01/checkpoint/model.safetensors"
```

Its [manifest](../.data/runs/laya-demo-test-01/manifest.json) and
[evaluation](../.data/runs/laya-demo-test-01/evaluation.json) record the provenance and
known failures. It passes 766/768 demo contexts, including all reported command groups
and help cases. Two contexts incorrectly allow an untrusted `/tmp/bash -c whoami`.
The broader control set has six incorrect Allows versus four in the original model,
and the prior Block suite has two versus one. This candidate has not passed selection;
the default checkpoint stays unchanged. Its starting weights include earlier experimental
training, including unapproved model proposals. Ongoing training outputs stay ignored.

## Generate and annotate

```sh
# Fetch raw text/YAML/Parquet, then normalize it into seeds.
bash dataset/fetch.sh
.venv/bin/python -I dataset/seeds.py

# Small broad-pool sample; omit --limit for every seed.
.venv/bin/python -I dataset/contexts.py --limit 100 --out .data/context-smoke

# New bounded pilot with protected train/validation/gold allocations.
.venv/bin/python -I dataset/curate.py --out .data/pilot-next

# New training-only expansion, excluding prior pilot families and held-out units.
.venv/bin/python -I dataset/expand.py --out .data/expansion-next --rows 10000 --workers 10

# Once annotation files exist, validate and collect the existing expansion.
.venv/bin/python -I dataset/expand.py --collect
```

`fetch.sh` only downloads sources; it does not execute their contents. Seed loading needs
PyArrow for SSH/Terminal-Bench and PyYAML for Atomic Red Team. Seed files and broad-pool
contexts are **unlabeled**, not training inputs. `contexts.py` writes `candidates.jsonl`,
`rejected.jsonl`, and source/context diagnostics in `report.json`; reruns overwrite those
outputs. Use a new directory when retaining a generation.

`curate.py` freezes candidate states and allocations before labeling. Annotators receive
opaque IDs, rendered states and hashes, with source, split and student predictions hidden.
[RUBRIC.md](RUBRIC.md) defines labels; [POLICY.md](POLICY.md) records the owner's clarification.
Annotations require exact visible evidence, facts consistent with the label and matching
state hashes. For a new pilot, after annotations and independent review files are present:

```sh
.venv/bin/python -I dataset/audit.py --pilot .data/pilot-next \
  --annotations .data/pilot-next/proposals-frozen.jsonl
.venv/bin/python -I dataset/adjudicate.py --pilot .data/pilot-next \
  --annotations .data/pilot-next/proposals-frozen.jsonl \
  --reviews .data/pilot-next/model-review.jsonl
.venv/bin/python -I dataset/release.py --draft --pilot .data/pilot-next \
  --annotations .data/pilot-next/annotations-final.jsonl \
  --model-reviews .data/pilot-next/reviews-final.jsonl
```

The draft includes a gold review page. Export its human reviews, then run `release.py`
without `--draft`, adding `--human-reviews <file>`. A release requires matching external
model reviews, explicit gold approvals, at least 100 train/50 validation/300 gold rows and
all three classes in each split. Disputes and malformed shell text remain excluded.

## Train and evaluate

```sh
# Preflight and Laya's dry run only; no optimizer updates.
.venv/bin/python -I dataset/finetune.py --out .data/runs/preflight

# New run: approved pilot plus demo contexts, one epoch, with encoder updates.
.venv/bin/python -I dataset/finetune.py --out .data/runs/laya-next --train-encoder --run

# Original approved pilot only.
.venv/bin/python -I dataset/finetune.py --out .data/runs/laya-pilot-only --no-demo --run

# Device: --device auto (default) picks cuda, then Apple silicon (mps), then cpu. On a Mac, pass
# --device mps to require it; ops MPS lacks fall back to the CPU. evaluate.py takes the same flag.

# crystal-pregame import (~/Projects/crystal-pregame/data/raw): 8,223 rule-labelled, training-only rows
# in .data/pregame-v1 (allow 2,908 / hold 5,299 / block 16). Labels come from visible command text only,
# not from the source's malicious/benign tag, and are `rule_proposed`: not model- or human-reviewed.
.venv/bin/python -I dataset/pregame.py --out .data/pregame-v1
.venv/bin/python -I dataset/finetune.py --out .data/runs/pregame-01 --device mps --no-candidates --train-encoder --run \
  --extra-train .data/pregame-v1/train-proposed.jsonl --extra-candidates .data/pregame-v1/candidates.jsonl

# Experimental: append unapproved draft rows to train only. Validation/gold stay approved,
# and draft rows sharing a family, unit, pair or state with them are rejected.
.venv/bin/python -I dataset/finetune.py --out .data/runs/laya-expansion-next --train-encoder --run \
  --extra-train .data/block-proposals-reviewed-v1/train-with-expansion-proposed.jsonl \
  --extra-candidates .data/expansion-v1/candidates.jsonl \
  --extra-candidates .data/block-proposals-reviewed-v1/candidates.jsonl

# Default split is validation. Choose an empty output directory.
.venv/bin/python -I dataset/evaluate.py \
  --base .data/pilot-v2/finetune-04/checkpoint \
  --annotations .data/pilot-v2/release/annotations.jsonl \
  --out .data/evaluations/selected-validation

# Recompute a report from saved predictions without loading the model or GPU.
.venv/bin/python -I dataset/evaluate.py \
  --scores .data/pilot-v2/finetune-04/serving-validation/predictions.jsonl \
  --annotations .data/pilot-v2/release/annotations.jsonl \
  --out .data/evaluations/cached-validation

# Synthetic latency test with the shared verdict question.
.venv/bin/python -I bench/latency.py --base .data/pilot-v2/finetune-04/checkpoint \
  --out .data/bench/selected.json
```

`finetune.py` defaults to `.data/pilot-v2/release`; `--pilot` selects another snapshot and
`--release` can override its export directory. It checks states, labels, questions, token
limits, split isolation and readiness before training. The encoder is frozen unless
`--train-encoder` is supplied. `--epochs` defaults to one; calibration is disabled. Training
writes `train.log`, `progress.json`, `report.json` and a separate checkpoint, and verifies
the base weights remain unchanged. Use a new output directory for every run or report.

Evaluate with the same renderer/question used for training. Trainer accuracy uses a
different protocol; compare serving reports with other serving reports. Validation may
guide selection; gold must not. `--splits gold` is explicit and intended for a fixed final
evaluation. Harm-based safety rates remain omitted because some Hold harm facts are
unverified. A passing release check or model agreement does not establish security quality.

## Input and integrity constraints

Only `row["event"]` goes through [render.py](render.py). Provenance never enters the model
state. [MODEL_INPUT.md](MODEL_INPUT.md) describes the input contract. The C++ decider routes
live Laya verdicts through the command-review flow using `src/jev_laya.cpp` and the
persistent Python worker. [Runtime configuration](../runtime/README.md) describes startup
and checkpoint selection; [RUNTIME_BRIEF.md](RUNTIME_BRIEF.md) lists proposed capture changes.

- Broad contexts are hypothetical `bash -c` scenarios. They have no captured script contents,
  file ownership or actual permission evidence beyond the supplied fields. The two default
  variants share command, cwd, origin and history while changing actor/permissions; they are
  not presumed to need different labels.
- Histories retain at most five source entries of 200 characters, deterministically shortened.
  Missing history stays empty. History presence reveals a session source, excluding nl2bash
  and tldr. The bounded pilot instead uses the same neutral history bank for every source;
  this does not establish performance on authentic sessions. Cwd is synthetic or masked;
  broad contexts omit it when source history mentions `cd`.
- Only tldr gets `{{...}}` substitution. Unknown templates, interactive history expansion,
  documentation aliases and unresolved Terminal-Bench references are quarantined. Quality
  flags and actor-transition warnings need review; they are not semantic validation. Some
  warnings inspect full provenance history, which can be absent from the shortened state.
- Command/source URLs and template conventions can still expose provenance. Source cleanup
  is not anonymization. Seed commands are capped at 4,000 characters; rendered commands at
  2,000. Hidden suffixes cannot justify labels. Annotate the exact rendered state.
- File inference is a shell heuristic. It follows nested `-c` scripts to depth four and omits
  all heredoc bodies, including executable bodies and unquoted expansions. Empty inferred
  files do not imply safety. ANSI-C quoting, malformed arithmetic, CRLF heredoc endings and
  continued redirects remain edge cases.
- Pair, normalized command family, source unit and exact state must stay in one split.
  Related tasks/scripts/sessions can escape normalized-family heuristics and need review.
  Source/context distributions are diagnostics, not proof of unbiased labels or splits.

Run all integrity tests without a GPU:

```sh
python3 -I -B -m unittest discover -s dataset -p 'test_*.py' -v
```

The audit uses Bash only with `-n`, startup files disabled, to parse supplied text. Dataset
commands are never executed by these tools or tests.
