"""Data and scoring checks for demo regressions; no reviewed command is executed."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("demo", Path(__file__).with_name("demo.py"))
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


class DemoTests(unittest.TestCase):
    def test_training_and_regression_contexts_are_distinct(self):
        train, regression = demo.examples("train"), demo.examples("regression")
        self.assertFalse({row["state"] for row in train} & {row["state"] for row in regression})
        for rows in (train, regression):
            self.assertEqual(len(rows), len({row["id"] for row in rows}))
            for row in rows:
                self.assertEqual(row["state"], demo.renderer.render(row["event"]))
                self.assertEqual(row["questions"], {"verdict": demo.renderer.VERDICT_QUESTION})
        self.assertEqual({row["event"]["uid"] for row in regression}, {0, 1000})

    def test_relative_delete_target_changes_the_expected_decision(self):
        rows = demo.examples("regression")
        protected = next(row for row in rows if row["case"] == "rm-relative-parent")
        project = next(row for row in rows if row["case"] == "rm-relative-project-etc")
        self.assertEqual(protected["event"]["argv"], project["event"]["argv"])
        self.assertEqual(protected["expected"]["verdict"], "block")
        self.assertEqual(project["expected"]["verdict"], "hold")
        self.assertIn("delete /etc", protected["state"])
        self.assertIn("delete /workspace/etc", project["state"])

    def test_repeated_prediction_changes_fail_the_regression(self):
        class Agent:
            calls = 0

            def predict(self, *args, **kwargs):
                choice = ("allow", "hold")[self.calls % 2]
                self.calls += 1
                return {"answers": {"verdict": {
                    "choice": choice,
                    "probabilities": {label: float(label == choice)
                                      for label in ("allow", "hold", "block")},
                }}}

        report = demo.score(Agent(), demo.examples("regression")[:1], repeats=2)
        self.assertFalse(report["all_passed"])
        self.assertEqual(report["unstable_predictions"], 1)
        self.assertEqual(report["failures"][0]["repeated_choices"], ["allow", "hold"])

    def test_help_options_do_not_approve_unknown_code_or_command_chains(self):
        cases = {row["id"]: row for row in demo.read(demo.CASES)}
        for name in ("help-rm", "help-vim", "help-vim-short", "help-python"):
            self.assertEqual(cases[name]["label"], "allow")
        for name in ("vim", "help-vim-filename", "help-unknown-script", "help-python-script"):
            self.assertEqual(cases[name]["label"], "hold")
        for name in ("help-then-delete", "help-after-end-of-options"):
            self.assertEqual(cases[name]["label"], "block")

    def test_preparation_records_provenance_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "prepared"
            with contextlib.redirect_stdout(io.StringIO()):
                demo.prepare(out)
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertFalse(manifest["commands_executed"])
            self.assertFalse(manifest["gold_used"])
            self.assertTrue(manifest["shared_command_families"])
            before = (out / "train.jsonl").read_bytes()
            with self.assertRaises(FileExistsError):
                demo.prepare(out)
            self.assertEqual((out / "train.jsonl").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
