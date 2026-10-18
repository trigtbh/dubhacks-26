"""Integrity checks for curation, annotation evidence, grouping, and evaluation metrics."""
import importlib.util
import contextlib
import io
import unittest
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


curate, release, evaluate, finetune = load("curate"), load("release"), load("evaluate"), load("finetune")
adjudicate = load("adjudicate")


class PilotTests(unittest.TestCase):
    def row(self):
        seed = {"id": "a", "source": "nl2bash", "command": "cat input.txt", "history": [], "meta": {}}
        prepared, errors = curate.c.prepare(seed)
        self.assertFalse(errors)
        row = curate.controlled_event(seed, prepared)[0]
        row.update(split="train", split_unit="unit", split_family="family")
        return row

    def annotation(self, row):
        return {"id": row["id"], "state_sha256": row["state_sha256"], "disposition": "keep",
                "harm": "none", "settled": True, "intended": None, "label": "allow",
                "rationale": "Read an ordinary named file.", "evidence": ["cat input.txt"]}

    def test_exact_evidence_and_label_derivation(self):
        row = self.row()
        a = self.annotation(row)
        release.validate_annotation(row, a)
        with self.assertRaises(ValueError):
            release.validate_annotation(row, {**a, "evidence": ["not in state"]})
        with self.assertRaises(ValueError):
            release.validate_annotation(row, {**a, "label": "block"})
        with self.assertRaises(ValueError):
            release.validate_annotation(row, {**a, "state_sha256": "old"})
        self.assertEqual(release.expected_label({**a, "settled": False}), "hold")
        self.assertEqual(release.expected_label({**a, "harm": "destructive", "intended": None}), "hold")

    def test_no_split_leakage_or_stale_rendering(self):
        row = self.row()
        self.assertEqual(release.split_audit([row])["pair_id"], 1)
        with self.assertRaises(ValueError):
            release.split_audit([row, {**row, "split": "gold"}])
        with self.assertRaises(ValueError):
            release.split_audit([{**row, "state": row["state"] + "changed"}])

    def test_controlled_history_does_not_depend_on_source(self):
        seed = {"id": "a", "source": "nl2bash", "command": "cat input.txt", "history": [], "meta": {}}
        other = {**seed, "id": "b", "source": "ssh", "history": ["cd /root", "sudo su"]}
        a = curate.controlled_event(seed, curate.c.prepare(seed)[0])
        b = curate.controlled_event(other, curate.c.prepare(other)[0])
        self.assertEqual([r["event"] for r in a], [r["event"] for r in b])

    def test_metrics_use_harm_denominators(self):
        records = [
            {"label": "hold", "harm": "destructive", "prediction": "allow", "probabilities": {"allow": 1, "hold": 0, "block": 0}},
            {"label": "allow", "harm": "none", "prediction": "block", "probabilities": {"allow": 0, "hold": 0, "block": 1}},
            {"label": "hold", "harm": "none", "prediction": "hold", "probabilities": {"allow": 0, "hold": 1, "block": 0}},
        ]
        report = evaluate.metrics(records)
        self.assertEqual(report["unsafe_allow"], {"count": 1, "harmful_n": 1, "rate": 1})
        self.assertEqual(report["benign_block"], {"count": 1, "benign_n": 2, "rate": .5})
        self.assertEqual(report["accuracy"], 1 / 3)
        self.assertIsNone(evaluate.metrics([])["unsafe_allow"]["rate"])

    def test_status_cannot_self_certify_review(self):
        row = self.row()
        a = {**self.annotation(row), "status": "human_verified"}
        self.assertFalse(release.reviewed_proof(row, a, {}))
        review = {"id": row["id"], "state_sha256": row["state_sha256"], "decision": "agree", "reviewer": "independent-model"}
        reviewed = {**a, "status": "model_reviewed", "review": review, "original_model_proposal": a}
        self.assertFalse(release.reviewed_proof(row, reviewed, {}))
        self.assertTrue(release.reviewed_proof(row, reviewed, {row["id"]: review}))

    def test_followup_only_replaces_disputes_for_the_same_state(self):
        row = self.row()
        review = {"id": row["id"], "state_sha256": row["state_sha256"], "decision": "dispute"}
        corrected = {**review, "decision": "correct", "annotation": self.annotation(row)}
        with tempfile.TemporaryDirectory() as directory:
            original, override = Path(directory) / "original.jsonl", Path(directory) / "override.jsonl"
            original.write_text(json.dumps(review) + "\n")
            override.write_text(json.dumps(corrected) + "\n")
            self.assertEqual(adjudicate.load_reviews([original], [override])[row["id"]], corrected)
            override.write_text(json.dumps({**corrected, "state_sha256": "stale"}) + "\n")
            with self.assertRaises(ValueError):
                adjudicate.load_reviews([original], [override])
            original.write_text(json.dumps({**review, "decision": "agree"}) + "\n")
            override.write_text(json.dumps(corrected) + "\n")
            with self.assertRaises(ValueError):
                adjudicate.load_reviews([original], [override])

    def test_model_label_agreement_does_not_certify_harm_metrics(self):
        row = {**self.row(), "source": "nl2bash"}
        a = {**self.annotation(row), "harm": "destructive", "settled": False, "label": "hold"}
        score = {"id": row["id"], "state_sha256": row["state_sha256"], "prediction": "allow",
                 "probabilities": {"allow": 1, "hold": 0, "block": 0}}
        report = evaluate.summarize([row], [a], {row["id"]: score})
        self.assertFalse(report["harm_metrics_available"])
        self.assertIsNone(report["metrics"]["train"]["unsafe_allow"])
        self.assertIsNone(report["metrics"]["train"]["benign_block"])
        self.assertEqual(report["metrics"]["train"]["false_allow_vs_labels"]["count"], 1)

    def test_training_refuses_gold_even_through_custom_paths(self):
        row = self.row()
        exported = {"id": row["id"], **release.c.renderer.training_row(row["event"], "allow")}
        candidates = {row["id"]: row}
        annotations = {row["id"]: self.annotation(row)}
        finetune.verify_split([exported], candidates, annotations, "train")
        with self.assertRaises(ValueError):
            finetune.verify_split([exported], {row["id"]: {**row, "split": "gold"}}, annotations, "train")
        with self.assertRaises(ValueError):
            finetune.verify_split([exported], candidates, annotations, "validation")
        with self.assertRaises(ValueError):
            finetune.verify_split([], candidates, annotations, "validation")
        with self.assertRaises(ValueError):
            finetune.verify_split([exported, exported], candidates, annotations, "train")
        with self.assertRaises(ValueError):
            finetune.verify_split([exported], candidates, {row["id"]: {**annotations[row["id"]], "label": "block"}}, "train")

    def test_training_stdout_is_logged_and_progress_survives_redirect(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            console = io.StringIO()
            with contextlib.redirect_stdout(console):
                progress = finetune.Progress(out, total_steps=20, total_updates=6, grad_accum=4, epochs=2)
                try:
                    with contextlib.redirect_stdout(progress):
                        print("epoch 2/2 step 10 loss 0.25")
                        print("epoch 2/2 mean loss 0.3")
                        sys.stdout.flush()
                    self.assertIs(sys.stdout, console)
                finally:
                    progress.log.close()
            state = json.loads((out / "progress.json").read_text())
            self.assertEqual(state["micro_step"], 20)
            self.assertEqual(state["optimizer_update"], 6)
            self.assertEqual(state["epoch_mean_losses"], [0.3])
            self.assertEqual((out / "train.log").read_text(), console.getvalue())

    def test_empty_or_rejected_gold_is_not_ready(self):
        row = {**self.row(), "split": "gold"}
        a = {**self.annotation(row), "status": "human_verified", "disposition": "reject", "label": None}
        issues = release.readiness_issues([row], {row["id"]: a}, 0, 0)
        self.assertIn("gold has 0 usable rows; needs at least 300", issues)
        self.assertIn("gold lacks block examples", issues)

    def test_cli_refuses_self_asserted_human_status(self):
        row = {**self.row(), "split": "gold"}
        a = {**self.annotation(row), "status": "human_verified"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidates = root / "candidates.jsonl"
            candidates.write_text(json.dumps(row) + "\n")
            (root / "manifest.json").write_text(json.dumps({
                "candidate_file_sha256": release.c.digest(candidates.read_text()),
                "rubric_sha256": release.c.digest((release.c.ROOT / "dataset/RUBRIC.md").read_text())}))
            annotations = root / "a.jsonl"
            annotations.write_text(json.dumps(a) + "\n")
            result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("release.py")),
                                     "--pilot", str(root), "--annotations", str(annotations)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("gold rows need explicit human review", result.stderr)
            self.assertFalse((root / "release").exists())

    def test_review_page_keeps_command_html_inert(self):
        row = {**self.row(), "split": "gold", "state": '</script><img src=x onerror="alert(1)">'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release.review_page([row], {row["id"]: self.annotation(row)}, root)
            page = (root / "gold-review.html").read_text()
            self.assertNotIn('<img src=x', page)
            self.assertIn('\\u003cimg', page)

    def test_supplement_review_stays_training_only_and_escapes_policy(self):
        row = self.row()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release.review_page([row], {row["id"]: self.annotation(row)}, root,
                                split="train", filename="review.html", title="Supplement review",
                                policy_note="Proposed policy <needs review>")
            page = (root / "review.html").read_text()
            self.assertIn("Supplement review", page)
            self.assertIn("Proposed policy &lt;needs review&gt;", page)
            embedded = page.split('<script type="application/json" id="data">', 1)[1].split('</script>', 1)[0]
            data = json.loads(embedded)
            self.assertEqual([x["id"] for x in data], [row["id"]])
            self.assertNotIn("original_model_proposal", data[0]["proposal"])
            self.assertFalse((root / "gold-review.html").exists())


if __name__ == "__main__":
    unittest.main()
