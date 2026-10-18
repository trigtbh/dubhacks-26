"""Model protocol and renderer checks; fake workers never execute reviewed commands."""

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("laya_worker", ROOT / "runtime/laya_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

FAKE_WORKER = '''
import json, os, socket, sys, time
from pathlib import Path
fd = int(sys.argv[sys.argv.index("--fd") + 1])
mode = os.environ.get("FAKE_MODE", "normal")
Path(os.environ["FAKE_PID"]).write_text(str(os.getpid()))
with socket.socket(fileno=fd) as sock, sock.makefile("rwb") as stream:
    if mode == "start-timeout": time.sleep(10)
    stream.write(b'{"ready":false}\\n' if mode == "not-ready" else b'{"ready":true}\\n')
    stream.flush()
    while line := stream.readline():
        event = json.loads(line)
        if mode == "crash": os._exit(1)
        if mode == "stall": time.sleep(10)
        if mode == "oversized":
            stream.write(b'x' * 20000)
            stream.flush()
            continue
        choice = event["argv"][0]
        answer = {"choice": choice, "probabilities": {c: int(c == choice) for c in ("allow", "hold", "block")},
                  "reason": event["id"] + ":" + event["argv"][-1]}
        data = json.dumps(answer).encode() + b'\\n'
        if mode == "malformed": data = b'{"choice":"maybe"}\\n'
        # stdout is deliberately noisy; the protocol uses its own descriptor.
        print("library log", flush=True)
        if mode == "fragmented":
            for chunk in (data[:5], data[5:]):
                stream.write(chunk)
                stream.flush()
                time.sleep(0.01)
        else:
            stream.write(data)
            stream.flush()
'''


class WorkerTests(unittest.TestCase):
    def test_shared_renderer_and_question(self):
        event = {"argv": ["bash", "-c", "cat input.txt"], "cwd": "/app", "recent": ["pwd"]}
        calls = []

        class Agent:
            def predict(self, state, questions, **kwargs):
                calls.append((state, questions, kwargs))
                return {"answers": {"verdict": {"choice": "allow", "probabilities": {
                    "allow": 0.9, "hold": 0.09, "block": 0.01}}}}

        self.assertEqual(worker.classify(Agent(), event)["choice"], "allow")
        self.assertEqual(calls, [(worker.renderer.render(event),
                                {"verdict": worker.renderer.VERDICT_QUESTION}, {"max_len": 1024})])

    def test_invalid_model_answers_do_not_allow(self):
        for answer in [
            {"choice": "allow", "probabilities": {"allow": 1}},
            {"choice": "maybe", "probabilities": {"allow": 1, "hold": 0, "block": 0}},
            {"choice": "allow", "probabilities": {"allow": float("nan"), "hold": 0, "block": 0}},
            {"choice": "allow", "probabilities": {"allow": True, "hold": 0, "block": 0}},
            {"choice": "allow", "probabilities": {"allow": 0.1, "hold": 0, "block": 0}},
        ]:
            class Agent:
                def predict(self, *args, **kwargs):
                    return {"answers": {"verdict": answer}}
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                worker.classify(Agent(), {"argv": ["true"]})

    def test_invalid_events_are_rejected(self):
        with self.assertRaises(ValueError):
            worker.classify(None, ["true"])
        for line in [b'{"argv":[]}', b'x' * (worker.MAX_REQUEST + 1)]:
            with self.subTest(size=len(line)), self.assertRaises(ValueError):
                # Separate incoming/outgoing buffers, like a full-duplex socket.
                class Stream(io.BytesIO):
                    def write(self, data):
                        return len(data)
                worker.serve(None, Stream(line))

    def test_non_utf8_exec_fields_keep_the_worker_alive(self):
        states, output = [], []

        class Agent:
            def predict(self, state, *args, **kwargs):
                states.append(state)
                return {"answers": {"verdict": {"choice": "hold", "probabilities": {
                    "allow": 0, "hold": 1, "block": 0}}}}

        class Stream(io.BytesIO):
            def write(self, data):
                output.append(data)
                return len(data)

        worker.serve(Agent(), Stream(b'{"argv":["echo","\xff"]}\n{"argv":["true"]}\n'))
        self.assertIn("\ufffd", states[0])
        self.assertEqual(states[1], "command: true")
        self.assertEqual(len(output), 3)  # ready and both verdicts


@unittest.skipUnless(os.environ.get("SID_MODEL_CHECK"), "run make test-model to build the C++ client")
class TransportTests(unittest.TestCase):
    def run_client(self, mode="normal", choice="allow", parallel=1):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            script = path / "fake worker.py"
            script.write_text(FAKE_WORKER)
            env = {**os.environ, "SID_MODEL_PYTHON": sys.executable, "SID_MODEL_WORKER": str(script),
                   "SID_MODEL_TIMEOUT_MS": "250", "SID_MODEL_START_TIMEOUT_MS": "1000",
                   "SID_CHECK_PARALLEL": str(parallel), "FAKE_MODE": mode, "FAKE_PID": str(path / "pid")}
            started = time.monotonic()
            result = subprocess.run([env["SID_MODEL_CHECK"], "--", choice, 'literal "; touch /tmp/no; $()'],
                                    env=env, capture_output=True, text=True, timeout=5)
            elapsed = time.monotonic() - started
            if (path / "pid").exists():
                with self.assertRaises(ProcessLookupError):
                    os.kill(int((path / "pid").read_text()), 0)
            return result, elapsed

    def test_all_verdicts_and_literal_arguments(self):
        for choice in ("allow", "hold", "block"):
            with self.subTest(choice=choice):
                result, _ = self.run_client(choice=choice)
                self.assertEqual(result.returncode, 0, result.stderr)
                answer = json.loads(result.stdout)
                self.assertEqual(answer["choice"], choice)
                self.assertEqual(answer["reason"], '0:literal "; touch /tmp/no; $()')

    def test_concurrent_requests_keep_responses_paired(self):
        result, _ = self.run_client(parallel=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        answers = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual({a["reason"].split(":", 1)[0] for a in answers}, {str(i) for i in range(8)})

    def test_fragmented_response(self):
        result, _ = self.run_client(mode="fragmented")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["choice"], "allow")

    def test_worker_failures_do_not_allow(self):
        for mode in ("crash", "stall", "oversized", "malformed", "not-ready", "start-timeout"):
            with self.subTest(mode=mode):
                result, elapsed = self.run_client(mode=mode)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertLess(elapsed, 3)

    def test_missing_interpreter_is_explicit(self):
        result = subprocess.run([os.environ["SID_MODEL_CHECK"]], env={**os.environ,
                                "SID_MODEL_PYTHON": "/nonexistent/sid-python"},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot start Laya worker", result.stderr)


if __name__ == "__main__":
    unittest.main()
