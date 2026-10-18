"""Checks for the immutable private upload bundle, without loading a model."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("kaggle_bundle", Path(__file__).with_name("kaggle.py"))
kaggle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kaggle)


class PackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "input.jsonl"
        self.data.write_text('{"state":"example"}\n')
        self.manifest = {"files": {self.data.name: kaggle.sha(self.data)}, "file_count": 1}
        (self.root / "kaggle_bundle_manifest.json").write_text(json.dumps(self.manifest))

    def test_unchanged_bundle_and_optional_cli_metadata(self):
        (self.root / "dataset-metadata.json").write_text('{}')
        self.assertEqual(kaggle.verify_package(self.root), self.manifest)

    def test_changed_file_is_rejected(self):
        self.data.write_text('{"state":"modified"}\n')
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            kaggle.verify_package(self.root)

    def test_extra_file_is_rejected(self):
        (self.root / "unexpected.txt").write_text("unlisted")
        with self.assertRaisesRegex(ValueError, "file set differs"):
            kaggle.verify_package(self.root)

    def test_missing_file_is_rejected(self):
        self.data.unlink()
        with self.assertRaisesRegex(ValueError, "file set differs"):
            kaggle.verify_package(self.root)

    def test_dynamic_import_does_not_add_bytecode_to_package(self):
        source = self.root / "helper.py"
        source.write_text("VALUE = 42\n")
        self.assertEqual(kaggle.module("kaggle_test_helper", source).VALUE, 42)
        self.assertFalse((self.root / "__pycache__").exists())


if __name__ == "__main__":
    unittest.main()
