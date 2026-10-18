"""Prepare demo examples or check real model predictions without executing commands."""
from __future__ import annotations

import argparse
import collections
import hashlib
import importlib.util
import json
import os
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "dataset/examples/demo-v1.jsonl"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


renderer = module("demo_render", ROOT / "dataset/render.py")


def read(path):
    with path.open() as stream:
        return [json.loads(line) for line in stream if line.strip()]


def digest(value):
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ).encode()).hexdigest()


def examples(split):
    histories = {
        "train": ([], ["pwd", "ls -la"], ["id", "cat README.md"],
                  ["whoami", "date", "ls"], ["vim config.yaml", "whoami", "clear"]),
        "regression": (["ls", "pwd", "date"], ["vim notes.txt", "whoami", "clear"]),
    }[split]
    origins = ("ssh", "local", "agent") if split == "train" else ("ssh", "local")
    rows = []
    for case in read(CASES):
        for user, uid in (("root", 0), ("dev", 1000)):
            for origin in origins:
                for index, history in enumerate(histories):
                    argv = case["argv"]
                    path = argv[0] if argv[0].startswith("/") else "/usr/bin/" + argv[0]
                    event = {
                        "argv": argv, "path": path, "file": path,
                        "user": user, "uid": uid, "gid": uid,
                        "cwd": ("/workspace", "/srv/app", "/home/dev")[index % 3],
                        "origin": {"type": origin},
                        "recent": history, "is_new": False,
                        **case.get("event", {}),
                    }
                    state = renderer.render(event)
                    rows.append({
                        "id": "demo-v1:" + digest([case["id"], split, event]),
                        "case": case["id"], "group": case["group"], "event": event,
                        **renderer.training_row(event, case["label"]),
                    })
    if len({row["state"] for row in rows}) != len(rows):
        raise ValueError("Demo contexts contain duplicate model inputs")
    return rows


def prepare(out):
    out.mkdir(parents=True, exist_ok=False)
    splits = {name: examples(name) for name in ("train", "regression")}
    if {r["state"] for r in splits["train"]} & {r["state"] for r in splits["regression"]}:
        raise ValueError("Training and regression inputs overlap")
    for name, rows in splits.items():
        with (out / (name + ".jsonl")).open("w") as stream:
            for row in rows:
                # Provenance and expected labels are never rendered into model input.
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    manifest = {
        "purpose": "Demo-specific training and regression checks; not a fresh quality benchmark",
        "policy": {
            "whoami_clear_clear_console": "allow for the known system executables",
            "vim": "hold when opening the editor; allow help-only invocations",
            "help_requests": "allow documented help-only requests to known system tools; a help token does not approve scripts, operands, or command chains",
            "recursive_forced_deletion": "block protected system targets; hold other targets",
            "protected_examples": ["/", "/etc", "/usr", "/boot", "/bin", "/sbin", "/lib", "/lib64"],
            "authority": "Owner confirmed training and protected-target deletion policy in chat",
        },
        "labels": "Synthetic policy-derived examples; not individually human verified",
        "commands_executed": False,
        "case_file_sha256": hashlib.sha256(CASES.read_bytes()).hexdigest(),
        "renderer_sha256": hashlib.sha256(Path(renderer.__file__).read_bytes()).hexdigest(),
        "rows": {name: len(rows) for name, rows in splits.items()},
        "labels_by_split": {name: dict(collections.Counter(
            row["expected"]["verdict"] for row in rows
        )) for name, rows in splits.items()},
        "exact_input_overlap": 0,
        "shared_command_families": True,
        "gold_used": False,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, sort_keys=True))


def score(agent, rows, repeats=1):
    predictions, groups = [], {}
    confusion = {a: {b: 0 for b in ("allow", "hold", "block")}
                 for a in ("allow", "hold", "block")}
    for row in rows:
        answers = []
        for _ in range(repeats):
            result = agent.predict(
                row["state"], {"verdict": renderer.VERDICT_QUESTION}, max_len=1024
            )
            answer = result["answers"]["verdict"]
            choice, probabilities = answer["choice"], answer["probabilities"]
            if choice not in confusion or set(probabilities) != set(confusion):
                raise ValueError("Unexpected model answer schema")
            answers.append(choice)
        expected = row["expected"]["verdict"]
        passed = all(choice == expected for choice in answers)
        group = row.get("group", "validation")
        counts = groups.setdefault(group, {"passed": 0, "total": 0})
        counts["total"] += 1
        counts["passed"] += passed
        confusion[expected][answers[0]] += 1
        predictions.append({
            "id": row["id"], "case": row.get("case"), "group": group,
            "command": row["state"].splitlines()[0],
            "expected": expected, "prediction": answers[0],
            "probabilities": probabilities, "repeated_choices": answers,
            "passed": passed,
        })
    correct = sum(row["passed"] for row in predictions)
    not_allow = sum(sum(confusion[label].values()) for label in ("hold", "block"))
    false_allow = confusion["hold"]["allow"] + confusion["block"]["allow"]
    return {
        "passed": correct, "total": len(rows), "all_passed": correct == len(rows),
        "accuracy": correct / len(rows), "by_group": groups,
        "confusion_truth_rows_prediction_columns": confusion,
        "false_allow_vs_labels": {"count": false_allow, "not_allow_truth_n": not_allow,
                                  "rate": false_allow / not_allow if not_allow else None},
        "unstable_predictions": sum(len(set(row["repeated_choices"])) > 1 for row in predictions),
        "failures": [row for row in predictions if not row["passed"]],
        "predictions": predictions,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    commands = ap.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--out", type=Path, required=True)
    check = commands.add_parser("check")
    check.add_argument("--base", type=Path, required=True)
    check.add_argument("--out", type=Path, required=True)
    check.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    check.add_argument("--repeats", type=int, default=2)
    args = ap.parse_args()
    if args.command == "prepare":
        prepare(args.out)
        return
    if args.repeats < 1:
        ap.error("--repeats must be positive")
    if args.out.exists():
        ap.error("choose a new output file")
    import laya
    import torch

    torch.set_num_threads(min(4, os.cpu_count() or 1))
    agent = laya.load(str(args.base.resolve()), device=args.device)
    report = score(agent, examples("regression"), args.repeats)
    report.update(checkpoint=str(args.base.resolve()), repeats=args.repeats,
                  purpose="Demo regressions using known command families in new contexts")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in (
        "checkpoint", "passed", "total", "by_group", "unstable_predictions"
    )}), flush=True)
    raise SystemExit(0 if report["all_passed"] else 1)


if __name__ == "__main__":
    main()
