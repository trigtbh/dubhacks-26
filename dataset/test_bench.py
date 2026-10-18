"""Regression checks for saved tokenizer settings; no model or GPU is loaded."""
import importlib.util
import unittest
from pathlib import Path

try:
    from tokenizers import Tokenizer, models, pre_tokenizers
except ImportError:
    Tokenizer = None

spec = importlib.util.spec_from_file_location("latency", Path(__file__).resolve().parents[1] / "bench/latency.py")
latency = importlib.util.module_from_spec(spec)
spec.loader.exec_module(latency)


@unittest.skipIf(Tokenizer is None, "optional tokenizers dependency is not installed")
class BenchmarkTests(unittest.TestCase):
    def test_saved_truncation_and_padding_do_not_distort_requested_length(self):
        for setting in ("truncation", "padding"):
            with self.subTest(setting=setting):
                tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0}, unk_token="[UNK]"))
                tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
                if setting == "truncation":
                    tokenizer.enable_truncation(max_length=8)
                else:
                    tokenizer.enable_padding(length=1024)
                state = latency.build_state(tokenizer, 256)
                self.assertIn(latency.COMMAND, state)
                self.assertLessEqual(len(tokenizer.encode(state, add_special_tokens=False)), 256)
                self.assertIsNone(tokenizer.truncation)
                self.assertIsNone(tokenizer.padding)


if __name__ == "__main__":
    unittest.main()
