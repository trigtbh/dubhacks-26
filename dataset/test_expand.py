"""Check sample freezing, pair allocation, and rejection of incomplete/stale exports."""
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("expand", Path(__file__).with_name("expand.py"))
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)


class ExpansionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root / "expansion"
        self.out.mkdir()
        (self.root / "dataset").mkdir()
        for name in ("RUBRIC.md", "POLICY.md"):
            (self.root / "dataset" / name).write_text((e.ROOT / "dataset" / name).read_text())
        for mock in (patch.object(e, "ROOT", self.root), patch.object(e, "PRIOR", ()),
                     patch.object(e.p, "bucket", lambda key: "train")):
            mock.start()
            self.addCleanup(mock.stop)
        self.items = []
        for i in range(8):
            seed = {"id": str(i), "source": "nl2bash", "command": f"printf 'fixture-{chr(97+i)}'", "history": [], "meta": {}}
            prepared, errors = e.c.prepare(seed)
            self.assertFalse(errors)
            self.items.append({"seed": seed, "prepared": prepared,
                               "family": "family:" + e.c.digest(e.c.seeds.normalize(prepared["command"])),
                               "unit": e.p.unit(seed)})
        e.write(self.out / "eligible-seeds.jsonl", self.items)

    def prepare(self):
        with contextlib.redirect_stdout(io.StringIO()):
            e.prepare(self.out, 12, 3, 5)
        return e.read(self.out / "candidates.jsonl")

    def annotate(self, rows):
        annotations = [
            {"id": row["id"], "state_sha256": row["state_sha256"], "disposition": "keep", "label": "allow",
             "harm": "none", "settled": True, "intended": None, "rationale": "Fixture prints a fixed literal string.",
             "evidence": [row["event"]["argv"][2]], "annotator": "gpt-6-luna", "status": "model_proposed"}
            for row in rows]
        by_id = {a["id"]: a for a in annotations}
        manifest = json.loads((self.out / "manifest.json").read_text())
        for worker in manifest["workers"]:
            ids = [row["id"] for pair in e.read(Path(worker["packet"])) for row in pair["rows"]]
            e.write(Path(worker["annotation_file"]), [by_id[i] for i in ids])

    def test_pairs_sample_and_complete_export(self):
        rows = self.prepare()
        self.assertEqual(len(rows), 12)
        self.assertEqual(len({row["pair_id"] for row in rows}), 6)
        self.assertEqual({row["split"] for row in rows}, {"train"})
        packets = [e.read(self.out / f"packet-{i:02d}.jsonl") for i in range(3)]
        ids = [row["id"] for packet in packets for pair in packet for row in pair["rows"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), {row["id"] for row in rows})
        sample = (self.out / "sample-selection.jsonl").read_bytes()
        self.assertEqual(len(e.read(self.out / "sample-selection.jsonl")), 5)
        with self.assertRaisesRegex(ValueError, "still pending"):
            e.collect(self.out)
        self.annotate(rows)
        with contextlib.redirect_stdout(io.StringIO()):
            e.collect(self.out, partial=True)
        self.assertFalse((self.out / "proposals-frozen.jsonl").exists())
        with contextlib.redirect_stdout(io.StringIO()):
            e.collect(self.out)
        self.assertEqual(len(e.read(self.out / "train-proposed.jsonl")), 12)
        self.assertEqual((self.out / "sample-selection.jsonl").read_bytes(), sample)
        self.assertFalse(json.loads((self.out / "progress.json").read_text())["release_ready"])

    def test_frozen_sample_tampering_is_rejected(self):
        self.prepare()
        with (self.out / "sample-selection.jsonl").open("a") as f:
            f.write("{}\n")
        with self.assertRaisesRegex(ValueError, "Frozen file changed"):
            e.collect(self.out, partial=True)

    def test_existing_family_cannot_be_selected(self):
        prior = {"split_family": self.items[0]["family"], "split_unit": self.items[0]["unit"],
                 "split": "gold", "state_sha256": "prior"}
        # Selecting every available pair guarantees the prohibited family is encountered.
        with patch.object(e, "prior_rows", lambda: [prior]):
            with self.assertRaisesRegex(ValueError, "training allocation"):
                e.prepare(self.out, 16, 3, 5)

    def test_label_only_rationale_is_rejected(self):
        rows = self.prepare()
        self.annotate(rows)
        labels = e.read(self.out / "luna-annotations-00.jsonl")
        labels[0]["rationale"] = "allow"
        e.write(self.out / "luna-annotations-00.jsonl", labels)
        with self.assertRaisesRegex(ValueError, "semantic rationale"):
            e.collect(self.out)

    def test_annotation_in_another_worker_file_is_rejected(self):
        rows = self.prepare()
        self.annotate(rows)
        foreign = e.read(self.out / "luna-annotations-01.jsonl")[0]
        path = self.out / "luna-annotations-00.jsonl"
        e.write(path, e.read(path) + [foreign])
        with self.assertRaisesRegex(ValueError, "outside worker assignment"):
            e.collect(self.out)

    def test_completed_export_cannot_be_silently_changed(self):
        rows = self.prepare()
        self.annotate(rows)
        with contextlib.redirect_stdout(io.StringIO()):
            e.collect(self.out)
        frozen = (self.out / "proposals-frozen.jsonl").read_bytes()
        path = self.out / "luna-annotations-00.jsonl"
        labels = e.read(path)
        labels[0]["rationale"] = "Revised fixture rationale after the snapshot was frozen."
        e.write(path, labels)
        with self.assertRaisesRegex(ValueError, "Frozen annotation export changed"):
            e.collect(self.out)
        self.assertEqual((self.out / "proposals-frozen.jsonl").read_bytes(), frozen)


if __name__ == "__main__":
    unittest.main()
