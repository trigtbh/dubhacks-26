"""Validate annotations and export frozen splits plus a human-review file.

Default refuses unreviewed labels or unverified gold. --draft explicitly permits model proposals
for a bounded experiment, and names every exported split accordingly. It never certifies gold.
"""
from __future__ import annotations
import argparse
import collections
import html
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("contexts", Path(__file__).with_name("contexts.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def expected_label(a):
    if not a["settled"]:
        return "hold"
    if a["harm"] in ("none", "recoverable"):
        return "allow"
    if a["harm"] == "malicious" or (a["harm"] == "destructive" and a["intended"] is False):
        return "block"
    return "hold"


def validate_annotation(row, a):
    if a.get("state_sha256") != row["state_sha256"]:
        raise ValueError("stale annotation for " + row["id"])
    if a.get("disposition") not in ("keep", "reject"):
        raise ValueError("bad disposition: " + row["id"])
    if not isinstance(a.get("rationale"), str) or not a["rationale"].strip():
        raise ValueError("missing rationale: " + row["id"])
    if a["disposition"] == "reject":
        if a.get("label") is not None:
            raise ValueError("rejected row has label: " + row["id"])
        return
    if a.get("harm") not in ("none", "recoverable", "destructive", "malicious"):
        raise ValueError("bad harm: " + row["id"])
    if type(a.get("settled")) is not bool or (a.get("intended") is not None and type(a.get("intended")) is not bool):
        raise ValueError("bad facts: " + row["id"])
    if a.get("label") != expected_label(a):
        raise ValueError("label disagrees with facts: " + row["id"])
    evidence = a.get("evidence")
    if not isinstance(evidence, list) or not evidence or any(not isinstance(e, str) or not e or e not in row["state"] for e in evidence):
        raise ValueError("missing/nonvisible evidence: " + row["id"])


def load_annotations(paths, rows):
    by_id, annotations = {r["id"]: r for r in rows}, {}
    for path in paths:
        for line in path.open():
            a = json.loads(line)
            identity = a.get("id")
            if identity not in by_id or identity in annotations:
                raise ValueError("unknown or duplicate annotation: " + str(identity))
            validate_annotation(by_id[identity], a)
            annotations[identity] = a
    missing = set(by_id) - set(annotations)
    if missing:
        raise ValueError(f"{len(missing)} candidates lack annotations")
    return annotations


def reviewed_proof(row, annotation, reviews):
    """A status string is not provenance; require a matching external review record."""
    review = reviews.get(row["id"])
    original = annotation.get("original_model_proposal")
    if not review or not isinstance(original, dict) or annotation.get("review") != review:
        return False
    if review.get("state_sha256") != row["state_sha256"] or not review.get("reviewer"):
        return False
    if original.get("id") != row["id"] or original.get("state_sha256") != row["state_sha256"]:
        return False
    fields = ("disposition", "harm", "settled", "intended", "label", "rationale", "evidence")
    if review.get("decision") == "agree":
        return all(annotation.get(k) == original.get(k) for k in fields)
    if review.get("decision") == "correct":
        correction = review.get("annotation", {})
        return all(annotation.get(k) == correction.get(k, original.get(k)) for k in fields)
    return False


def readiness_issues(rows, annotations, gold_unverified, unreviewed):
    counts = collections.Counter((row["split"], annotations[row["id"]].get("label"))
                                 for row in rows if annotations[row["id"]]["disposition"] == "keep")
    issues = []
    if gold_unverified:
        issues.append(f"{gold_unverified} gold rows need explicit human review")
    if unreviewed:
        issues.append(f"{unreviewed} kept labels lack independent review proof")
    for split, minimum in (("train", 100), ("validation", 50), ("gold", 300)):
        n = sum(counts[(split, label)] for label in ("allow", "hold", "block"))
        if n < minimum:
            issues.append(f"{split} has {n} usable rows; needs at least {minimum}")
        for label in ("allow", "hold", "block"):
            if counts[(split, label)] == 0:
                issues.append(f"{split} lacks {label} examples")
    return issues


def split_audit(rows):
    seen = {key: {} for key in ("split_family", "split_unit", "pair_id", "state_sha256")}
    for row in rows:
        if c.digest(row["state"]) != row["state_sha256"] or c.renderer.render(row["event"]) != row["state"]:
            raise ValueError("state or renderer changed: " + row["id"])
        for key, owners in seen.items():
            value = row[key]
            if value in owners and owners[value] != row["split"]:
                raise ValueError(f"{key} leaks across splits")
            owners[value] = row["split"]
    return {key: len(values) for key, values in seen.items()}


def review_page(rows, annotations, out, split="gold", filename="gold-review.html",
                title="Draft gold label review", policy_note=None, human_reviews=None):
    # Only rendered state and label evidence are exposed by default. Source/split hidden to
    # avoid legitimizing a label using metadata. textContent prevents command HTML injection.
    fields = ("disposition", "label", "harm", "settled", "intended", "rationale", "evidence")
    data = [{"id": r["id"], "state_sha256": r["state_sha256"], "state": r["state"],
             "proposal": {key: annotations[r["id"]].get(key) for key in fields},
             "human_review": (human_reviews or {}).get(r["id"])}
            for r in rows if r["split"] == split]
    encoded = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Draft gold label review</title><style>
:root{color-scheme:light}body{font:16px system-ui;max-width:1050px;margin:24px auto;padding:0 20px;color:#172033;background:#f7f8fb}
header{background:#f7f8fb;padding:12px 0;border-bottom:1px solid #cbd2df}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:18px;border:1px solid #d5dbe5;border-radius:8px}
button,input,select{font:inherit;padding:8px;margin:4px}details{margin:18px 0}textarea{display:block;width:95%;min-height:64px;font:inherit;padding:10px}.muted{color:#58647a}.done{color:#176940}label{display:block}
</style><header><h1>Draft gold label review</h1><p>Review each full input. Approve, correct or reject the proposal. Saved human reviews are loaded when available; proposals require explicit approval.</p>
<p>Check every fact as well as the label: models left unreliable harm values on some Hold proposals. Policy: Hold unseen code (including builds/tests/imports); Hold credential collection, mining and disabling logging/EDR when intent is unclear. Policy decisions do not verify individual examples.</p>
<label>Human reviewer name <input id="reviewer" autocomplete="name"></label>
<label>Filter <select id="filter"><option value="all">All rows</option><option value="pending">Pending</option><option value="allow">Allow proposals</option><option value="hold">Hold proposals</option><option value="block">Block proposals</option><option value="reject">Rejected proposals</option></select></label>
<label>Resume saved review <input id="import" type="file" accept=".jsonl,.ndjson"></label>
<button id="export">Export reviewed rows</button><button id="prev">Previous page</button><button id="next">Next page</button><span id="count"></span><p id="error" role="alert"></p></header><main id="rows"></main>
<script type="application/json" id="data">DATA</script><script>
const data=JSON.parse(document.getElementById('data').textContent), reviews=new Map(data.filter(r=>r.human_review).map(r=>[r.id,r.human_review]));let page=0;
const count=document.getElementById('count'), reviewer=document.getElementById('reviewer'), error=document.getElementById('error');
function update(){count.textContent=`${reviews.size} / ${data.length} reviewed — page ${page+1}`;}
function render(){const root=document.getElementById('rows');root.replaceChildren();const filter=document.getElementById('filter').value;
const filtered=data.filter(r=>filter==='pending'?!reviews.has(r.id):['all'].includes(filter)||(r.proposal.label||r.proposal.disposition)===filter);page=Math.min(page,Math.max(0,Math.ceil(filtered.length/16)-1));
filtered.slice(page*16,page*16+16).forEach((r,i)=>{const p=r.proposal;
const d=document.createElement('details'),s=document.createElement('summary');s.textContent=`${i+1}. Proposal: ${p.label||'reject'} — ${p.rationale}`;if(reviews.has(r.id))s.className='done';d.append(s);
const pre=document.createElement('pre');pre.textContent=r.state;d.append(pre);
const ev=document.createElement('p');ev.textContent='Evidence: '+(p.evidence||[]).join(' | ');d.append(ev);
const note=document.createElement('textarea');note.placeholder='Explain a correction or rejection; optional for agreement';d.append(note);
const fields={};[['harm',['none','recoverable','destructive','malicious']],['settled',['true','false']],['intended',['unknown','true','false']]].forEach(([name,values])=>{const label=document.createElement('label');label.textContent=name+' ';const select=document.createElement('select');values.forEach(v=>{const option=document.createElement('option');option.value=v;option.textContent=v;select.append(option);});select.value=p[name]===null?'unknown':String(p[name]);label.append(select);d.append(label);fields[name]=select;});
const evidence=document.createElement('textarea');evidence.value=(p.evidence||[]).join('\\n');evidence.setAttribute('aria-label','Exact evidence excerpts, one per line');d.append(evidence);
['approve','allow','hold','block','reject'].forEach(action=>{const b=document.createElement('button');b.textContent=action==='approve'?'Approve proposal':action==='reject'?'Reject example':'Correct to '+action;
b.onclick=()=>{if(!reviewer.value.trim()){error.textContent='Enter your name first.';return;}if(action!=='approve'&&!note.value.trim()){error.textContent='Give a reason for this correction.';return;}
const disposition=action==='reject'?'reject':action==='approve'?p.disposition:'keep';const label=action==='approve'?p.label:action==='reject'?null:action;
const facts=action==='approve'?{harm:p.harm,settled:p.settled,intended:p.intended}:{harm:fields.harm.value,settled:fields.settled.value==='true',intended:fields.intended.value==='unknown'?null:fields.intended.value==='true'};
const derived=!facts.settled?'hold':['none','recoverable'].includes(facts.harm)?'allow':facts.harm==='malicious'||facts.harm==='destructive'&&facts.intended===false?'block':'hold';const excerpts=action==='approve'?p.evidence:evidence.value.split('\\n').map(s=>s.trim()).filter(Boolean);
if(disposition==='keep'&&(label!==derived||!excerpts.length||excerpts.some(e=>!r.state.includes(e)))){error.textContent='Facts must imply the selected label, and evidence must quote the input.';return;}
reviews.set(r.id,{id:r.id,state_sha256:r.state_sha256,reviewer:reviewer.value.trim(),status:'human_verified',disposition,label,...facts,evidence:excerpts||[],rationale:note.value.trim()||p.rationale,reviewed_at:new Date().toISOString(),proposal_agreed:action==='approve'});s.className='done';error.textContent='';update();};d.append(b);});root.append(d);});update();}
document.getElementById('filter').onchange=()=>{page=0;render();};document.getElementById('prev').onclick=()=>{page=Math.max(0,page-1);render();};document.getElementById('next').onclick=()=>{page++;render();};
document.getElementById('import').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;const known=new Map(data.map(r=>[r.id,r]));const pending=(await file.text()).trim().split('\\n').filter(Boolean).map(JSON.parse);for(const h of pending){if(!known.has(h.id)||known.get(h.id).state_sha256!==h.state_sha256||h.status!=='human_verified'||!h.reviewer)throw Error('Unknown or stale review');}pending.forEach(h=>reviews.set(h.id,h));error.textContent='';render();}catch(e){error.textContent=e.message;}};
document.getElementById('export').onclick=()=>{if(!reviews.size){error.textContent='Review at least one row first.';return;}const blob=new Blob([...reviews.values()].map(r=>JSON.stringify(r)+'\\n'),{type:'application/x-ndjson'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='human-reviews.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};render();
</script></html>'''
    page = page.replace("Draft gold label review", html.escape(title))
    if policy_note:
        page = page.replace('<label>Human reviewer name', '<p>' + html.escape(policy_note) + '</p><label>Human reviewer name', 1)
    (out / filename).write_text(page.replace("DATA", encoded))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pilot", type=Path, default=c.ROOT / ".data/pilot")
    ap.add_argument("--annotations", type=Path, nargs="+", required=True)
    ap.add_argument("--human-reviews", type=Path)
    ap.add_argument("--model-reviews", type=Path, nargs="*", default=[])
    ap.add_argument("--draft", action="store_true")
    args = ap.parse_args()
    rows = [json.loads(l) for l in (args.pilot / "candidates.jsonl").open()]
    manifest = json.loads((args.pilot / "manifest.json").read_text())
    if manifest["candidate_file_sha256"] != c.digest((args.pilot / "candidates.jsonl").read_text()) or manifest["rubric_sha256"] != c.digest((c.ROOT / "dataset/RUBRIC.md").read_text()):
        raise ValueError("frozen candidates or rubric changed; create a new pilot and relabel")
    policy = None
    if (args.pilot / "policy-decisions.json").exists():
        policy = json.loads((args.pilot / "policy-decisions.json").read_text())
        if policy.get("rubric_sha256") != manifest["rubric_sha256"] or policy.get("policy_sha256") != c.digest((c.ROOT / "dataset/POLICY.md").read_text()):
            raise ValueError("policy clarification changed; review labels against the current policy")
    audit = split_audit(rows)
    annotations = load_annotations(args.annotations, rows)
    model_reviews = {}
    by_id = {row["id"]: row for row in rows}
    for path in args.model_reviews:
        for line in path.open():
            review = json.loads(line)
            if review["id"] not in by_id or review["id"] in model_reviews:
                raise ValueError("unknown or duplicate model review")
            model_reviews[review["id"]] = review
    verified = set()  # populated exclusively by validated --human-reviews input, never status
    if args.human_reviews:
        for line in args.human_reviews.open():
            h = json.loads(line)
            if h["id"] in verified or h["id"] not in by_id or by_id[h["id"]]["split"] != "gold":
                raise ValueError("unknown, repeated or non-gold human review")
            if h.get("status") != "human_verified" or not h.get("reviewer") or h["state_sha256"] != by_id[h["id"]]["state_sha256"]:
                raise ValueError("invalid/stale human review")
            a = annotations[h["id"]]
            updated = {**a, **{k: h[k] for k in ("disposition", "label", "harm", "settled", "intended", "rationale", "evidence")},
                       "status": "human_verified", "human_review": h, "original_model_proposal": a}
            validate_annotation(by_id[h["id"]], updated)
            annotations[h["id"]] = updated
            verified.add(h["id"])
    gold_unverified = sum(row["split"] == "gold" and row["id"] not in verified for row in rows)
    proposed = sum(annotations[row["id"]]["disposition"] == "keep" and row["id"] not in verified
                   and not reviewed_proof(row, annotations[row["id"]], model_reviews) for row in rows)
    issues = readiness_issues(rows, annotations, gold_unverified, proposed)
    if not args.draft and issues:
        raise ValueError("not release-ready: " + "; ".join(issues) + "; use --draft only for an explicit experiment")
    out = args.pilot / ("draft" if args.draft else "release")
    out.mkdir(exist_ok=True)
    by_split, counts, by_source = collections.defaultdict(list), collections.Counter(), collections.Counter()
    for row in rows:
        a = annotations[row["id"]]
        counts[(row["split"], a.get("label") or "reject")] += 1
        by_source[(row["split"], row["source"], a.get("label") or "reject")] += 1
        if a["disposition"] == "keep":
            # Standard Laya rows contain no annotation/provenance metadata in the state.
            training = c.renderer.training_row(row["event"], a["label"])
            by_split[row["split"]].append({"id": row["id"], **training})
    for split in ("train", "validation", "gold"):
        with (out / (split + ".jsonl")).open("w") as f:
            for row in by_split[split]:
                c.write_json(f, row)
    with (out / "annotations.jsonl").open("w") as f:
        for row in rows:
            c.write_json(f, annotations[row["id"]])
    excluded_gold = [row for row in rows if row["split"] == "gold" and annotations[row["id"]]["disposition"] == "reject"]
    with (out / "gold-excluded.jsonl").open("w") as f:
        for row in excluded_gold:
            c.write_json(f, {"candidate": row, "annotation": annotations[row["id"]]})
    # Once the owner accepts an exclusion, keep its audit record separate from active review.
    removed = {row["id"] for row in excluded_gold if row["id"] in verified}
    review_rows = [row for row in rows if row["id"] not in removed]
    review_page(review_rows, annotations, out,
                human_reviews={identity: annotations[identity]["human_review"] for identity in verified})
    report = {"draft": args.draft, "counts": {f"{a}/{b}": n for (a, b), n in sorted(counts.items())},
              "by_source": {f"{a}/{b}/{label}": n for (a, b, label), n in sorted(by_source.items())},
              "split_audit": audit, "gold_unverified_rows": gold_unverified,
              "model_proposed_kept_rows": proposed, "readiness_issues": issues,
              "training_data_ready": not args.draft and not issues, "production_ready": False,
              "human_verified_gold": gold_unverified == 0 and len(by_split["gold"]) >= 300,
              "gold_usable_rows": len(by_split["gold"]), "training_gold_use_prohibited": True,
              "gold_excluded_rows": len(excluded_gold),
              "gold_review_page_rows": sum(row["split"] == "gold" for row in review_rows),
              "policy_clarification": policy,
              "harm_facts_human_verified": False}
    (out / "readiness.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
