"""Checks for data integrity; no source commands are executed."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("contexts", Path(__file__).with_name("contexts.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def seed(command="cat input.txt", **extra):
    return {"id": "test:1", "source": "test", "command": command, "history": [], **extra}


class ContextTests(unittest.TestCase):
    def test_collision_resistance_and_permission_pairs(self):
        a, b = seed(), seed("cat output.txt")
        pa, _ = c.prepare(a)
        pb, _ = c.prepare(b)
        rows = list(c.candidates(a, pa, 0, 2))
        self.assertNotEqual(rows[0]["id"], next(c.candidates(b, pb, 0, 2))["id"])
        self.assertEqual(rows[0]["pair_id"], rows[1]["pair_id"])
        x, y = [r["event"].copy() for r in rows]
        self.assertNotEqual(x.pop("perms"), y.pop("perms"))
        for field in ("user", "uid"):
            x.pop(field)
            y.pop(field)
        self.assertEqual(x, y)

    def test_no_source_metadata_in_model_input(self):
        a = seed(intent="attacker", meta={"description": "PRIVATE_MARKER"})
        b = {**a, "source": "another", "intent": "reference", "meta": {}}
        pa, _ = c.prepare(a)
        pb, _ = c.prepare(b)
        ra = next(c.candidates(a, pa, 0, 2))
        rb = next(c.candidates(b, pb, 0, 2))
        self.assertEqual(ra["event"], rb["event"])
        self.assertNotIn("PRIVATE_MARKER", c.renderer.render(ra["event"]))
        self.assertIsNone(ra["annotation"]["label"])

    def test_placeholders_and_history(self):
        a = seed("cp {{path/to/file}} {{path/to/directory}}", source="tldr", history=["cat {{path/to/file}}"])
        prepared, errors = c.prepare(a)
        self.assertFalse(errors)
        self.assertIn("path/to/file", prepared["replacements"])
        self.assertEqual(prepared["history"], ["cat " + prepared["replacements"]["path/to/file"]])
        self.assertTrue(prepared["command"].endswith(prepared["replacements"]["path/to/directory"]))
        self.assertEqual(c.placeholder_value("path/to/file1 path/to/file2 ..."), "work/file1 work/file2")
        self.assertEqual(c.placeholder_value("--all|-a"), "--all")
        self.assertIsNone(c.placeholder_value("domain_specific_unknown"))

    def test_stream_rejections_and_reproducibility(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "seeds.jsonl"
            path.write_text("\n".join(json.dumps(r) for r in [
                seed(), seed(), seed("cat {{unknown}}", source="tldr"), seed("echo hi", history=3),
                seed("printf x", source=[]), seed("echo '\\n'", id="test:2"),
            ]) + '\nnot json\n')
            for folder in ("a", "b"):
                c.generate([path], root / folder)
            for name in ("candidates.jsonl", "rejected.jsonl", "report.json"):
                self.assertEqual((root / "a" / name).read_bytes(), (root / "b" / name).read_bytes())
            rows = [json.loads(l) for l in (root / "a/candidates.jsonl").read_text().splitlines()]
            self.assertEqual(len(rows), 4)
            self.assertEqual(len({r["id"] for r in rows}), 4)
            report = json.loads((root / "a/report.json").read_text())
            self.assertEqual(report["counts"]["rejected_seeds"], 4)
            self.assertEqual(report["counts"]["duplicate_seeds"], 1)

    def test_no_input_output_overlap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "candidates.jsonl"
            path.write_text(json.dumps(seed()))
            with self.assertRaises(ValueError):
                c.generate([path], root)
            self.assertEqual(json.loads(path.read_text()), seed())

    def test_rendered_file_operations(self):
        cases = {
            "sudo -n rm /tmp/file": [("delete", "/tmp/file")],
            "sudo -k rm /tmp/file": [("delete", "/tmp/file")],
            "sudo -u root dd of=/dev/sdb": [("write", "/dev/sdb")],
            "timeout -k 2 10 rm file": [("delete", "/app/file")],
            "cat input.txt\nrm output.txt": [("read", "/app/input.txt"), ("delete", "/app/output.txt")],
            "cat a\n\nrm b": [("read", "/app/a"), ("delete", "/app/b")],
            "cat a &&\nrm b": [("read", "/app/a"), ("delete", "/app/b")],
            "head -n 5 input.txt": [("read", "/app/input.txt")],
            "cat 'a\nb'": [("read", "/app/a\nb")],
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                self.assertEqual(c.renderer.infer_files(command, "/app"), expected)

    def test_literal_code_and_history_designators(self):
        command = "python3 -c 'print({\"key\": {\"nested\": 1}})'"
        prepared, errors = c.prepare(seed(command))
        self.assertFalse(errors)
        self.assertEqual(prepared["command"], command)
        for command in ("!-{{n}}", "!{{command}}:p", "^old^new^", "!!"):
            prepared, errors = c.prepare(seed(command, source="tldr", meta={"tool": "!"}))
            self.assertIn("interactive_history_expansion", errors)

    def test_unknown_cwd_when_source_history_changes_directory(self):
        s = seed(history=["cd /root/private", "pwd"])
        prepared, _ = c.prepare(s)
        row = next(c.candidates(s, prepared, 0, 2))
        self.assertNotIn("cwd", row["event"])
        self.assertEqual(row["provenance"]["cwd"], "unknown_after_source_cd")

    def test_history_is_not_fabricated_and_masks_are_reproducible(self):
        s = seed()
        prepared, _ = c.prepare(s)
        self.assertEqual(next(c.candidates(s, prepared, 0, 2))["event"]["recent"], [])
        seen_lengths = set()
        for n in range(100):
            s = seed(f"cat input{n}.txt", history=["pwd", "id", "ls", "date", "uname"])
            prepared, _ = c.prepare(s)
            a = list(c.candidates(s, prepared, 0, 2))
            self.assertEqual(a, list(c.candidates(s, prepared, 0, 2)))
            seen_lengths.add(len(a[0]["event"]["recent"]))
            self.assertNotEqual(a[0]["provenance"]["privilege_tier"], a[1]["provenance"]["privilege_tier"])
        self.assertEqual(seen_lengths, set(range(6)))

    def test_profile_coverage(self):
        s = seed()
        prepared, _ = c.prepare(s)
        rows = list(c.candidates(s, prepared, 0, len(c.PROFILES)))
        states = [c.renderer.render(r["event"]) for r in rows]
        self.assertTrue(any("capabilities: all" in state for state in states))
        self.assertTrue(any("running under sudo: yes" in state for state in states))
        rights = {r["event"]["perms"]["sudo"] for r in rows}
        self.assertEqual(rights, {"none", "some", "unknown", "all (password)", "all (nopasswd)"})

    def test_interned_references_and_noncommands(self):
        prepared, errors = c.prepare(seed("$3b", source="tbench"))
        self.assertIn("unresolved_trajectory_reference", errors)
        prepared, errors = c.prepare(seed("cat file", source="tbench", history=["pwd", "$4d"]))
        self.assertFalse(errors)
        self.assertEqual(prepared["history"], ["pwd"])
        self.assertEqual(prepared["removed_history"], ["$4d"])
        # Ordinary shell variables outside the known interned-reference source stay intact.
        self.assertNotIn("unresolved_trajectory_reference", c.prepare(seed("$abc"))[1])
        for command in ("# comment\n  # more", "\x1b\x03\x04"):
            self.assertIn("no_shell_command", c.prepare(seed(command))[1])
        self.assertIn("documentation_alias", c.prepare(seed("tldr cat", source="tldr"))[1])
        self.assertIn("possible_non_shell_fragment", c.prepare(seed("import os"))[0]["warnings"])
        self.assertIn("unbalanced_quotes_or_unsupported_syntax", c.prepare(seed("cat 'unfinished"))[0]["warnings"])

    def test_heredoc_data_is_not_parsed_as_shell_commands(self):
        cases = {
            "cat <<EOF > /app/y.txt\nrm -rf /important\nEOF\ncat input.txt":
                [("write", "/app/y.txt"), ("read", "/app/input.txt")],
            "cat <<-'END' > out\n\tchmod 777 /important\n\tEND\ncat input":
                [("write", "/app/out"), ("read", "/app/input")],
            "cat <<A <<B > out\nrm one\nA\nrm two\nB\ncat input":
                [("write", "/app/out"), ("read", "/app/input")],
            "cat <<< 'rm /important' > out": [("write", "/app/out")],
            "cat <<EOF\nrm /important": [],
            "printf '%s' '<<EOF' > out": [("write", "/app/out")],
            "# <<EOF\ncat input": [("read", "/app/input")],
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                self.assertEqual(c.renderer.infer_files(command, "/app"), expected)
        arithmetic = "echo $((1 << 2))\nrm file"
        self.assertEqual(c.renderer.without_heredoc_bodies(arithmetic), arithmetic)

    def test_nested_shells_and_grouped_punctuation(self):
        cases = {
            "x=$(date); rm /y": [("delete", "/y")],
            "(cd /a; rm /b); rm /c": [("delete", "/b"), ("delete", "/c")],
            "sudo -n bash -lc 'rm /victim'": [("delete", "/victim")],
            "bash -lc 'cat <<EOF > /tmp/x.txt\nnot a command\nEOF'": [("write", "/tmp/x.txt")],
            "python3 -c 'print(\"/some/path\")\n# code'": [],
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                self.assertEqual(c.renderer.infer_files(command, "/app"), expected)

    def test_ssh_splitter_preserves_quoted_separators(self):
        text = "id ; python3 -c 'import os ; print(os.getcwd())' ; echo \"a ; b\" ; pwd"
        self.assertEqual(c.seeds.split_ssh_session(text), ["id", "python3 -c 'import os ; print(os.getcwd())'", 'echo "a ; b"', "pwd"])


if __name__ == "__main__":
    unittest.main()
