"""Assemble Haiku-generated gen-*.jsonl into candidate/annotation rows for Laya training.

Validates every evidence substring, enforces the label/fact schema via release.py, rejects
family collisions with any existing dataset and any overlap with frozen validation/gold splits,
and splits the kept Block rows into a train pool and a separate review-pending validation pool.
Nothing here is executed as a command; rows are inert text.
"""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path("/homes/iws/tmoore23/dubhacks-26")
OUT = ROOT / ".data/block-proposals-haiku-v1"


def sib(n):
    s = importlib.util.spec_from_file_location(n, ROOT / "dataset" / (n + ".py"))
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


con = sib("contexts")
rel = sib("release")
digest = con.digest
norm = con.seeds.normalize


def family(cmd):
    return "family:" + digest(norm(cmd))


PROFILES = {
    "dev": ("dev", 1000, "human", ["dev"], "none", False),
    "service": ("app", 998, "service", ["app"], "none", False),
    "root": ("root", 0, "root", ["root"], "unknown", False),
    "sudo-dev": ("dev", 1000, "human", ["dev", "sudo"], "all (password)", True),
}
VALID_ORIGINS = {"local", "ssh", "agent", "service"}


def build_row(src, idx):
    """Turn one generator record into (candidate, annotation) or raise with a reason."""
    cmd = src["command"]
    if not isinstance(cmd, str) or not cmd.strip() or len(cmd) > 2000:
        raise ValueError("bad command")
    ctx = src.get("context") or {}
    prof = PROFILES.get(ctx.get("profile", "dev"))
    if prof is None:
        raise ValueError("bad profile")
    origin = ctx.get("origin", "local")
    if origin not in VALID_ORIGINS:
        raise ValueError("bad origin")
    history = ctx.get("history") or []
    if not isinstance(history, list) or any(not isinstance(h, str) for h in history):
        raise ValueError("bad history")
    ev = {"argv": ["/bin/bash", "-c", cmd], "path": "/bin/bash", "file": "/bin/bash",
          "user": prof[0], "uid": prof[1],
          "perms": {"account": prof[2], "groups": prof[3], "sudo": prof[4], "under_sudo": prof[5], "caps": []},
          "origin": {"type": origin}, "recent": history[:5]}
    cwd = ctx.get("cwd")
    if cwd:
        ev["cwd"] = cwd
    state = con.renderer.render(ev)
    sh = digest(state)
    rid = "block-proposals-haiku-v1:" + digest({"command": cmd, "event": ev})
    label = src["label"]
    harm = src["harm"]
    settled = bool(src["settled"])
    intended = src.get("intended")
    row = {"id": rid, "event": ev, "state": state, "state_sha256": sh,
           "source": "synthetic_haiku_block_v1", "split": "train", "split_family": family(cmd),
           "split_unit": "synthetic-haiku-v1:" + str(src.get("mechanism", "unknown")),
           "pair_id": "pair:haiku:" + str(src.get("pair") or rid.split(":", 1)[1]),
           "case": f"haiku-{idx:04d}",
           "provenance": {"synthetic": True, "generator_model": "claude-haiku-5-5", "command_executed": False}}
    a = {"id": rid, "state_sha256": sh, "disposition": "keep", "harm": harm, "settled": settled,
         "intended": (False if label == "block" else (None if label != "block" and intended is None else intended)),
         "label": label, "rationale": src.get("rationale", ""), "evidence": src.get("evidence", []),
         "annotator": "claude-haiku-5-5", "status": "model_proposed"}
    # Normalize intended to the schema the rubric expects.
    a["intended"] = False if label == "block" else None
    rel.validate_annotation(row, a)
    if rel.expected_label(a) != label:
        raise ValueError("label disagrees with facts")
    return row, a


def load_protected():
    protected, oldstates, existing = set(), set(), {}
    for d in ("pilot", "pilot-disruption-v1", "pilot-eval-additions-v1", "pilot-v2",
              "expansion-v1", "block-proposals-v1", "block-proposals-opus-v1"):
        path = ROOT / ".data" / d / "candidates.jsonl"
        if not path.exists():
            continue
        for line in path.open():
            old = json.loads(line)
            try:
                existing[family(con.renderer.command_text(old["event"]))] = d
            except Exception:
                pass
            if old.get("split") in ("validation", "gold"):
                protected.update({old.get("split_family"), old.get("split_unit"), old.get("pair_id")})
                oldstates.add(old.get("state_sha256"))
    return existing, protected, oldstates


def main():
    existing, protected, oldstates = load_protected()
    rows, anns, rejects = [], [], []
    seen_state = set()
    for path in sorted(OUT.glob("gen-*.jsonl")):
        for n, line in enumerate(path.open()):
            line = line.strip()
            if not line:
                continue
            try:
                src = json.loads(line)
                row, a = build_row(src, len(rows))
            except Exception as e:
                rejects.append({"file": path.name, "line": n, "reason": repr(e)})
                continue
            if row["state_sha256"] in seen_state or row["state_sha256"] in oldstates:
                rejects.append({"file": path.name, "line": n, "reason": "duplicate/overlap state"})
                continue
            if row["split_family"] in protected or row["split_unit"] in protected or row["pair_id"] in protected:
                rejects.append({"file": path.name, "line": n, "reason": "protected-split overlap"})
                continue
            if row["split_family"] in existing:
                rejects.append({"file": path.name, "line": n, "reason": f"family collision with {existing[row['split_family']]}"})
                continue
            seen_state.add(row["state_sha256"])
            rows.append(row)
            anns.append(a)

    # Hold out ~20% of distinct Block families for a review-pending validation pool; keep pairs together.
    block_fams = sorted({r["split_family"] for r, a in zip(rows, anns) if a["label"] == "block"})
    holdout = {f for i, f in enumerate(block_fams) if i % 5 == 0}
    for r in rows:
        if r["split_family"] in holdout:
            r["split"] = "validation_pending_review"

    def dump(name, items):
        (OUT / name).write_text("".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in items))

    dump("candidates.jsonl", rows)
    dump("proposals.jsonl", anns)
    dump("rejects.jsonl", rejects)
    train = [r for r in rows if r["split"] == "train"]
    counts = {}
    for r, a in zip(rows, anns):
        counts.setdefault(r["split"], {}).setdefault(a["label"], 0)
        counts[r["split"]][a["label"]] += 1
    report = {"generated_files": sorted(p.name for p in OUT.glob("gen-*.jsonl")),
              "kept": len(rows), "rejected": len(rejects), "counts_by_split_label": counts,
              "distinct_block_families": len(block_fams), "holdout_block_families": len(holdout),
              "train_rows": len(train)}
    dump("report.jsonl", [report])
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    sys.exit(main())
