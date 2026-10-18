"""Prepare held-out examples and assemble a versioned dataset. Never executes dataset commands."""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
c = r.c
SOURCE = c.ROOT / "dataset/examples/evaluation-additions-v1.jsonl"


def read(path):
    return list(map(json.loads, path.read_text().splitlines()))


def write(path, rows):
    with path.open("w") as f:
        for row in rows:
            c.write_json(f, row)


def checked_rows(directory):
    path = directory / "candidates.jsonl"
    manifest = json.loads((directory / "manifest.json").read_text())
    if c.digest(path.read_text()) != manifest["candidate_file_sha256"]:
        raise ValueError("candidate snapshot changed: " + str(directory))
    if manifest["rubric_sha256"] != c.digest((c.ROOT / "dataset/RUBRIC.md").read_text()):
        raise ValueError("annotation rubric changed: " + str(directory))
    rows = read(path)
    r.split_audit(rows)
    return rows


def prepare(out, parent, supplement):
    if (out / "manifest.json").exists():
        raise ValueError("additions are frozen; choose a new --additions")
    prior = checked_rows(parent) + checked_rows(supplement)
    families = {row["split_family"]: row["split"] for row in prior}
    new = []
    for case in read(SOURCE):
        family = "family:" + c.digest(c.seeds.normalize(case["command"]))
        if family in families:
            raise ValueError("new command duplicates an existing family: " + case["case"])
        for actor in case["actors"]:
            event = {"argv": ["/bin/bash", "-c", case["command"]], "path": "/bin/bash", "file": "/bin/bash",
                     "user": actor, "uid": 0 if actor == "root" else 1000, "cwd": "/srv/app",
                     "origin": {"type": "agent", "detail": "demo agent on host (initial network namespace)"},
                     "perms": {"account": "root" if actor == "root" else "human", "groups": [actor],
                               "sudo": "none", "caps": list(c.ALL_CAPS) if actor == "root" else []},
                     "recent": ["pwd", "id"]}
            state = c.renderer.render(event)
            new.append({"id": "eval-additions-v1:" + c.digest([case, event]), "event": event,
                        "state": state, "state_sha256": c.digest(state), "source": "synthetic_evaluation_v1",
                        "split": case["split"], "split_family": family,
                        "split_unit": "eval-mechanism:" + case["family"], "pair_id": "eval-case:" + c.digest(case),
                        "case": case["case"], "provenance": {"synthetic": True, "command_executed": False,
                        "allocation": "frozen_before_annotation", "mechanism_family": case["family"]}})
    r.split_audit(prior + new)
    out.mkdir(parents=True, exist_ok=True)
    write(out / "candidates.jsonl", new)
    write(out / "packet.jsonl", [{key: row[key] for key in ("id", "state", "state_sha256")} for row in new])
    manifest = {"candidate_file_sha256": c.digest((out / "candidates.jsonl").read_text()),
                "rubric_sha256": c.digest((c.ROOT / "dataset/RUBRIC.md").read_text()),
                "source_sha256": c.digest(SOURCE.read_text()), "rows": len(new),
                "splits_frozen_before_annotation": True, "dataset_commands_executed": False}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, sort_keys=True))


def merge(out, parent, supplement, additions):
    if (out / "manifest.json").exists():
        raise ValueError("combined snapshot is frozen; choose a new --out")
    new_manifest = json.loads((additions / "manifest.json").read_text())
    if new_manifest["source_sha256"] != c.digest(SOURCE.read_text()):
        raise ValueError("new example source changed after allocation")
    accepted = json.loads((supplement / "owner-approval.json").read_text())
    if (accepted.get("accepted") is not True
            or accepted.get("annotations_sha256") != c.digest((supplement / "annotations-final.jsonl").read_text())
            or accepted.get("policy_sha256") != c.digest((c.ROOT / "dataset/DISRUPTION_POLICY.md").read_text())):
        raise ValueError("training supplement approval no longer matches its labels/policy")
    rows, annotations, reviews, lineage, excluded = [], {}, {}, [], []
    for directory in (parent, supplement, additions):
        candidates = checked_rows(directory)
        labels = r.load_annotations([directory / "annotations-final.jsonl"], candidates)
        external = {x["id"]: x for x in read(directory / "reviews-final.jsonl")}
        # Parent human decisions can correct or reject a model label; carry those decisions
        # separately through the external human registry, not a self-asserted status flag.
        approved = {x["id"]: x for x in read(parent / "human-reviews.jsonl")} if directory == parent else {}
        for row in candidates:
            a = labels[row["id"]]
            if row["id"] in approved:
                h = approved[row["id"]]
                r.validate_annotation(row, h)
                if h["disposition"] != a["disposition"] or h["label"] != a["label"]:
                    raise ValueError("human/model label changed; explicitly rebase before merging")
            if a["disposition"] != "keep":
                excluded.append({"candidate": row, "annotation": a})
                continue
            if row["id"] in annotations or not r.reviewed_proof(row, a, external):
                raise ValueError("duplicate ID or missing external review proof")
            rows.append(row)
            annotations[row["id"]], reviews[row["id"]] = a, external[row["id"]]
        lineage.append({"directory": str(directory), "candidate_sha256": c.digest((directory / "candidates.jsonl").read_text()),
                        "annotation_sha256": c.digest((directory / "annotations-final.jsonl").read_text()),
                        "review_sha256": c.digest((directory / "reviews-final.jsonl").read_text())})
    audit = r.split_audit(rows)
    out.mkdir(parents=True, exist_ok=True)
    write(out / "candidates.jsonl", rows)
    write(out / "annotations-final.jsonl", [annotations[row["id"]] for row in rows])
    write(out / "reviews-final.jsonl", [reviews[row["id"]] for row in rows])
    write(out / "excluded-history.jsonl", excluded)
    gold_ids = {row["id"] for row in rows if row["split"] == "gold"}
    human = [h for h in read(parent / "human-reviews.jsonl") if h["id"] in gold_ids]
    write(out / "human-reviews.jsonl", human)
    manifest = {"candidate_file_sha256": c.digest((out / "candidates.jsonl").read_text()),
                "rubric_sha256": c.digest((c.ROOT / "dataset/RUBRIC.md").read_text()),
                "lineage": lineage, "human_review_sha256": c.digest((out / "human-reviews.jsonl").read_text()),
                "retained_human_reviews": len(human), "split_audit": audit,
                "training_changed": False, "gold_used_for_training": False,
                "supplement_owner_approval": accepted}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (out / "policy-decisions.json").write_bytes((parent / "policy-decisions.json").read_bytes())
    addition_ids = {row["id"] for row in checked_rows(additions)}
    new_gold = [row for row in rows if row["id"] in addition_ids and row["split"] == "gold"]
    r.review_page(new_gold, annotations, out, filename="new-gold-review.html", title="New gold examples",
                  policy_note="Only the new gold additions are shown here. Your previous 384 gold approvals are preserved. "
                              "These new labels are model-reviewed and still need your approval; no command was executed.")
    print(json.dumps({"rows": len(rows), "retained_human_reviews": len(human), "split_audit": audit}, sort_keys=True))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--parent", type=Path, default=c.ROOT / ".data/pilot")
    ap.add_argument("--supplement", type=Path, default=c.ROOT / ".data/pilot-disruption-v1")
    ap.add_argument("--additions", type=Path, default=c.ROOT / ".data/pilot-eval-additions-v1")
    ap.add_argument("--out", type=Path, default=c.ROOT / ".data/pilot-v2")
    ap.add_argument("--merge", action="store_true")
    args = ap.parse_args()
    if args.merge:
        merge(args.out, args.parent, args.supplement, args.additions)
    else:
        prepare(args.additions, args.parent, args.supplement)


if __name__ == "__main__":
    main()
