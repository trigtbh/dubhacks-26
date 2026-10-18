"""Build annotation candidates from seeds, without running commands or assigning verdicts.

    .venv/bin/python -I dataset/contexts.py
    .venv/bin/python -I dataset/contexts.py --limit 100 --out .data/context-smoke

Each seed gets two permission variants by default. Their command, cwd, origin and history are
identical; only the actor/permissions change. These are candidate contrastive pairs, not a claim
that their labels differ. Source metadata stays outside `event`, the only input to render().
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import shlex
from collections import Counter, defaultdict
from pathlib import Path

# Explicit sibling imports also work with python -I, without trusting the working directory.
def sibling(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


renderer = sibling("render")
seeds = sibling("seeds")
ROOT = Path(__file__).resolve().parent.parent
VERSION = 3
ORIGINS = ("local", "ssh", "agent", "service")
ALL_CAPS = tuple("cap_" + name for name in (
    "chown dac_override dac_read_search fowner fsetid kill setgid setuid setpcap "
    "linux_immutable net_bind_service net_broadcast net_admin net_raw ipc_lock ipc_owner "
    "sys_module sys_rawio sys_chroot sys_ptrace sys_pacct sys_admin sys_boot sys_nice "
    "sys_resource sys_time sys_tty_config mknod lease audit_write audit_control setfcap "
    "mac_override mac_admin syslog wake_alarm block_suspend audit_read perfmon bpf checkpoint_restore"
).split())
# User, uid, account, named groups, sudo rights, effective caps, sudo ancestor, privilege tier.
# A root profile may model a restricted container or a host with all capabilities.
PROFILES = (
    ("dev", 1000, "human", ("dev",), "none", (), False, "limited"),
    ("dev", 1000, "human", ("dev", "sudo"), "all (password)", (), False, "sudo"),
    ("dev", 1000, "human", ("dev", "sudo"), "all (nopasswd)", (), False, "sudo"),
    ("dev", 1000, "human", ("dev", "docker"), "none", (), False, "host_admin"),
    ("www-data", 33, "service", ("www-data",), "none", (), False, "limited"),
    ("app", 998, "service", ("app",), "none", ("cap_net_bind_service",), False, "limited"),
    ("root", 0, "root", ("root",), "none", ("cap_chown", "cap_dac_override", "cap_setuid", "cap_setgid"), False, "container_root"),
    ("root", 0, "root", ("root",), "unknown", ALL_CAPS, False, "host_admin"),
    ("root", 0, "root", ("root",), "unknown", ALL_CAPS, True, "host_admin"),
    ("dev", 1000, "human", ("dev",), "some", (), False, "delegated"),
    ("dev", 1000, "human", ("dev",), "unknown", (), False, "unknown"),
)
CWD = ("/srv/app", "/home/dev/project", "/tmp/work", "/app")
PLACEHOLDER = re.compile(r"\{\{([^{}]+)\}\}")
VALUES = {
    "command": "printf", "username": "dev", "user": "dev", "owner": "dev",
    "group": "dev", "group_name": "dev", "password": "example-password",
    "host": "example.com", "hostname": "example.com", "domain": "example.com",
    "remote_host": "example.com", "url": "https://example.com/file",
    "ip_address": "192.0.2.10", "port": "8080", "process_id": "1234", "pid": "1234",
    "package": "jq", "package_name": "jq", "branch_name": "feature",
    "remote_name": "origin", "repository": "https://example.com/project.git",
    "repository_name": "project", "version": "1.0", "filename": "input.txt",
    "file": "input.txt", "directory": "work", "name": "sample", "value": "sample",
    "string": "sample", "text": "sample", "message": "update", "keyword": "sample",
    "pattern": "sample", "search_pattern": "sample", "regex": "sample",
    "number": "3", "n": "3", "width": "640", "height": "480",
    "service_name": "app", "unit": "app.service", "interface": "eth0",
    "database_name": "app", "table_name": "records", "container_name": "app",
    "image": "alpine", "tag": "latest", "project_name": "project", "key": "sample",
}


def digest(value) -> str:
    data = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


def pick(key, field, size):
    return int(digest([key, field])[:16], 16) % size


def placeholder_value(value: str, key=None) -> str | None:
    """Conservative substitutions. Unknown domain-specific templates go to quarantine."""
    value = value.strip()
    if "|" in value:
        choices = value.split("|")
        # tldr uses | for alternatives. Do not mistake a regex for a known choice.
        if all(placeholder_value(c, key) is not None for c in choices):
            return placeholder_value(choices[pick(key, value, len(choices))] if key is not None else choices[0], key)
        return None
    if value in VALUES:
        pools = {
            "password": ("change-me", "temporary", "development"),
            "name": ("cache", "build", "data", "config", "test", "app"),
            "pattern": ("error", "TODO", "config", "status"),
            "filename": ("input.txt", "config.json", "notes.txt", "data.csv"),
        }
        if key is not None and value in pools:
            return pools[value][pick(key, value, len(pools[value]))]
        return VALUES[value]
    if re.fullmatch(r"(?:-?\d+(?:\.\d+)?|--?[a-zA-Z][a-zA-Z-]*|eth\d+)", value):
        return value
    if re.fullmatch(r"(?:https?://)?example\.(?:com|org|net)(?:/[\w./-]*)?", value):
        return value
    if re.fullmatch(r"/dev/sd[Xx](?:[YNn]|[Yy][Nn])?", value):
        return "/dev/sdb1" if value[-1] not in "Xx" else "/dev/sdb"
    if re.fullmatch(r"path/to/[\w./-]+", value):
        if key is not None:
            prefix = ("./", "../", "/tmp/", "/srv/app/", "~/", "./data/", "./src/")[pick(key, "path_prefix", 7)]
            return prefix + value[len("path/to/"):]
        return "work/" + value[len("path/to/"):]
    if value.endswith(" ..."):
        parts = [placeholder_value(p, key) for p in value[:-4].split()]
        if parts and all(p is not None for p in parts):
            return " ".join(parts)
    return None


def materialize(text: str, replacements: dict, unresolved: set, template_key=None) -> str:
    def replace(match):
        key = match[1]
        value = placeholder_value(key, template_key)
        if value is None:
            unresolved.add(key)
            return match[0]
        replacements[key] = value
        return value
    return PLACEHOLDER.sub(replace, text)


def prepare(seed: dict) -> tuple[dict | None, list[str]]:
    errors = []
    for field in ("id", "source", "command"):
        if not isinstance(seed.get(field), str) or not seed[field].strip():
            errors.append("missing_or_invalid_" + field)
    history = seed.get("history", [])
    if not isinstance(history, list) or any(not isinstance(h, str) for h in history):
        errors.append("invalid_history")
    if errors:
        return None, errors
    replacements, unresolved = {}, set()
    is_template = seed["source"] == "tldr"
    # {{ and }} can be literal Python/JSON text in real shell calls. Only tldr promises
    # this template grammar; do not alter arbitrary source code from other datasets.
    template_key = seed["command"]
    command = materialize(seed["command"], replacements, unresolved, template_key) if is_template else seed["command"]
    history = [materialize(h, replacements, unresolved, template_key) if is_template else h
               for h in history[-seeds.HISTORY:]]
    if unresolved:
        errors.append("unresolved_placeholders")
    if is_template and ("{{" in command or "}}" in command):
        errors.append("remaining_template_delimiters")
    if "\x00" in command or any("\x00" in h for h in history):
        errors.append("nul_in_shell_text")
    # These need an interactive history expansion phase, absent in our shell-line contract.
    meta = seed.get("meta") or {}
    tool = meta.get("tool") if isinstance(meta, dict) else None
    if is_template and (tool in ("!", "^") or re.search(r"(^|\s)(?:sudo\s+)?![^\s=]", command)):
        errors.append("interactive_history_expansion")
    if is_template and re.match(r"^tldr\s", command.strip()):
        errors.append("documentation_alias")
    removed_history = []
    if seed["source"] == "tbench":
        if seeds.INTERNED_REFERENCE.fullmatch(command.strip()):
            errors.append("unresolved_trajectory_reference")
        removed_history = [h for h in history if seeds.INTERNED_REFERENCE.fullmatch(h.strip())]
        history = [h for h in history if not seeds.INTERNED_REFERENCE.fullmatch(h.strip())]
    visible = "".join(c for c in command if c.isprintable() or c in "\n\t")
    if not visible.strip() or all(not l.strip() or l.lstrip().startswith("#") for l in visible.splitlines()):
        errors.append("no_shell_command")
    warnings = []
    try:
        shlex.split(command)
    except ValueError:
        # shlex is not a complete shell parser (heredoc bodies in particular may confuse it).
        # Flag for annotation rather than discard legitimate source scripts on that basis.
        warnings.append("unbalanced_quotes_or_unsupported_syntax")
    if re.match(r"\s*(?:import\s+\w|from\s+[\w.]+\s+import|def\s+\w+\(|class\s+\w+|print\(|>>>|[}\])](?:\s|$))", command):
        warnings.append("possible_non_shell_fragment")
    return {"command": command, "history": history, "replacements": replacements,
            "removed_history": removed_history, "warnings": warnings, "unresolved": sorted(unresolved)}, errors


def candidates(seed: dict, prepared: dict, salt: int, variants: int):
    command = prepared["command"]
    # Sampling depends on command text, never source, intent, phase, or descriptions.
    key = [VERSION, salt, command]
    source_id = digest(seed)  # old Terminal-Bench seed IDs can collide
    pair_id = "pair:" + source_id
    group = "family:" + digest(seeds.normalize(command))
    cwd = CWD[pick(key, "cwd", len(CWD))]
    # Source shell histories do not record whether each call reused a persistent shell.
    # A guessed cwd can contradict an earlier cd; leave it unknown in that case.
    cwd_unknown = any(re.search(r"\bcd(?:\s|$)", h) for h in prepared["history"])
    cwd_masked = pick(key, "omit_cwd", 6) == 0
    origin = ORIGINS[pick(key, "origin", len(ORIGINS))]
    first = pick(key, "profile", len(PROFILES))
    # Keep missing histories missing. Hash-based shortening supplies first-exec/short-history
    # cases for session sources too, without inventing a source-identifying fake prefix.
    history_keep = pick(key, "history_keep", seeds.HISTORY + 1)
    history = prepared["history"][-history_keep:] if history_keep else []
    actor_transition = any(re.search(r"(?:^|\s|[;&|])(?:sudo\s+)?su(?:\s|$)|\bsudo\s+-(?:i|s)(?:\s|$)", h)
                           for h in prepared["history"])
    different_tier = [p for p in range(len(PROFILES)) if PROFILES[p][-1] != PROFILES[first][-1]]
    different_tier.sort(key=lambda p: digest([key, "pair_profile", p]))
    remaining = [p for p in range(len(PROFILES)) if p != first and p not in different_tier]
    order = [first] + different_tier + remaining
    for variant in range(variants):
        profile = order[variant]
        user, uid, account, groups, sudo, caps, under_sudo, tier = PROFILES[profile]
        event = {
            "argv": ["/bin/bash", "-c", command], "path": "/bin/bash", "file": "/bin/bash",
            "user": user, "uid": uid, "cwd": cwd, "origin": {"type": origin},
            "perms": {"account": account, "groups": list(groups), "sudo": sudo,
                      "under_sudo": under_sudo, "caps": list(caps)},
            "recent": [h[:200] for h in history],
        }
        if cwd_unknown or cwd_masked:
            del event["cwd"]
        yield {
            "id": f"context:v{VERSION}:{source_id}:{salt}:{variant}", "pair_id": pair_id,
            "group_id": group, "event": event,
            "annotation": {"status": "pending", "harm": None, "settled": None, "label": None},
            "provenance": {"seed": seed, "generator_version": VERSION, "salt": salt,
                           "variant": variant, "profile": profile, "privilege_tier": tier,
                           "replacements": prepared["replacements"],
                           "source_quality_warnings": prepared["warnings"],
                           "history": "source" if prepared["history"] else "missing",
                           "history_available": len(prepared["history"]), "history_kept": len(history),
                           "removed_history_references": prepared["removed_history"],
                           "history_actor_transition": actor_transition,
                           "unusual_service_ssh": origin == "ssh" and account == "service",
                           "cwd": "unknown_after_source_cd" if cwd_unknown else "masked" if cwd_masked else "synthetic",
                           "synthetic": ["argv_shell_wrapper", "user", "perms", "origin"] + ([] if cwd_unknown or cwd_masked else ["cwd"]),
                           "source_command_at_limit": len(seed["command"]) >= seeds.MAX_CMD,
                           "history_at_limit": any(len(h) >= 200 for h in seed.get("history", []))},
        }


def write_json(file, row):
    file.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def generate(inputs: list[Path], out: Path, salt: int = 0, variants: int = 2, limit: int = 0):
    if not 1 <= variants <= len(PROFILES):
        raise ValueError(f"variants must be between 1 and {len(PROFILES)}")
    if limit < 0:
        raise ValueError("limit must be nonnegative")
    # Validate all input paths before creating/truncating any output.
    for path in inputs:
        if not path.is_file():
            raise ValueError(f"missing seed file: {path}")
    outputs = {out / name for name in ("candidates.jsonl", "rejected.jsonl", "report.json")}
    if any(p.resolve() in {x.resolve() for x in outputs} for p in inputs):
        raise ValueError("input and output paths overlap")
    out.mkdir(parents=True, exist_ok=True)
    report = {"generator_version": VERSION, "salt": salt, "variants": variants,
              "inputs": [], "counts": Counter(), "sources": defaultdict(Counter),
              "context_by_source": defaultdict(lambda: defaultdict(Counter)),
              "rejection_reasons": Counter(), "unresolved_placeholders": Counter()}
    seen, rendered = set(), set()
    with (out / "candidates.jsonl").open("w", encoding="utf-8") as accepted, \
            (out / "rejected.jsonl").open("w", encoding="utf-8") as rejected:
        for path in inputs:
            report["inputs"].append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
            with path.open(encoding="utf-8") as f:
                for n, line in enumerate(f, 1):
                    if limit and n > limit:
                        break
                    report["counts"]["input_rows"] += 1
                    try:
                        seed = json.loads(line)
                        if not isinstance(seed, dict):
                            raise ValueError("seed must be a JSON object")
                        prepared, errors = prepare(seed)
                    except (ValueError, TypeError) as exc:
                        write_json(rejected, {"input": str(path), "line": n, "errors": ["invalid_json_or_schema"], "detail": str(exc)})
                        report["counts"]["rejected_seeds"] += 1
                        report["rejection_reasons"]["invalid_json_or_schema"] += 1
                        continue
                    source = seed.get("source", "unknown")
                    if not isinstance(source, str):
                        source = "unknown"
                    report["sources"][source]["input_rows"] += 1
                    if errors:
                        write_json(rejected, {"seed": seed, "errors": errors,
                                              "unresolved": prepared["unresolved"] if prepared else []})
                        report["counts"]["rejected_seeds"] += 1
                        report["sources"][source]["rejected_seeds"] += 1
                        report["rejection_reasons"].update(errors)
                        if prepared:
                            report["unresolved_placeholders"].update(prepared["unresolved"])
                        continue
                    identity = digest(seed)
                    if identity in seen:
                        report["counts"]["duplicate_seeds"] += 1
                        continue
                    seen.add(identity)
                    report["counts"]["accepted_seeds"] += 1
                    report["sources"][source]["accepted_seeds"] += 1
                    for row in candidates(seed, prepared, salt, variants):
                        # Exercise the actual serving renderer for every candidate.
                        state_hash = digest(renderer.render(row["event"]))
                        if state_hash in rendered:
                            report["counts"]["duplicate_rendered_states"] += 1
                        rendered.add(state_hash)
                        write_json(accepted, row)
                        report["counts"]["candidates"] += 1
                        report["sources"][source]["candidates"] += 1
                        distribution = report["context_by_source"][source]
                        distribution["origin"][row["event"]["origin"]["type"]] += 1
                        distribution["profile"][str(row["provenance"]["profile"])] += 1
                        distribution["cwd"][row["event"].get("cwd", "unknown")] += 1
                        distribution["history_length"][str(len(row["event"]["recent"]))] += 1
                        distribution["under_sudo"][str(row["event"]["perms"]["under_sudo"])] += 1
                        distribution["sudo_rights"][row["event"]["perms"]["sudo"]] += 1
                        distribution["source_quality_warnings"].update(row["provenance"]["source_quality_warnings"])
    report["counts"]["unique_rendered_states"] = len(rendered)
    with (out / "report.json").open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="*", type=Path, help="seed JSONL files; default .data/seeds/*.jsonl")
    parser.add_argument("--out", type=Path, default=ROOT / ".data" / "contexts")
    parser.add_argument("--salt", type=int, default=0, help="deterministic sampling salt")
    parser.add_argument("--variants", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0, help="max seeds per input, 0 = all")
    args = parser.parse_args()
    inputs = args.inputs or sorted((ROOT / ".data" / "seeds").glob("*.jsonl"))
    if not inputs:
        parser.error("no seed files found; run dataset/seeds.py first")
    try:
        report = generate(inputs, args.out, args.salt, args.variants, args.limit)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps({"out": str(args.out), **report["counts"]}, sort_keys=True))


if __name__ == "__main__":
    main()
