"""Merge independent model review with proposals, preserving disagreements for adjudication.

Syntax-invalid shell rows are rejected structurally. A review never silently rewrites a model
label: corrections must validate and are recorded alongside the original proposal.
"""
from __future__ import annotations
import argparse
import collections
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def load_reviews(paths, overrides):
    reviews = {}
    for path in paths:
        for review in map(json.loads, path.read_text().splitlines()):
            if review["id"] in reviews:
                raise ValueError("duplicate review: " + review["id"])
            reviews[review["id"]] = review
    seen = set()
    for path in overrides:
        for review in map(json.loads, path.read_text().splitlines()):
            identity = review["id"]
            previous = reviews.get(identity)
            if identity in seen or not previous or previous.get("decision") != "dispute":
                raise ValueError("a follow-up review must replace a unique existing dispute")
            if previous["state_sha256"] != review["state_sha256"]:
                raise ValueError("follow-up review changed state")
            reviews[identity] = review
            seen.add(identity)
    return reviews


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pilot", type=Path, default=r.c.ROOT / ".data/pilot")
    ap.add_argument("--annotations", type=Path, nargs="+", required=True)
    ap.add_argument("--reviews", type=Path, nargs="*", default=[])
    ap.add_argument("--review-overrides", type=Path, nargs="*", default=[],
                    help="follow-up reviews of disputed rows, against the original proposal")
    args = ap.parse_args()
    rows = [json.loads(l) for l in (args.pilot / "candidates.jsonl").open()]
    by_id = {row["id"]: row for row in rows}
    annotations = r.load_annotations(args.annotations, rows)
    review_ids, changes = set(), []
    reviews = load_reviews(args.reviews, args.review_overrides)
    for review in reviews.values():
        identity = review["id"]
        if identity in review_ids or identity not in by_id:
            raise ValueError("duplicate or unknown review: " + identity)
        row, original = by_id[identity], annotations[identity]
        if review["state_sha256"] != row["state_sha256"] or not review.get("reviewer"):
            raise ValueError("stale or unattributed review")
        decision = review.get("decision")
        if decision == "agree":
            updated = dict(original)
        elif decision == "correct":
            updated = {**original, **review["annotation"]}
            if updated["id"] != identity:
                raise ValueError("review changed identity")
            r.validate_annotation(row, updated)
            changes.append({"id": identity, "from": original["label"], "to": updated["label"], "reason": updated["rationale"]})
        elif decision == "dispute":
            updated = {**original, "disposition": "reject", "harm": None, "settled": None,
                       "intended": None, "label": None, "rationale": "Unresolved model-review disagreement: " + review["reason"], "evidence": []}
            changes.append({"id": identity, "from": original["label"], "to": "disputed_excluded", "reason": review["reason"]})
        else:
            raise ValueError("unknown review decision")
        updated.update(status="model_reviewed", review=review, original_model_proposal=original)
        annotations[identity] = updated
        review_ids.add(identity)
    with (args.pilot / "reviews-final.jsonl").open("w") as f:
        for review in reviews.values():
            r.c.write_json(f, review)
    audit = json.loads((args.pilot / "audit.json").read_text())
    structural = 0
    for identity, error in audit["syntax_errors"].items():
        original = annotations[identity]
        if original["disposition"] != "reject":
            structural += 1
        annotations[identity] = {**original, "disposition": "reject", "harm": None, "settled": None,
                                 "intended": None, "label": None, "rationale": "Bash parse-only validation fails: " + error.splitlines()[-1],
                                 "evidence": [], "status": "model_reviewed", "structural_rejection": True,
                                 "original_model_proposal": original}
    with (args.pilot / "annotations-final.jsonl").open("w") as f:
        for row in rows:
            a = annotations[row["id"]]
            r.validate_annotation(row, a)
            r.c.write_json(f, a)
    report = {"total": len(rows), "independently_reviewed": len(review_ids),
              "review_inputs": [{"path": str(p), "sha256": r.c.digest(p.read_text())}
                                for p in args.reviews + args.review_overrides],
              "structural_rejections_overriding_model": structural, "changes": changes,
              "labels": collections.Counter(a["label"] or "reject" for a in annotations.values()),
              "unreviewed_model_proposals": sum(a["status"] == "model_proposed" for a in annotations.values()),
              "human_verified": False}
    (args.pilot / "adjudication.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "changes"}, sort_keys=True))


if __name__ == "__main__":
    main()
