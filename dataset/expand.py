"""Prepare and inspect a training-only expansion. Dataset commands remain inert text."""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import random
import secrets
from pathlib import Path


def sibling(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


p, r, audit = sibling("curate"), sibling("release"), sibling("audit")
c = p.c
ROOT = c.ROOT
PRIOR = ("pilot", "pilot-disruption-v1", "pilot-eval-additions-v1", "pilot-v2")


def read(path):
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def write(path, rows):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as f:
        for row in rows:
            c.write_json(f, row)
    temporary.replace(path)


def write_frozen(path, rows):
    if path.exists() and read(path) != rows:
        raise ValueError("Frozen annotation export changed; use a new revision: " + str(path))
    if not path.exists():
        write(path, rows)


def theme_review_page(path):
    """Follow T3's injected theme, or the browser preference in the standalone file."""
    page = path.read_text().replace(":root{color-scheme:light}", "")
    css = """
:root{color-scheme:light dark;--review-bg:#101215;--review-fg:#e8eaee;--review-card:#191c20;--review-border:#3b414b}
@media(prefers-color-scheme:light){:root{--review-bg:#f7f8fb;--review-fg:#172033;--review-card:#fff;--review-border:#cbd2df}}
html,body,header{background:var(--background,var(--review-bg));color:var(--foreground,var(--review-fg))}
pre,button,input,select,textarea{background:var(--card,var(--review-card));color:var(--foreground,var(--review-fg));border-color:var(--border,var(--review-border))}
button,input,select,textarea{max-width:100%;box-sizing:border-box;border-radius:6px}button{cursor:pointer}
.muted{color:var(--muted-foreground,var(--review-fg))}.done{color:var(--success,#38a56c)}
"""
    path.write_text(page.replace("</style>", css + "</style>", 1))


def prior_rows():
    return [row for name in PRIOR for row in read(ROOT / ".data" / name / "candidates.jsonl")]


def inventory(out):
    if (out / "manifest.json").exists():
        raise ValueError("Expansion is frozen; choose another output directory")
    prior = prior_rows()
    families = {row["split_family"] for row in prior}
    heldout_units = {row["split_unit"] for row in prior if row["split"] != "train"}
    counts, seen, eligible = collections.Counter(), set(), []
    for path in sorted((ROOT / ".data/seeds").glob("*.jsonl")):
        for line in path.open():
            seed = json.loads(line)
            prepared, errors = c.prepare(seed)
            errors += p.quality(seed, prepared) if prepared and not errors else []
            if errors:
                counts["quality_rejected"] += 1
                continue
            family = "family:" + c.digest(c.seeds.normalize(prepared["command"]))
            unit = p.unit(seed)
            if family in families:
                counts["prior_family"] += 1
                continue
            if unit in heldout_units or p.bucket(family) != "train" or p.bucket(unit) != "train":
                counts["heldout_or_split_conflict"] += 1
                continue
            if family in seen:
                counts["duplicate_family"] += 1
                continue
            seen.add(family)
            eligible.append((c.digest(seed), {"seed": seed, "prepared": prepared, "family": family, "unit": unit}))
            counts["eligible/" + seed["source"]] += 2
    out.mkdir(parents=True, exist_ok=True)
    write(out / "eligible-seeds.jsonl", [item for _, item in sorted(eligible)])
    report = {"counts": dict(counts), "eligible_pairs": len(eligible), "eligible_rows": len(eligible)*2}
    (out / "inventory.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


def prepare(out, target, workers, sample_size):
    if (out / "manifest.json").exists():
        raise ValueError("Expansion is frozen; choose another output directory")
    if target % 2 or target <= 0 or workers <= 0 or not 0 < sample_size <= target:
        raise ValueError("Need a positive even row target, positive workers, and a valid sample size")
    if not (out / "eligible-seeds.jsonl").exists():
        inventory(out)
    eligible = read(out / "eligible-seeds.jsonl")
    rng_seed = secrets.randbits(128)
    rng = random.Random(rng_seed)
    pools = collections.defaultdict(list)
    for item in eligible:
        pools[item["seed"]["source"]].append(item)
    for pool in pools.values():
        rng.shuffle(pool)
    # Equal source quotas where available, redistributed evenly when a source is exhausted.
    selected = []
    while len(selected) < target // 2:
        progressed = False
        for source in sorted(pools):
            if pools[source] and len(selected) < target // 2:
                selected.append(pools[source].pop())
                progressed = True
        if not progressed:
            raise ValueError("Insufficient eligible families for target")
    rng.shuffle(selected)
    prior = prior_rows()
    used_families = {row["split_family"] for row in prior}
    heldout_units = {row["split_unit"] for row in prior if row["split"] != "train"}
    used_states = {row["state_sha256"] for row in prior}
    rows = []
    for item in selected:
        family, unit = item["family"], item["unit"]
        if family in used_families or unit in heldout_units or p.bucket(family) != "train" or p.bucket(unit) != "train":
            raise ValueError("Inventory violates training allocation")
        used_families.add(family)
        pair = p.controlled_event(item["seed"], item["prepared"])
        for row in pair:
            row["id"] = "expansion-v1:" + c.digest([row["id"], row["state_sha256"]])
            row.update(split="train", source=item["seed"]["source"], split_family=family, split_unit=unit)
            if row["state_sha256"] in used_states:
                raise ValueError("Duplicate rendered state")
            used_states.add(row["state_sha256"])
        rows.extend(pair)
    # Parse-only checking, never evaluation/execution of commands.
    errors = audit.syntax_errors(rows)
    for row in rows:
        if row["id"] in errors:
            row["preannotation_rejection"] = "bash_syntax_error: " + errors[row["id"]]
    r.split_audit(prior + rows)
    sample = rng.sample(rows, sample_size)
    sample_ids = {row["id"] for row in sample}
    write(out / "candidates.jsonl", rows)
    write(out / "sample-selection.jsonl", [{"id": row["id"], "state_sha256": row["state_sha256"]} for row in sample])
    pairs = [rows[i:i+2] for i in range(0, len(rows), 2)]
    packets = []
    for worker in range(workers):
        shard = pairs[worker::workers]
        shard.sort(key=lambda pair: not any(row["id"] in sample_ids for row in pair))
        packet = [{"index": i, "rows": [{key: row[key] for key in ("id", "state_sha256", "state")}
                                           | ({"preannotation_rejection": row["preannotation_rejection"]} if "preannotation_rejection" in row else {})
                                           for row in pair]} for i, pair in enumerate(shard)]
        path = out / f"packet-{worker:02d}.jsonl"
        write(path, packet)
        packets.append({"packet": str(path), "pairs": len(shard), "rows": len(shard)*2,
                        "annotation_file": str(out / f"luna-annotations-{worker:02d}.jsonl"),
                        "sample_rows": sum(row["id"] in sample_ids for pair in shard for row in pair)})
    manifest = {"version": 1, "rows": len(rows), "pairs": len(pairs), "workers": packets,
                "counts_by_source": dict(collections.Counter(row["source"] for row in rows)),
                "random_seed": rng_seed, "review_sample_rows": len(sample),
                "sample_method": "uniform without replacement over all frozen candidate rows, before labels",
                "candidate_file_sha256": c.digest((out / "candidates.jsonl").read_text()),
                "sample_selection_sha256": c.digest((out / "sample-selection.jsonl").read_text()),
                "rubric_sha256": c.digest((ROOT / "dataset/RUBRIC.md").read_text()),
                "policy_sha256": c.digest((ROOT / "dataset/POLICY.md").read_text()),
                "parent_files": {name: c.digest((ROOT / ".data" / name / "candidates.jsonl").read_text()) for name in PRIOR},
                "protected_exports": {str(path.relative_to(ROOT)): c.digest(path.read_text())
                                      for path in (ROOT / ".data/pilot-v2/release").glob("*.jsonl")},
                "split_policy": "training only; novel family; no heldout source unit; family/unit train buckets; paired profiles stay together",
                "syntax_error_rows": len(errors), "dataset_commands_executed": False,
                "frozen_before_annotation": True, "training_or_evaluation_run": False}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


def collect(out, partial=False):
    manifest = json.loads((out / "manifest.json").read_text())
    for file, key in (("candidates.jsonl", "candidate_file_sha256"), ("sample-selection.jsonl", "sample_selection_sha256")):
        if c.digest((out / file).read_text()) != manifest[key]:
            raise ValueError("Frozen file changed: " + file)
    for name, expected in manifest["parent_files"].items():
        if c.digest((ROOT / ".data" / name / "candidates.jsonl").read_text()) != expected:
            raise ValueError("Parent candidate snapshot changed: " + name)
    for path, expected in manifest.get("protected_exports", {}).items():
        if c.digest((ROOT / path).read_text()) != expected:
            raise ValueError("Protected release export changed: " + path)
    for file, key in (("RUBRIC.md", "rubric_sha256"), ("POLICY.md", "policy_sha256")):
        if c.digest((ROOT / "dataset" / file).read_text()) != manifest[key]:
            raise ValueError("Annotation policy changed: " + file)
    rows = read(out / "candidates.jsonl")
    by_id = {row["id"]: row for row in rows}
    annotations = {}
    for index, worker in enumerate(manifest["workers"]):
        path = Path(worker.get("annotation_file", out / f"luna-annotations-{index:02d}.jsonl"))
        if not path.exists():
            continue
        packet = read(Path(worker["packet"]))
        start, stop = worker.get("index_start", 0), worker.get("index_stop", len(packet))
        owned_ids = {row["id"] for pair in packet[start:stop] for row in pair["rows"]}
        for a in read(path):
            if a["id"] not in owned_ids:
                raise ValueError("Annotation outside worker assignment: " + a["id"])
            if a["id"] not in by_id or a["id"] in annotations:
                raise ValueError("Unknown or duplicate annotation: " + a["id"])
            r.validate_annotation(by_id[a["id"]], a)
            if a["rationale"].strip().lower() in ("allow", "hold", "block", "reject"):
                raise ValueError("Label is not a semantic rationale: " + a["id"])
            if a.get("annotator") != "gpt-6-luna" or a.get("status") != "model_proposed":
                raise ValueError("Expected actual Luna proposal provenance")
            row = by_id[a["id"]]
            if row.get("preannotation_rejection") and a["disposition"] != "reject":
                raise ValueError("Syntax-invalid row was kept")
            annotations[a["id"]] = a
    missing = set(by_id) - set(annotations)
    if missing and not partial:
        raise ValueError(f"{len(missing)} annotations still pending")
    r.split_audit(prior_rows() + rows)
    ordered = [annotations[row["id"]] for row in rows if row["id"] in annotations]
    write(out / "proposals-current.jsonl", ordered)
    sample_ids = [a["id"] for a in read(out / "sample-selection.jsonl")]
    sample_rows = [by_id[i] for i in sample_ids if i in annotations]
    write(out / "sample-review.jsonl", [{"candidate": row, "annotation": annotations[row["id"]]} for row in sample_rows])
    r.review_page(sample_rows, annotations, out, split="train", filename="sample-review.html",
                  title="Random sample of Luna training proposals",
                  policy_note=f"Uniform random sample selected before labels: {len(sample_rows)} / {len(sample_ids)} available. "
                              "Approving this sample verifies only these rows. All new labels are model proposals; validation and gold are unchanged.")
    theme_review_page(out / "sample-review.html")
    counts = collections.Counter(a.get("label") or "reject" for a in ordered)
    report = {"candidate_rows": len(rows), "annotated_rows": len(ordered), "pending_rows": len(missing),
              "counts": {label: counts[label] for label in ("allow", "hold", "block", "reject")},
              "sample_available": len(sample_rows), "sample_total": len(sample_ids),
              "dataset_commands_executed": False, "independent_review": False, "human_verified": False,
              "training_or_evaluation_run": False, "validation_and_gold_unchanged": True,
              "label_status": "model_proposed", "release_ready": False}
    (out / "progress.json").write_text(json.dumps(report, indent=2) + "\n")
    if not missing and not partial:
        write_frozen(out / "proposals-frozen.jsonl", ordered)
        write_frozen(out / "train-proposed.jsonl", [{"id": row["id"], **c.renderer.training_row(row["event"], annotations[row["id"]]["label"])}
                                                    for row in rows if annotations[row["id"]]["disposition"] == "keep"])
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=ROOT / ".data/expansion-v1")
    ap.add_argument("--rows", type=int, default=10000)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--sample", type=int, default=30)
    ap.add_argument("--collect", action="store_true")
    ap.add_argument("--inventory", action="store_true")
    ap.add_argument("--partial", action="store_true")
    args = ap.parse_args()
    if args.inventory:
        inventory(args.out)
    elif args.collect:
        collect(args.out, args.partial)
    else:
        prepare(args.out, args.rows, args.workers, args.sample)
