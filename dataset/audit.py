"""Independent structural audit and conservative label checks. Bash is used only with -n.

The parser receives no startup environment and never evaluates dataset instructions. Model
proposals are preserved; fixes and cases needing semantic review are separate, explicit records.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import re
import subprocess
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def syntax_errors(rows):
    commands = {}
    for row in rows:
        command = row["event"]["argv"][2]
        if command not in commands:
            result = subprocess.run(["/usr/bin/bash", "--noprofile", "--norc", "-n"],
                                    input=command + "\n", text=True, capture_output=True, timeout=3,
                                    env={"PATH": "/usr/bin:/bin", "BASH_ENV": "/dev/null", "ENV": "/dev/null"})
            commands[command] = result.stderr.strip() if result.returncode else None
    return {row["id"]: commands[row["event"]["argv"][2]] for row in rows if commands[row["event"]["argv"][2]]}


def risk_flags(command):
    flags = []
    patterns = {
        "secret_access": r"/etc/shadow|(?:id_rsa|id_ed25519|\.aws/credentials|\.ssh/.*key)",
        "unknown_program_or_code": r"(?:^|[;&|]\s*)(?:\./\S+|(?:sh|bash|python[23]?|perl|ruby|node|php|lua)\s+(?!-(?:-[\w-]+|[Vhv])(?:\s|$))\S)|python[23]?\s+-c.*(?:import|exec|eval)",
        "service_or_system_change": r"\b(?:systemctl|service|pkill|killall|useradd|userdel|usermod|passwd|chpasswd|chroot|mount|umount)\b",
        "dangerous_mutation": r"\b(?:rm|shred|wipefs|mkfs|dd|chmod|chown|setcap|setfacl|crontab|iptables|nft)\b",
        "remote_execution_or_install": r"\b(?:ssh|scp|sftp|apt|apt-get|dnf|yum|pacman|pip|pip3|npm|gem|cargo|go)\b|\|\s*(?:sudo\s+)?(?:sh|bash)\b",
    }
    for name, pattern in patterns.items():
        if re.search(pattern, command):
            flags.append(name)
    return flags


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pilot", type=Path, default=r.c.ROOT / ".data/pilot")
    ap.add_argument("--annotations", type=Path, nargs="*", default=[])
    args = ap.parse_args()
    rows = [json.loads(line) for line in (args.pilot / "candidates.jsonl").open()]
    r.split_audit(rows)
    errors = syntax_errors(rows)
    annotations = r.load_annotations(args.annotations, rows) if args.annotations else {}
    flagged = []
    for row in rows:
        flags = risk_flags(row["event"]["argv"][2])
        a = annotations.get(row["id"])
        if row["id"] in errors or (a and a["label"] == "allow" and flags) or (a and a["label"] == "block"):
            flagged.append({"id": row["id"], "state_sha256": row["state_sha256"], "state": row["state"],
                            "syntax_error": errors.get(row["id"]), "flags": flags, "proposal": a})
    with (args.pilot / "audit-review.jsonl").open("w") as f:
        for record in flagged:
            r.c.write_json(f, record)
    report = {"syntax_error_rows": len(errors), "syntax_errors": errors,
              "semantic_review_rows": len(flagged), "dataset_commands_executed": False,
              "bash_parse_only": True, "annotations_complete": bool(annotations)}
    (args.pilot / "audit.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "syntax_errors"}))


if __name__ == "__main__":
    main()
