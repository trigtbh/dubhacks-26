"""Check fine-tune input selection and isolation without loading model weights."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("finetune", Path(__file__).with_name("finetune.py"))
finetune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(finetune)


class FineTuneTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.pilot = self.root / "pilot"
        self.release = self.pilot / "release"
        self.release.mkdir(parents=True)
        self.base = self.root / "base"
        self.out = self.root / "run"
        self.events = {split: {"argv": ["printf", split], "path": "/usr/bin/printf"}
                       for split in ("train", "validation", "gold")}
        self.write_release()

        # Exercise preflight and input writing without requiring installed ML packages.
        self.tokenizer = Mock()
        self.tokenizer.encode.side_effect = lambda state, **kwargs: state.split()
        tokenizers = types.ModuleType("tokenizers")
        tokenizers.Tokenizer = Mock()
        tokenizers.Tokenizer.from_file.return_value = self.tokenizer
        self.trainer = types.ModuleType("laya.train")
        self.trainer.TrainConfig = lambda **values: types.SimpleNamespace(
            **values, __dataclass_fields__=dict.fromkeys(values))
        self.trainer.dry_run = Mock(side_effect=lambda path, *args: {"rows_read": len(finetune.demo.read(Path(path)))})
        self.trainer.finetune = Mock(side_effect=AssertionError("Tests must not train"))
        self.trainer.optimizer_updates = lambda n, micro, accum, epochs: -(-n // (micro * accum)) * epochs
        modules = {"tokenizers": tokenizers, "laya": types.ModuleType("laya"), "laya.train": self.trainer}
        self.dependencies = patch.dict(sys.modules, modules)
        self.dependencies.start()
        self.addCleanup(self.dependencies.stop)

    def write_release(self):
        candidates, annotations = [], []
        for split, event in self.events.items():
            row = {"id": split, **finetune.c.renderer.training_row(event, "allow")}
            candidate = {**row, "event": event, "split": split,
                         "state_sha256": finetune.c.digest(row["state"]),
                         "split_family": split, "split_unit": split, "pair_id": split}
            candidates.append(candidate)
            annotations.append({"id": split, "disposition": "keep", "label": "allow",
                                "state_sha256": candidate["state_sha256"]})
            (self.release / (split + ".jsonl")).write_text(json.dumps(row) + "\n")
        (self.pilot / "candidates.jsonl").write_text("".join(json.dumps(row) + "\n" for row in candidates))
        (self.release / "annotations.jsonl").write_text("".join(json.dumps(row) + "\n" for row in annotations))
        (self.release / "readiness.json").write_text(json.dumps({"training_data_ready": True, "readiness_issues": []}))

    def run_preflight(self, *flags):
        args = ["finetune.py", "--pilot", str(self.pilot), "--base", str(self.base), "--out", str(self.out), *flags]
        with patch.object(sys, "argv", args), contextlib.redirect_stdout(io.StringIO()):
            finetune.main()
        self.trainer.finetune.assert_not_called()
        return json.loads((self.out / "report.json").read_text())

    def test_default_cli_passes_demo_training_rows_to_laya(self):
        path = self.release / "train.jsonl"
        path.write_text(path.read_text().rstrip("\n"))
        original = (self.release / "train.jsonl").read_bytes()
        report = self.run_preflight()
        train = finetune.demo.read(self.out / "train.jsonl")
        synthetic = finetune.demo.examples("train")
        self.assertEqual(len(train), len(synthetic) + 1)
        self.assertEqual(train[1:], synthetic)
        self.assertEqual(self.trainer.dry_run.call_args.args[0], str(self.out / "train.jsonl"))
        self.assertEqual(report["dry_run"]["rows_read"], len(train))
        self.assertEqual(report["micro_steps"], -(-len(train) // 4))
        self.assertEqual(report["demo"]["training_rows"], len(synthetic))
        self.assertIn(str(finetune.demo.CASES.resolve()), report["input_sha256"])
        self.assertIn("demo_train_policy", report["preflight"]["counts"])
        self.assertEqual((self.release / "train.jsonl").read_bytes(), original)

    def test_no_demo_keeps_the_release_input_and_does_not_generate_examples(self):
        with patch.object(finetune.demo, "examples", side_effect=AssertionError("Demo disabled")):
            report = self.run_preflight("--no-demo")
        self.assertEqual(self.trainer.dry_run.call_args.args[0], str(self.release / "train.jsonl"))
        self.assertFalse(report["demo"]["enabled"])
        self.assertEqual(report["dry_run"]["rows_read"], 1)
        self.assertFalse((self.out / "train.jsonl").exists())

    def test_explicit_draft_rows_are_combined_with_pilot_and_demo_rows(self):
        event = {"argv": ["printf", "draft"], "path": "/usr/bin/printf"}
        row = {"id": "draft", **finetune.c.renderer.training_row(event, "allow")}
        candidate = {**row, "event": event, "state_sha256": finetune.c.digest(row["state"]),
                     "split_family": "draft", "split_unit": "draft", "pair_id": "draft"}
        extra, candidates = self.root / "draft.jsonl", self.root / "draft-candidates.jsonl"
        extra.write_text(json.dumps(row) + "\n")
        candidates.write_text(json.dumps(candidate) + "\n")
        report = self.run_preflight("--extra-train", str(extra), "--extra-candidates", str(candidates))
        train = finetune.demo.read(self.out / "train.jsonl")
        self.assertEqual(train[1], row)
        self.assertEqual(len(train), len(finetune.demo.examples("train")) + 2)
        self.assertEqual(report["preflight"]["counts"]["extra_train_unapproved"], {"allow": 1})

    def test_demo_training_cannot_duplicate_validation_or_gold(self):
        event = finetune.demo.examples("train")[0]["event"]
        for split in ("validation", "gold"):
            with self.subTest(split=split):
                original = self.events[split]
                self.events[split] = event
                self.write_release()
                with self.assertRaisesRegex(ValueError, "demo training overlaps held-out"):
                    self.run_preflight()
                self.events[split] = original
        self.trainer.dry_run.assert_not_called()

    def test_existing_training_cannot_include_demo_regression_inputs(self):
        self.events["train"] = finetune.demo.examples("regression")[0]["event"]
        self.write_release()
        with self.assertRaisesRegex(ValueError, "training overlaps demo regression"):
            self.run_preflight()
        self.trainer.dry_run.assert_not_called()

    def test_demo_training_token_limit_is_checked_before_dry_run(self):
        demo_state = finetune.demo.examples("train")[0]["state"]
        self.tokenizer.encode.side_effect = lambda state, **kwargs: range(1025 if state == demo_state else 1)
        with self.assertRaisesRegex(ValueError, "exceeds max_len"):
            finetune.preflight(self.release, self.pilot, self.base, 1024,
                               demo_train=finetune.demo.examples("train"))


if __name__ == "__main__":
    unittest.main()
