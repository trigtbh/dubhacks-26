"""Fine-tune an approved release; frozen encoder unless --train-encoder is supplied.

Default runs preflight only. --run trains on the approved train rows and synthetic demo
examples, writes progress for a read-only monitor, and leaves the base checkpoint unchanged.
--no-demo omits the demo examples. Serving validation is run afterwards with evaluate.py.
Gold is checked only for export integrity and separation from training.
"""
from __future__ import annotations
import argparse
import collections
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
spec = importlib.util.spec_from_file_location("contexts", Path(__file__).with_name("contexts.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
demo = c.sibling("demo")
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


def verify_extra(rows, candidates, held):
    """Unapproved draft rows: same renderer/question contract, no groups shared with validation/gold."""
    for row in rows:
        source = candidates.get(row["id"])
        if source is None or source["state"] != row["state"] or c.renderer.render(source["event"]) != row["state"]:
            raise ValueError(f"extra row not in its frozen candidates: {row['id']}")
        if row.get("questions") != {"verdict": c.renderer.VERDICT_QUESTION} or row["expected"]["verdict"] not in LABELS:
            raise ValueError(f"extra row question/label differs from serving contract: {row['id']}")
        for key in GROUP_KEYS:
            if (key, source[key]) in held:
                raise ValueError(f"extra row shares {key} with {held[key, source[key]]}: {row['id']}")


def preflight(release: Path, pilot: Path, base: Path, max_len: int, extra=(), extra_candidates=(), demo_train=()) -> dict:
    candidates = {r["id"]: r for r in demo.read(pilot / "candidates.jsonl")}
    annotations = {a["id"]: a for a in demo.read(release / "annotations.jsonl")}
    splits = {name: demo.read(release / f"{name}.jsonl") for name in ("train", "validation", "gold")}
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
    if extra:
        held = {k: v for k, v in owner.items() if v != "train"}
        sources = {r["id"]: r for path in extra_candidates for r in demo.read(path)}
        if len({r["id"] for r in extra} | {r["id"] for r in splits["train"]}) != len(extra) + len(splits["train"]):
            raise ValueError("extra rows repeat ids")
        verify_extra(extra, sources, held)
        counts["extra_train_unapproved"] = dict(collections.Counter(r["expected"]["verdict"] for r in extra))
        tokens.extend(len(tok.encode(r["state"], add_special_tokens=False)) for r in extra)
    if demo_train:
        regression_states = {r["state"] for r in demo.examples("regression")}
        held_states = {r["state"] for name in ("validation", "gold") for r in splits[name]}
        held_states.update(regression_states)
        seen_ids = {r["id"] for rows in splits.values() for r in rows} | {r["id"] for r in extra}
        seen_states = {r["state"] for r in splits["train"]} | {r["state"] for r in extra}
        if seen_states & regression_states:
            raise ValueError("training overlaps demo regression inputs")
        for row in demo_train:
            if (row.get("questions") != {"verdict": c.renderer.VERDICT_QUESTION}
                    or row["expected"]["verdict"] not in LABELS
                    or row["state"] != c.renderer.render(row["event"])):
                raise ValueError(f"demo row renderer/question/label mismatch: {row['id']}")
            if row["state"] in held_states:
                raise ValueError(f"demo training overlaps held-out inputs: {row['id']}")
            if row["id"] in seen_ids or row["state"] in seen_states:
                raise ValueError(f"duplicate demo training input: {row['id']}")
            seen_ids.add(row["id"])
            seen_states.add(row["state"])
        counts["demo_train_policy"] = dict(collections.Counter(r["expected"]["verdict"] for r in demo_train))
        tokens.extend(len(tok.encode(r["state"], add_special_tokens=False)) for r in demo_train)
    if max(tokens) > max_len:
        raise ValueError("train/validation state exceeds max_len")
    return {"counts": counts, "split_leakage": 0, "gold_ids_in_train_or_validation": 0,
            "state_tokens_max_train_validation": max(tokens), "labels_match_release_annotations": True,
            "renderer_and_question_contract": "matched"}


def family_of(state):
    """Command family of a rendered state (as curate.py groups them), or None if the command line is not parseable."""
    m = re.match(r"command: (.*?)\nprogram: ", state, re.S)
    return "family:" + c.digest(c.seeds.normalize(m.group(1))) if m else None


def preflight_light(release: Path, base: Path, max_len: int, extra=(), extra_candidates=()) -> dict:
    """Reduced checks for when the frozen candidates.jsonl is unavailable (--no-candidates).

    Verifies ids, the serving question, labels against annotations and train/validation/gold overlap by id
    and state hash. It cannot check family/unit/pair split leakage, which needs the candidates."""
    annotations = {a["id"]: a for a in map(json.loads, (release / "annotations.jsonl").open())}
    splits = {name: [json.loads(l) for l in (release / f"{name}.jsonl").open()] for name in ("train", "validation", "gold")}
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(str(base / "tokenizer/tokenizer.json"))
    tok.no_truncation()
    tok.no_padding()
    tokens, counts, owner = [], {}, {}
    for name, rows in splits.items():
        if not rows or len({r["id"] for r in rows}) != len(rows):
            raise ValueError(f"empty or duplicate ids in {name}")
        for r in rows:
            label, a = r["expected"]["verdict"], annotations.get(r["id"])
            if r.get("questions") != {"verdict": c.renderer.VERDICT_QUESTION} or label not in LABELS:
                raise ValueError(f"question/label differs from serving contract: {r['id']}")
            if a is None or a.get("disposition") != "keep" or a.get("label") != label \
                    or a.get("state_sha256") != c.digest(r["state"]):
                raise ValueError(f"label/annotation inconsistency: {r['id']}")
            for key in (("id", r["id"]), ("state", c.digest(r["state"]))):
                if owner.setdefault(key, name) != name:
                    raise ValueError(f"split overlap on {key[0]}: {r['id']}")
        counts[name] = dict(collections.Counter(r["expected"]["verdict"] for r in rows))
        if name != "gold":
            tokens.extend(len(tok.encode(r["state"], add_special_tokens=False)) for r in rows)
    if extra:
        sources = {r["id"]: r for path in extra_candidates for r in map(json.loads, path.open())}
        held_states = {k[1] for k, name in owner.items() if k[0] == "state" and name != "train"}
        held_families = {family_of(r["state"]) for name in ("validation", "gold") for r in splits[name]} - {None}
        if len({r["id"] for r in extra} | {r["id"] for r in splits["train"]}) != len(extra) + len(splits["train"]):
            raise ValueError("extra rows repeat ids")
        for row in extra:
            source = sources.get(row["id"])
            if source is None or source["state"] != row["state"] or c.renderer.render(source["event"]) != row["state"]:
                raise ValueError(f"extra row not in its frozen candidates: {row['id']}")
            if row.get("questions") != {"verdict": c.renderer.VERDICT_QUESTION} or row["expected"]["verdict"] not in LABELS:
                raise ValueError(f"extra row question/label differs from serving contract: {row['id']}")
            if c.digest(row["state"]) in held_states or source["split_family"] in held_families:
                raise ValueError(f"extra row overlaps validation/gold by state or command family: {row['id']}")
        counts["extra_train_unapproved"] = dict(collections.Counter(r["expected"]["verdict"] for r in extra))
        tokens.extend(len(tok.encode(r["state"], add_special_tokens=False)) for r in extra)
    if max(tokens) > max_len:
        raise ValueError("train/validation state exceeds max_len")
    return {"mode": "reduced (--no-candidates): family/unit/pair split leakage NOT checked", "counts": counts,
            "state_tokens_max_train_validation": max(tokens), "labels_match_release_annotations": True}


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
    ap.add_argument("--no-demo", action="store_true", help="omit the synthetic demo training examples")
    ap.add_argument("--no-candidates", action="store_true",
                    help="run without the frozen pilot candidates.jsonl, using reduced preflight checks")
    ap.add_argument("--device", choices=("auto", "cuda", "mps", "cpu"), default="auto",
                    help="auto picks cuda, then Apple silicon (mps), then cpu")
    ap.add_argument("--extra-train", type=Path, action="append", default=[],
                    help="unapproved draft rows appended to train only (experimental)")
    ap.add_argument("--extra-candidates", type=Path, action="append", default=[],
                    help="frozen candidates.jsonl covering every --extra-train row")
    args = ap.parse_args()
    args.release = args.release or args.pilot / "release"
    if args.epochs <= 0 or args.log_every <= 0:
        ap.error("--epochs and --log-every must be positive")
    if args.out.exists() and any(args.out.iterdir()):
        ap.error("output directory is not empty; choose a new --out")
    if bool(args.extra_train) != bool(args.extra_candidates):
        ap.error("--extra-train and --extra-candidates go together")
    extra = [row for path in args.extra_train for row in demo.read(path)]
    demo_train = [] if args.no_demo else demo.examples("train")
    from laya.train import TrainConfig, dry_run, finetune, optimizer_updates
    # Keep each input once; synthetic context variants already contain correlated examples.
    config = TrainConfig(epochs=args.epochs, micro_batch=4, grad_accum=4, freeze_encoder=not args.train_encoder, loss="soft-ce",
                         shuffle_options=("choice",), calib_frac=0, max_len=1024, head_max_len=256,
                         eval_data=str(args.release / "validation.jsonl"), seed=42, log_every=args.log_every)
    report = {"experimental_only": True, "production_checkpoint": False, "gold_used_for_training": False,
              "gold_used_for_selection": False, "class_balancing": "none (each input row once)",
              "labels": "owner-approved release; model-proposed/reviewed, harm facts not human-verified",
              "demo": {"enabled": not args.no_demo, "training_rows": len(demo_train),
                       "labels": "synthetic policy-derived examples; not individually human verified",
                       "shared_command_families_with_regressions": bool(demo_train)},
              "input_sha256": {str(p.resolve()): sha(p) for p in (
                  args.release / "train.jsonl", args.release / "validation.jsonl", args.release / "annotations.jsonl",
                  args.release / "readiness.json", *([] if args.no_candidates else [args.pilot / "candidates.jsonl"]), Path(c.renderer.__file__),
                  *args.extra_train, *args.extra_candidates,
                  *((demo.CASES, Path(demo.__file__)) if demo_train else ()))},
              "preflight": (preflight_light(args.release, args.base, 1024, extra, args.extra_candidates) if args.no_candidates
                            else preflight(args.release, args.pilot, args.base, 1024, extra, args.extra_candidates, demo_train))}
    train_path = args.release / "train.jsonl"
    if extra:
        report["labels"] += "; plus unapproved draft rows (model-proposed, partial review)"
    if demo_train:
        report["labels"] += "; plus synthetic demo policy examples"
    if extra or demo_train:
        args.out.mkdir(parents=True, exist_ok=True)
        train_path = args.out / "train.jsonl"
        with train_path.open("w") as f:
            for row in demo.read(args.release / "train.jsonl") + extra + demo_train:
                f.write(json.dumps(row, sort_keys=True) + "\n")
        report["input_sha256"]["combined_train"] = sha(train_path)
    readiness = json.loads((args.release / "readiness.json").read_text())
    if not readiness.get("training_data_ready") or readiness.get("readiness_issues"):
        raise ValueError("release readiness does not permit training")
    n_train = report["preflight"]["counts"]["train"]
    n_train = sum(n_train.values()) + len(extra) + len(demo_train)
    report["config"] = {k: getattr(config, k) for k in config.__dataclass_fields__}
    report["micro_steps"] = -(-n_train // config.micro_batch) * config.epochs
    report["optimizer_updates"] = optimizer_updates(n_train, config.micro_batch, config.grad_accum, config.epochs)
    report["dry_run"] = dry_run(str(train_path), str(args.base), config)
    args.out.mkdir(parents=True, exist_ok=True)
    if args.run:
        report["base_sha256_before"] = {n: sha(args.base / n) for n in ("model.safetensors", "rl_agent_config.json")}
        progress = Progress(args.out, report["micro_steps"], report["optimizer_updates"], config.grad_accum, config.epochs)
        (args.out / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        started = time.perf_counter()
        try:
            with contextlib.redirect_stdout(progress):
                result = finetune(str(train_path), str(args.base), str(args.out / "checkpoint"), config, c.pick_device(args.device))
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
