"""The decision step. THIS IS WHERE THE LAYA MODEL PLUGS IN.

decide(event) gets the fully gathered event dict (see context.py) and returns
a Decision. Today it is a stub that allows everything. To wire in the real
pipeline, replace the body with: honeytoken -> rules -> cache -> tiny
classifier -> Laya -> exploration -> person. Keep the signature and the
Decision fields; the capture, the log format and the install do not change.

decide() runs on its own thread per paused exec, so it may block (exploration,
a person) without stalling other commands. The daemon enforces a timeout and
fails closed if decide() raises or takes too long.
"""
from dataclasses import dataclass
from typing import Optional

ALLOW, HOLD, BLOCK = "allow", "hold", "block"


@dataclass
class Decision:
    verdict: str                  # allow | hold | block
    decided_by: str               # rule name, "honeytoken", "laya", "exploration", "person"
    reason: str
    score: Optional[float] = None
    attack_id: Optional[str] = None


def decide(event: dict) -> Decision:
    # TODO(laya): replace this stub.
    return Decision(ALLOW, "stub", "stub decider: return allow (Laya not wired in yet)")
