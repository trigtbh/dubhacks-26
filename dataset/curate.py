"""Prepare a bounded, blinded annotation pilot with frozen, purged group splits.

Nothing in source command text is executed. This is intentionally a short, single-line pilot;
complex scripts are quarantined instead of receiving labels from incomplete evidence.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import shlex
from pathlib import Path

import importlib.util
spec = importlib.util.spec_from_file_location("contexts", Path(__file__).with_name("contexts.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

ROOT = c.ROOT
HISTORIES = ("pwd", "id", "ls -la", "date", "uname -a", "df -h", "ps -o pid,comm -u $(id -u)")
TARGETS = {"train": 120, "validation": 20, "gold": 40}  # pairs per source


def bucket(key):
    n = c.pick(key, "pilot-split-v1", 100)
    return "train" if n < 70 else "validation" if n < 80 else "gold"


def unit(seed):
    meta = seed.get("meta") or {}
    source = seed["source"]
    if source == "tbench":
        return "task:" + str(meta["task"])
    if source == "ssh":
        return "ssh-session:" + str(meta["session_id"])
    if source == "art":
        return "art-technique:" + str(meta["technique"])
    if source == "tldr":
        return "tldr-tool:" + str(meta["tool"])
    return "family:" + c.digest(c.seeds.normalize(seed["command"]))


def quality(seed, prepared):
    command = prepared["command"]
    reasons = []
    if len(command) > 1200 or len(seed["command"]) >= c.seeds.MAX_CMD:
        reasons.append("long_or_source_truncated")
    if "\n" in command or "<<" in command:
        reasons.append("complex_multiline_pilot_exclusion")
    if re.search(r"[\x00-\x08\x0b-\x1f\x7f]", command):
        reasons.append("control_characters")
    if prepared["warnings"]:
        reasons += prepared["warnings"]
    if re.search(r"redcanary|atomic.red.team|\bTBENCH\b|PathToAtomicsFolder|#\{\w+\}", command, re.I):
        reasons.append("source_fingerprint_or_template")
    if re.match(r"\s*(?:import\s|from\s|def\s|class\s|print\(|>>>|[}\]])", command):
        reasons.append("non_shell_fragment")
    try:
        words = shlex.split(command)
        if not words:
            reasons.append("empty_command")
    except ValueError:
        reasons.append("unbalanced_quotes")
    return sorted(set(reasons))


def controlled_event(seed, prepared):
    rows = list(c.candidates(seed, prepared, 42, 2))
    command = prepared["command"]
    key = ["pilot-controlled-v1", command]
    k = c.pick(key, "history_length", 6)
    bank = sorted(HISTORIES, key=lambda h: c.digest([key, h]))
    cwd = c.CWD[c.pick(key, "cwd", len(c.CWD))]
    for row in rows:
        event = row["event"]
        event["recent"] = list(bank[:k])
        if c.pick(key, "cwd_missing", 6) == 0:
            event.pop("cwd", None)
        else:
            event["cwd"] = cwd
        row["id"] = "pilot-v1:" + c.digest([row["id"], event])
        row["cohort"] = "controlled_context"
        row["provenance"]["pilot_context"] = {
            "history": "synthetic_source_independent", "source_history_used": False,
            "cwd": "synthetic_or_masked_source_independent",
        }
        row["state"] = c.renderer.render(event)
        row["state_sha256"] = c.digest(row["state"])
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=ROOT / ".data" / "pilot")
    ap.add_argument("--train-pairs-per-source", type=int, default=120)
    args = ap.parse_args()
    if (args.out / "manifest.json").exists():
        ap.error("pilot is frozen; choose a new --out directory to prepare another revision")
    args.out.mkdir(parents=True, exist_ok=True)
    targets = dict(TARGETS, train=args.train_pairs_per_source)
    counts, rejected, purged = collections.Counter(), collections.Counter(), collections.Counter()
    pools = collections.defaultdict(list)
    for path in sorted((ROOT / ".data/seeds").glob("*.jsonl")):
        for line in path.open():
            seed = json.loads(line)
            prepared, errors = c.prepare(seed)
            errors += quality(seed, prepared) if prepared and not errors else []
            if errors:
                rejected.update(errors)
                continue
            family = "family:" + c.digest(c.seeds.normalize(prepared["command"]))
            source_unit = unit(seed)
            split = bucket(family)
            if bucket(source_unit) != split:
                purged[seed["source"]] += 1
                continue
            pools[(split, seed["source"])].append((c.digest(seed), seed, prepared, family, source_unit))
    selected, seen_family, seen_states = [], set(), set()
    deficits = {}
    for (split, source), pool in sorted(pools.items()):
        n = 0
        for _, seed, prepared, family, source_unit in sorted(pool):
            if n >= targets[split]:
                break
            # One seed per normalized family in the entire pilot; its two permission variants
            # remain together. This also prevents family duplication across sources.
            if family in seen_family:
                continue
            rows = controlled_event(seed, prepared)
            if any(r["state_sha256"] in seen_states for r in rows):
                continue
            seen_family.add(family)
            for row in rows:
                seen_states.add(row["state_sha256"])
                row.update(split=split, source=source, split_family=family, split_unit=source_unit)
                selected.append(row)
                counts[(split, source)] += 1
            n += 1
        if n < targets[split]:
            deficits[f"{split}/{source}"] = {"pairs": n, "target_pairs": targets[split]}
    # Freeze all splits before any label proposal. Blind packets reveal neither source nor split.
    selected.sort(key=lambda r: c.digest(r["id"]))
    with (args.out / "candidates.jsonl").open("w") as f:
        for row in selected:
            c.write_json(f, row)
    packets = []
    for offset in range(0, len(selected), 300):
        path = args.out / f"packet-{offset // 300:02d}.jsonl"
        with path.open("w") as f:
            for row in selected[offset:offset + 300]:
                c.write_json(f, {"id": row["id"], "state": row["state"], "state_sha256": row["state_sha256"]})
        packets.append(str(path))
    manifest = {
        "version": 1, "rubric_sha256": c.digest((ROOT / "dataset/RUBRIC.md").read_text()),
        "candidate_file_sha256": c.digest((args.out / "candidates.jsonl").read_text()),
        "counts": {f"{split}/{source}": n for (split, source), n in sorted(counts.items())},
        "total": len(selected), "deficits": deficits, "rejection_reasons": rejected,
        "split_conflicts_purged": purged, "packets": packets,
        "gold_status": "draft_awaiting_model_and_human_review",
        "split_policy": "family and source-unit hash buckets must agree; conflicts purged; family unique across selected seeds",
        "cohort": "controlled_context", "native_history_performance_claimed": False,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"out": str(args.out), "rows": len(selected), "counts": manifest["counts"], "deficits": deficits}))


if __name__ == "__main__":
    main()
