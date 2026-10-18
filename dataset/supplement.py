"""Prepare/export a small training-only supplement. Dataset commands are never executed."""
from __future__ import annotations
import argparse
import collections
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
c = r.c
SOURCE = c.ROOT / "dataset/examples/disruption-v1.jsonl"
POLICY = c.ROOT / "dataset/DISRUPTION_POLICY.md"


def prepare(out, parent):
    if (out / "manifest.json").exists():
        raise ValueError("supplement is frozen; choose a new --out")
    old = list(map(json.loads, (parent / "candidates.jsonl").read_text().splitlines()))
    old_families = {x["split_family"] for x in old}
    rows = []
    for case in map(json.loads, SOURCE.read_text().splitlines()):
        family = "family:" + c.digest(c.seeds.normalize(case["command"]))
        if family in old_families:
            raise ValueError("command family overlaps frozen pilot: " + case["case"])
        for actor in ("root", "dev"):
            event = {"argv": ["/bin/bash", "-c", case["command"]], "path": "/bin/bash", "file": "/bin/bash",
                     "user": actor, "uid": 0 if actor == "root" else 1000, "cwd": "/srv/app",
                     "origin": {"type": "agent", "detail": "demo agent on host (initial network namespace)"},
                     "perms": {"account": "root" if actor == "root" else "human", "groups": [actor],
                               "sudo": "none", "caps": list(c.ALL_CAPS) if actor == "root" else ["cap_net_admin"]},
                     "recent": ["pwd", "id"]}
            state = c.renderer.render(event)
            rows.append({"id": "disruption-v1:" + c.digest([case, event]), "event": event,
                         "state": state, "state_sha256": c.digest(state), "source": "synthetic_disruption_v1",
                         "split": "train", "split_family": family, "split_unit": "synthetic-disruption:" + case["family"],
                         "pair_id": "disruption-pair:" + c.digest(case), "case": case["case"],
                         "provenance": {"synthetic": True, "command_executed": False,
                                        "policy_sha256": c.digest(POLICY.read_text()), "policy_human_confirmed": False}})
    r.split_audit(old + rows)
    out.mkdir(parents=True, exist_ok=True)
    with (out / "candidates.jsonl").open("w") as f, (out / "packet.jsonl").open("w") as packet:
        for row in rows:
            c.write_json(f, row)
            c.write_json(packet, {k: row[k] for k in ("id", "state", "state_sha256")})
    manifest = {"candidate_file_sha256": c.digest((out / "candidates.jsonl").read_text()),
                "rubric_sha256": c.digest((c.ROOT / "dataset/RUBRIC.md").read_text()),
                "policy_sha256": c.digest(POLICY.read_text()), "source_sha256": c.digest(SOURCE.read_text()),
                "parent_candidates_sha256": c.digest((parent / "candidates.jsonl").read_text()),
                "rows": len(rows), "cases": len(rows) // 2, "allocation": "training_only",
                "human_verified": False, "policy_human_confirmed": False, "frozen_pilot_modified": False}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, sort_keys=True))


def export(out, parent):
    manifest = json.loads((out / "manifest.json").read_text())
    checks = {"candidate_file_sha256": out / "candidates.jsonl", "policy_sha256": POLICY,
              "source_sha256": SOURCE, "parent_candidates_sha256": parent / "candidates.jsonl",
              "rubric_sha256": c.ROOT / "dataset/RUBRIC.md"}
    if any(manifest[key] != c.digest(path.read_text()) for key, path in checks.items()):
        raise ValueError("frozen supplement inputs/policy changed; prepare a new revision")
    rows = list(map(json.loads, (out / "candidates.jsonl").read_text().splitlines()))
    annotations = r.load_annotations([out / "annotations-final.jsonl"], rows)
    approval = json.loads((out / "owner-approval.json").read_text()) if (out / "owner-approval.json").exists() else {}
    owner_accepted = (approval.get("policy_sha256") == manifest["policy_sha256"]
                      and approval.get("annotations_sha256") == c.digest((out / "annotations-final.jsonl").read_text())
                      and approval.get("accepted") is True)
    reviews = {x["id"]: x for x in map(json.loads, (out / "reviews-final.jsonl").read_text().splitlines())}
    train, counts = [], collections.Counter()
    for row in rows:
        a = annotations[row["id"]]
        counts[a.get("label") or "excluded"] += 1
        if a["disposition"] == "keep":
            if not r.reviewed_proof(row, a, reviews):
                raise ValueError("kept label lacks external review proof: " + row["id"])
            train.append({"id": row["id"], **c.renderer.training_row(row["event"], a["label"])})
    with (out / "train-draft.jsonl").open("w") as f:
        for row in train:
            c.write_json(f, row)
    base_train = list(map(json.loads, (parent / "draft/train.jsonl").read_text().splitlines()))
    parent_rows = list(map(json.loads, (parent / "candidates.jsonl").read_text().splitlines()))
    parent_annotations = r.load_annotations([parent / "annotations-final.jsonl"], parent_rows)
    expected_train = {row["id"]: {"id": row["id"], **c.renderer.training_row(row["event"], parent_annotations[row["id"]]["label"])}
                      for row in parent_rows if row["split"] == "train" and parent_annotations[row["id"]]["disposition"] == "keep"}
    if len(base_train) != len(expected_train) or any(row != expected_train.get(row["id"]) for row in base_train):
        raise ValueError("parent training export is stale or incomplete")
    audit = r.split_audit(parent_rows + rows)
    combined = out / "train-with-pilot-draft.jsonl"
    with combined.open("w") as f:
        for row in base_train + train:
            c.write_json(f, row)
    r.review_page(rows, annotations, out, split="train", filename="review.html",
                  title="Disruption supplement review", policy_note=(
                      ("The owner accepted this supplement and its policy in chat. " if owner_accepted else "Supplement policy needs your confirmation: ") +
                      "Unbounded process creation and complete host-network "
                      "shutdown are forbidden for demo agents. These Block labels are conditional on that policy. "
                      "All examples are synthetic and training-only; none have been executed. Chat acceptance is recorded "
                      "separately from individual human-review records."))
    parent_readiness = json.loads((parent / "draft/readiness.json").read_text())
    gold_reviewed = parent_readiness.get("human_verified_gold") is True
    report = {"draft": True, "labels": counts, "new_rows": len(rows), "new_usable_rows": len(train),
              "combined_train_rows": len(base_train) + len(train), "combined_train_path": str(combined),
              "split_audit": audit, "original_validation_and_gold_unchanged": True,
              "human_verified": False, "policy_human_confirmed": owner_accepted,
              "owner_accepted_supplement": owner_accepted, "training_data_ready": False,
              "parent_gold_human_verified": gold_reviewed,
              "parent_training_sha256": c.digest((parent / "draft/train.jsonl").read_text()),
              "readiness_issues": ([] if owner_accepted else ["supplement policy and rows need human review"]) +
                                  ["frozen validation still has no Block positives"] +
                                  ([] if gold_reviewed else ["original gold remains unverified"])}
    (out / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, sort_keys=True))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=c.ROOT / ".data/pilot-disruption-v1")
    ap.add_argument("--parent", type=Path, default=c.ROOT / ".data/pilot")
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()
    (export if args.export else prepare)(args.out, args.parent)


if __name__ == "__main__":
    main()
