"""Fine-tune an approved release; frozen encoder unless --train-encoder is supplied.

Default runs preflight only. --run trains on every approved train row, writes progress for a
read-only monitor, and leaves the base checkpoint unchanged. Serving validation is run afterwards
with evaluate.py. Gold is checked only for export integrity and separation from training.
"""
from __future__ import annotations
import argparse
import collections
import contextlib
import hashlib
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
spec = importlib.util.spec_from_file_location("contexts", Path(__file__).with_name("contexts.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
LABELS = ("allow", "hold", "block")
GROUP_KEYS = ("split_family", "split_unit", "pair_id", "state_sha256")


def sha(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def verify_split(rows, candidates, annotations, split):
    if not rows:
        raise ValueError(f"release requires nonempty {split} inputs")
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError(f"duplicate ids in {split}")
    expected_ids = {identity for identity, candidate in candidates.items()
                    if candidate["split"] == split and annotations.get(identity, {}).get("disposition") == "keep"}
    if {row["id"] for row in rows} != expected_ids:
        raise ValueError(f"export does not cover exactly the kept {split} candidates")
    for row in rows:
        identity = row["id"]
        source, annotation = candidates.get(identity), annotations.get(identity)
        if source is None or source["split"] != split or row["state"] != source["state"]:
            raise ValueError(f"row not in frozen {split} candidates: {identity}")
        if c.digest(row["state"]) != source["state_sha256"] or c.renderer.render(source["event"]) != row["state"]:
            raise ValueError(f"state hash/renderer mismatch: {identity}")
        if row.get("questions") != {"verdict": c.renderer.VERDICT_QUESTION}:
            raise ValueError(f"question differs from serving contract: {identity}")
        label = row["expected"]["verdict"]
        if label not in LABELS or annotation is None or annotation.get("disposition") != "keep" \
                or annotation.get("label") != label or annotation.get("state_sha256") != source["state_sha256"]:
            raise ValueError(f"label/annotation inconsistency: {identity}")


def preflight(release: Path, pilot: Path, base: Path, max_len: int) -> dict:
    candidates = {r["id"]: r for r in map(json.loads, (pilot / "candidates.jsonl").open())}
    annotations = {a["id"]: a for a in map(json.loads, (release / "annotations.jsonl").open())}
    splits = {name: [json.loads(l) for l in (release / f"{name}.jsonl").open()]
              for name in ("train", "validation", "gold")}
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(str(base / "tokenizer/tokenizer.json"))
    tok.no_truncation()
    tok.no_padding()
    tokens, counts = [], {}
    for name, rows in splits.items():
        verify_split(rows, candidates, annotations, name)
        counts[name] = dict(collections.Counter(r["expected"]["verdict"] for r in rows))
        if name != "gold":
            tokens.extend(len(tok.encode(r["state"], add_special_tokens=False)) for r in rows)
    owner = {}
    for name, rows in splits.items():
        for r in rows:
            for key in GROUP_KEYS:
                value = candidates[r["id"]][key]
                if owner.setdefault((key, value), name) != name:
                    raise ValueError(f"split leakage on {key}={value}")
    if max(tokens) > max_len:
        raise ValueError("train/validation state exceeds max_len")
    return {"counts": counts, "split_leakage": 0, "gold_ids_in_train_or_validation": 0,
            "state_tokens_max_train_validation": max(tokens), "labels_match_release_annotations": True,
            "renderer_and_question_contract": "matched"}


class Progress:
    """Tee trainer stdout to a log and a small JSON snapshot the monitor reads."""

    def __init__(self, out: Path, total_steps: int, total_updates: int, grad_accum: int, epochs: int):
        self.log = (out / "train.log").open("a")
        self.path = out / "progress.json"
        self.state = {"status": "starting", "micro_steps_total": total_steps,
                      "optimizer_updates_total": total_updates, "micro_step": 0, "epoch": 0,
                      "epochs_total": epochs, "started_unix": time.time(), "updated_unix": time.time(),
                      "last_loss": None, "note": "loss is training loss, not accuracy"}
        self.grad_accum, self.stream, self.per_epoch = grad_accum, sys.stdout, total_steps // epochs
        self.update()

    def update(self, **changes):
        self.state.update(changes, updated_unix=time.time())
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2) + "\n")
        os.replace(tmp, self.path)

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def write(self, text):
        self.stream.write(text)
        self.log.write(text)
        self.log.flush()
        for line in text.splitlines():
            parts = line.split()
            if len(parts) == 6 and parts[0] == "epoch" and parts[2] == "step" and parts[4] == "loss":
                epoch = int(parts[1].split("/")[0])
                step = (epoch - 1) * self.per_epoch + int(parts[3])
                per_epoch_updates = self.state["optimizer_updates_total"] // self.state["epochs_total"]
                self.update(status="training", epoch=epoch, micro_step=step,
                           optimizer_update=(epoch - 1) * per_epoch_updates
                           + min(-(-int(parts[3]) // self.grad_accum), per_epoch_updates),
                           last_loss=float(parts[5]))
            elif "mean loss" in line:
                epoch = int(parts[1].split("/")[0])
                done = epoch == self.state["epochs_total"]
                losses = self.state.setdefault("epoch_mean_losses", [])
                losses.append(float(parts[-1]))
                self.update(status="epoch_done_evaluating_and_saving" if done else "training", epoch=epoch,
                           micro_step=epoch * self.per_epoch,
                           optimizer_update=epoch * self.state["optimizer_updates_total"] // self.state["epochs_total"],
                           epoch_mean_loss=float(parts[-1]))
        return len(text)

    def flush(self):
        self.stream.flush()
        self.log.flush()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--release", type=Path, help="defaults to <pilot>/release")
    ap.add_argument("--pilot", type=Path, default=c.ROOT / ".data/pilot-v2")
    ap.add_argument("--base", type=Path, default=c.ROOT / "models/laya/multilingual")
    ap.add_argument("--out", type=Path, required=True, help="new directory for this run")
    ap.add_argument("--log-every", type=int, default=10)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--train-encoder", action="store_true", help="also update encoder weights (default lr 2.5e-5)")
    ap.add_argument("--run", action="store_true")
    args = ap.parse_args()
    args.release = args.release or args.pilot / "release"
    if args.epochs <= 0 or args.log_every <= 0:
        ap.error("--epochs and --log-every must be positive")
    if args.out.exists() and any(args.out.iterdir()):
        ap.error("output directory is not empty; choose a new --out")
    from laya.train import TrainConfig, dry_run, finetune, optimizer_updates
    # Natural class distribution, decided before any result: the 6 Block rows are 3 correlated
    # scenarios, so oversampling would mostly memorize them. Per-class results are reported instead.
    config = TrainConfig(epochs=args.epochs, micro_batch=4, grad_accum=4, freeze_encoder=not args.train_encoder, loss="soft-ce",
                         shuffle_options=("choice",), calib_frac=0, max_len=1024, head_max_len=256,
                         eval_data=str(args.release / "validation.jsonl"), seed=42, log_every=args.log_every)
    report = {"experimental_only": True, "production_checkpoint": False, "gold_used_for_training": False,
              "gold_used_for_selection": False, "class_balancing": "none (natural distribution; decided before results)",
              "labels": "owner-approved release; model-proposed/reviewed, harm facts not human-verified",
              "input_sha256": {str(p.resolve()): sha(p) for p in (
                  args.release / "train.jsonl", args.release / "validation.jsonl", args.release / "annotations.jsonl",
                  args.release / "readiness.json", args.pilot / "candidates.jsonl", Path(c.renderer.__file__))},
              "preflight": preflight(args.release, args.pilot, args.base, 1024)}
    readiness = json.loads((args.release / "readiness.json").read_text())
    if not readiness.get("training_data_ready") or readiness.get("readiness_issues"):
        raise ValueError("release readiness does not permit training")
    n_train = report["preflight"]["counts"]["train"]
    n_train = sum(n_train.values())
    report["config"] = {k: getattr(config, k) for k in config.__dataclass_fields__}
    report["micro_steps"] = -(-n_train // config.micro_batch) * config.epochs
    report["optimizer_updates"] = optimizer_updates(n_train, config.micro_batch, config.grad_accum, config.epochs)
    report["dry_run"] = dry_run(str(args.release / "train.jsonl"), str(args.base), config)
    args.out.mkdir(parents=True, exist_ok=True)
    if args.run:
        report["base_sha256_before"] = {n: sha(args.base / n) for n in ("model.safetensors", "rl_agent_config.json")}
        progress = Progress(args.out, report["micro_steps"], report["optimizer_updates"], config.grad_accum, config.epochs)
        (args.out / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        started = time.perf_counter()
        try:
            with contextlib.redirect_stdout(progress):
                result = finetune(str(args.release / "train.jsonl"), str(args.base), str(args.out / "checkpoint"), config, "cuda")
        except BaseException as e:
            progress.update(status="failed", error=repr(e))
            raise
        finally:
            progress.log.close()
        report["training_seconds"] = time.perf_counter() - started
        report["training"] = result
        report["base_sha256_after"] = {n: sha(args.base / n) for n in ("model.safetensors", "rl_agent_config.json")}
        if report["base_sha256_after"] != report["base_sha256_before"]:
            progress.update(status="failed", error="base weights changed")
            raise ValueError("base weights changed during training")
        report["checkpoint_sha256"] = sha(args.out / "checkpoint/model.safetensors")
        tr = result["train_report"]
        progress.update(status="trained_awaiting_serving_validation", training_seconds=report["training_seconds"],
                       trainer_protocol_validation_accuracy={"before": tr["before"]["accuracy"],
                                                             "after": tr["after"]["accuracy"]})
    (args.out / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True, default=str) + "\n")
    print(json.dumps({k: report[k] for k in ("preflight", "micro_steps", "optimizer_updates")}, sort_keys=True))


if __name__ == "__main__":
    main()
