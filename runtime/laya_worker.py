"""Persistent Laya inference worker. Started by jev_init() before exec capture."""

from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import math
import os
import signal
import socket
import sys
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sid_render", ROOT / "dataset/render.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
LABELS = {"allow", "hold", "block"}
MAX_REQUEST = 1024 * 1024


def classify(agent, event: dict) -> dict:
    if not isinstance(event, dict):
        raise ValueError("expected an Event object")
    result = agent.predict(renderer.render(event), {"verdict": renderer.VERDICT_QUESTION}, max_len=1024)
    answer = result["answers"]["verdict"]
    choice, probabilities = answer["choice"], answer["probabilities"]
    if choice not in LABELS or set(probabilities) != LABELS:
        raise ValueError("unexpected model verdict schema")
    values = list(probabilities.values())
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
           or not 0 <= v <= 1 for v in values) or abs(sum(values) - 1) > 0.05:
        raise ValueError("invalid model probabilities")
    return {"choice": choice, "probabilities": probabilities}


def serve(agent, stream) -> None:
    stream.write(b'{"ready":true}\n')
    stream.flush()
    while True:
        line = stream.readline(MAX_REQUEST + 1)
        if not line:
            return
        if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
            raise ValueError("incomplete or oversized Event")
        # execve fields are Linux byte strings; Event::to_json preserves those
        # bytes. Replace invalid UTF-8 for the text model instead of killing it.
        answer = classify(agent, json.loads(line.decode("utf-8", errors="replace")))
        stream.write(json.dumps(answer, separators=(",", ":"), allow_nan=False).encode() + b"\n")
        stream.flush()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fd", type=int, required=True, help="inherited private socket descriptor")
    ap.add_argument("--parent-pid", type=int, required=True)
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    args = ap.parse_args()
    # Reclaim model/GPU memory even if the daemon is killed instead of exiting.
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot set parent-death signal")
    if os.getppid() != args.parent_pid:
        return
    if not args.checkpoint.is_dir():
        ap.error(f"checkpoint directory does not exist: {args.checkpoint}")

    import laya
    import torch

    device = ("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    agent = laya.load(str(args.checkpoint.resolve()), device=device)
    # Finish lazy model/GPU initialization before the daemon enables capture.
    classify(agent, {"argv": ["true"], "path": "/usr/bin/true"})
    print(f"sid-laya: loaded {args.checkpoint.resolve()} on {device}", file=sys.stderr, flush=True)
    with socket.socket(fileno=args.fd) as connection, connection.makefile("rwb") as stream:
        serve(agent, stream)


if __name__ == "__main__":
    main()
