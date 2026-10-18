"""Turn each raw source into seed rows: one shell command plus whatever context the source gives.

    .venv/bin/python -I dataset/seeds.py                 # every source found in .data/raw
    .venv/bin/python -I dataset/seeds.py tbench ssh      # just these

Writes .data/seeds/<source>.jsonl. A seed is not a training row yet: perms, files and the label
are filled in by later steps (context generation, labelling). Fields:

    id          stable "<source>:<ref>:<n>"
    source      art | nl2bash | tldr | ssh | tbench
    command     the shell line (a pipeline or && chain, not a single exec)
    history     up to 5 earlier shell lines from the same session, oldest first (empty when the
                source has no session)
    origin      agent | ssh | null (null: the context generator picks one)
    intent      who wrote it: attacker | task (an agent doing an assigned task) | reference
                (documentation or Q&A, no actor). A source-level prior, not a per-command label:
                an attacker's `uname -a` is not malicious on its own.
    phase       art only: prereq | attack | cleanup
    normalized  same rules as normalize() in src/context.cpp; used for dedupe and splits
    meta        source-specific extras (descriptions, ATT&CK ids, task name, ...)

Everything read here is untrusted data: nothing is executed, and YAML is parsed with safe_load.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / ".data" / "raw"
SEEDS = ROOT / ".data" / "seeds"
HISTORY = 5  # kHistory in src/context.cpp
MAX_CMD = 4000


def normalize(text: str) -> str:
    """Python port of normalize() in src/context.cpp: paths, IPs, hex and numbers become placeholders."""
    out = []
    for tok in re.split(r"([ \t]+)", text):
        if not tok or tok[0] in " \t":
            out.append(tok)
            continue
        slashes = tok.count("/")
        if slashes >= 2 or (slashes == 1 and tok[0] == "/"):
            out.append("<path>")
        elif tok.count(".") == 3 and all(c in "0123456789." for c in tok):
            out.append("<ip>")
        elif len(tok) >= 8 and all(c in "0123456789abcdef" for c in tok):
            out.append("<hex>")
        else:
            out.append(re.sub(r"\d+", "<n>", tok))
    return "".join(out)


def stable_hash(s: str) -> int:
    return int.from_bytes(hashlib.sha1(s.encode()).digest()[:8], "big")


def seed(source, ref, n, command, history=(), origin=None, intent="reference", phase=None, **meta):
    command = command.strip()[:MAX_CMD]
    row = {
        "id": f"{source}:{ref}:{n}",
        "source": source,
        "command": command,
        "history": [h[:200] for h in list(history)[-HISTORY:]],  # gather() keeps 200 chars per entry
        "origin": origin,
        "intent": intent,
        "normalized": normalize(command),
        "meta": meta,
    }
    if phase:
        row["phase"] = phase
    return row


OPENERS = re.compile(r"(?:^|[;&|(\s])(if|for|while|until|case|select)\b")
CLOSERS = re.compile(r"(?:^|[;&|\s])(fi|done|esac)\b")


def block_depth(line: str) -> int:
    """Net shell blocks opened on this line (if/for/while/case/{), ignoring quoted text."""
    bare = re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", "''", line)
    depth = len(OPENERS.findall(bare)) - len(CLOSERS.findall(bare))
    depth += len(re.findall(r"(?:^|\s)\{(?:\s|$)", bare)) - len(re.findall(r"(?:^|[;\s])\}", bare))
    return depth


def open_quote(text: str) -> bool:
    """True when a quote opened in `text` is still open (a string spanning lines)."""
    bare = re.sub(r"\\.", "", text)
    bare = re.sub(r"'[^']*'|\"[^\"]*\"", "", bare)
    return "'" in bare or '"' in bare


def split_script(script: str) -> list[str]:
    """Shell script -> logical commands: joins `\\` continuations, multi-line strings, heredoc
    bodies and whole if/for/while/case/{ } blocks; drops blank and comment lines."""
    lines, cur, heredoc, depth = [], "", None, 0
    for raw in script.splitlines():
        if heredoc is not None:
            cur += "\n" + raw
            if raw.strip() == heredoc:
                heredoc = None
                if depth <= 0:
                    lines.append(cur)
                    cur = ""
            continue
        line = raw.rstrip()
        if not cur and (not line.strip() or line.lstrip().startswith("#")):
            continue
        cur = f"{cur}\n{line}" if cur else line
        if line.endswith("\\") or open_quote(cur):
            continue
        depth += block_depth(line)
        m = re.search(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", line)
        if m:
            heredoc = m.group(1)
            continue
        if depth > 0:
            continue
        lines.append(cur)
        cur, depth = "", 0
    if cur:
        lines.append(cur)
    return lines


# ---------------------------------------------------------------------------------------------
# Atomic Red Team: one YAML per ATT&CK technique, each with several tests.


# The tests name their own artifacts (Atomic-Red-Team units, /tmp/t1040_..., PathToAtomicsFolder).
# Left in, the model can learn "mentions atomic or a T-number" instead of the behaviour, which
# scores well on this data and means nothing on a real attacker. Replaced with dull names.
ART_SCRUB = [
    (re.compile(r"PathToAtomicsFolder", re.I), "/opt/tools"),
    (re.compile(r"atomic[-_ ]?red[-_ ]?team", re.I), "maint"),
    (re.compile(r"atomics?", re.I), "maint"),
    (re.compile(r"(?<![A-Za-z0-9])art(?![A-Za-z0-9])", re.I), "svc"),
    (re.compile(r"(?<![A-Za-z0-9])t\d{4}(?:[._-]\d{3})?", re.I), "job"),
    # self-describing names a real attacker would not use (`evil.com`, `malicious_command`)
    (re.compile(r"malicious", re.I), "helper"),
    (re.compile(r"evil", re.I), "update"),
    (re.compile(r"victim", re.I), "host"),
    (re.compile(r"pwn(ed)?", re.I), "done"),
]
# `echo "starting warmup"` and friends: the test narrating itself, not attacker behaviour.
NARRATION = re.compile(r"echo\s+(-e\s+)?([\"'])[^\"'$`]*\2\s*;?")


def art_scrub(text: str, key: str = "") -> str:
    # Vary artifacts per test, retaining the same mapping in its command and history.
    # Ordinary names overlap the benign corpus; there is no single ART-only substitute.
    names = ("cache", "build", "data", "config", "test", "run", "backup", "app", "sync", "status", "lib", "util")
    for i, (pat, rep) in enumerate(ART_SCRUB):
        name = names[stable_hash(f"{key}:{i}") % len(names)]
        rep = "/tmp/" + name if rep == "/opt/tools" else name
        text = pat.sub(rep, text)
    return text


def load_art():
    import yaml

    files = sorted((RAW / "art").glob("T*.yaml"))
    if not files:
        print("art: no YAML in .data/raw/art (see dataset/fetch.sh)", file=sys.stderr)
        return
    for path in files:
        doc = yaml.safe_load(path.read_text(encoding="utf-8", errors="replace")) or {}
        tid = doc.get("attack_technique") or path.stem
        for t_i, test in enumerate(doc.get("atomic_tests") or []):
            if "linux" not in (test.get("supported_platforms") or []):
                continue
            ex = test.get("executor") or {}
            if ex.get("name") not in ("sh", "bash"):  # skips manual, powershell, command_prompt
                continue
            args = {k: v.get("default") for k, v in (test.get("input_arguments") or {}).items()}

            def fill(s, args=args):
                return art_scrub(re.sub(r"#\{(\w+)\}", lambda m: str(args.get(m.group(1), m.group(0))), s or ""), f"{tid}:{t_i}")

            meta = dict(
                technique=tid,
                technique_name=doc.get("display_name"),
                test=test.get("name"),
                guid=test.get("auto_generated_guid"),
                description=(test.get("description") or "").strip()[:1000],
                elevation_required=bool(ex.get("elevation_required")),
            )
            ref = f"{tid}:{t_i}"
            n = 0
            prereq = []
            for dep in test.get("dependencies") or []:
                for key in ("prereq_command", "get_prereq_command"):
                    for line in split_script(fill(dep.get(key))):
                        yield seed("art", ref, n, line, prereq, intent="attacker", phase="prereq", **meta)
                        prereq.append(line)
                        n += 1
            hist = []
            for line in split_script(fill(ex.get("command"))):
                if NARRATION.fullmatch(line):
                    continue
                yield seed("art", ref, n, line, hist, intent="attacker", phase="attack", **meta)
                hist.append(line)
                n += 1
            for line in split_script(fill(ex.get("cleanup_command"))):
                yield seed("art", ref, n, line, hist, intent="attacker", phase="cleanup", **meta)
                hist.append(line)
                n += 1


# ---------------------------------------------------------------------------------------------
# NL2Bash: one-line commands paired with an English description, no session.


def load_nl2bash():
    d = RAW / "nl2bash"
    cms = (d / "all.cm").read_text(encoding="utf-8", errors="replace").splitlines()
    nls = (d / "all.nl").read_text(encoding="utf-8", errors="replace").splitlines()
    for i, (cm, nl) in enumerate(zip(cms, nls)):
        if cm.strip():
            yield seed("nl2bash", "all", i, cm, description=nl.strip())


# ---------------------------------------------------------------------------------------------
# tldr: example commands per tool. `{{path/to/file}}` placeholders are left for the context
# generator; option alternatives like `{{[-C|--directory]}}` are resolved to the short form.


def tldr_options(cmd: str) -> str:
    return re.sub(r"\{\{\[([^|\]]+)\|[^\]]*\]\}\}", r"\1", cmd)


def load_tldr():
    for platform in ("common", "linux"):
        for path in sorted((RAW / "tldr" / platform).glob("*.md")):
            text = path.read_text(encoding="utf-8", errors="replace")
            tool_desc = " ".join(l[2:].strip() for l in text.splitlines() if l.startswith("> "))
            desc, n = None, 0
            for line in text.splitlines():
                if line.startswith("- "):
                    desc = line[2:].rstrip(":").strip()
                elif line.startswith("`") and line.endswith("`") and desc:
                    cmd = tldr_options(line[1:-1])
                    yield seed("tldr", f"{platform}/{path.stem}", n, cmd,
                               tool=path.stem, description=desc, tool_description=tool_desc[:300],
                               placeholders="{{" in cmd)
                    n += 1
                    desc = None


# ---------------------------------------------------------------------------------------------
# SSH-Shell-Attacks: 233k honeypot sessions, commands joined with " ; ", tagged with ATT&CK
# tactics per session. Bot traffic repeats heavily, so this dedupes on the (command, previous
# command) shape and caps each command shape.


def ssh_shape(text: str) -> str:
    """normalize() plus folding of quoted strings (bots put credentials there) and random tokens
    (generated passwords, file names, busybox tags)."""
    text = re.sub(r'"[^"]*"', '"<str>"', re.sub(r"'[^']*'", "'<str>'", text))
    text = re.sub(r"~/\S+", "<path>", text)
    def fold(m):
        w = m.group(0)
        classes = sum(bool(re.search(c, w)) for c in ("[a-z]", "[A-Z]", "[0-9]"))
        return "<rand>" if classes >= 2 or re.fullmatch(r"[A-Z]{5}", w) else w
    return re.sub(r"\b[A-Za-z0-9]{5,}\b", fold, normalize(text))


def split_ssh_session(text: str) -> list[str]:
    """Split dataset join separators outside shell quotes; preserve quoted program text."""
    out, start, i, quote = [], 0, 0, None
    while i < len(text):
        char = text[i]
        if char == "\\" and quote != "'":
            i += 2
            continue
        if quote:
            if char == quote:
                quote = None
        elif char in "'\"`":
            quote = char
        elif text.startswith(" ; ", i):
            out.append(text[start:i].strip())
            i += 3
            start = i
            continue
        i += 1
    out.append(text[start:].strip())
    return [c for c in out if c]


def load_ssh(per_command: int = 5):
    import pyarrow.parquet as pq

    t = pq.read_table(RAW / "ssh" / "ssh_attacks.parquet", columns=["session_id", "full_session", "Set_Fingerprint"])
    seen_sessions, seen_pairs, per_norm = set(), set(), Counter()
    for r in t.to_pylist():
        session = r["full_session"] or ""
        key = ssh_shape(session)
        if key in seen_sessions:
            continue
        seen_sessions.add(key)
        try:
            tactics = ast.literal_eval(r["Set_Fingerprint"]) if isinstance(r["Set_Fingerprint"], str) else list(r["Set_Fingerprint"] or [])
        except (ValueError, SyntaxError):
            tactics = []
        cmds = split_ssh_session(session)
        for i, cmd in enumerate(cmds):
            norm = ssh_shape(cmd)
            pair = (norm, ssh_shape(cmds[i - 1]) if i else "")
            if pair in seen_pairs or per_norm[norm] >= per_command:
                continue
            seen_pairs.add(pair)
            per_norm[norm] += 1
            yield seed("ssh", r["session_id"], i, cmd, cmds[max(0, i - HISTORY):i], origin="ssh",
                       intent="attacker", session_id=str(r["session_id"]), session_tactics=tactics, session_len=len(cmds))


# ---------------------------------------------------------------------------------------------
# Terminal-Bench 2.0: 52k agent trajectories over 89 tasks. Only shell tool calls are kept. The
# history is the agent's own earlier shell calls in the trial. Each task contributes at most
# `per_task` distinct (normalized) commands, taken round-robin across scaffolds (terminus-2 alone
# is over half the calls) and by hash within one.
#
# tmux-driven scaffolds (terminus) send keystrokes, not commands: a heredoc or a python REPL is
# typed one call at a time. Those bodies are skipped, so they appear neither as commands nor in
# the history.

TBENCH_SHELL = {"bash_command", "execute_bash", "Bash", "run_shell_command", "execute", "shell"}
TMUX_KEYS = re.compile(r"^(C-[a-z]|M-[a-z]|Escape|Enter|Tab|Up|Down|Left|Right|q|y|n|:q!?|:wq)$")
REPL = re.compile(r"^(python3?(\.\d+)?|ipython3?|node|R|irb|lua)$")
REPL_END = re.compile(r"^(C-d|exit\(\)|quit\(\)|exit|quit|\.exit|q\(\))$")
INTERNED_REFERENCE = re.compile(r"\$[0-9a-f]+")
HEREDOC = re.compile(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")


def tbench_raw(tool) -> str:
    cmd = tool.get("cmd")
    if isinstance(cmd, list):  # codex: ["bash", "-lc", "<line>"]
        cmd = cmd[-1] if cmd else ""
    if not isinstance(cmd, str):
        return ""
    cmd = cmd.strip()
    if cmd.startswith("{") and '"command"' in cmd:  # a few scaffolds keep the raw JSON arguments
        try:
            cmd = str(json.loads(cmd).get("command") or "").strip()
        except ValueError:
            return ""
    return cmd


def tbench_trial(steps):
    """Yield (command, history) for one trial's shell calls."""
    hist, heredoc, repl = [], None, False
    for st in steps:
        for tool in (st or {}).get("tools") or []:
            if tool.get("fn") not in TBENCH_SHELL:
                continue
            cmd = tbench_raw(tool)
            if repl:
                repl = not REPL_END.match(cmd)
                continue
            if heredoc is not None:
                if any(l.strip() == heredoc for l in cmd.splitlines()):
                    heredoc = None
                continue
            # "$32" is an interned reference the dataset did not resolve; tmux keys are not commands.
            if not cmd or INTERNED_REFERENCE.fullmatch(cmd) or TMUX_KEYS.match(cmd):
                continue
            m = HEREDOC.search(cmd)
            if m and not any(l.strip() == m.group(1) for l in cmd.splitlines()[1:]):
                heredoc = m.group(1)  # opened here, closed in a later call
            repl = bool(REPL.match(cmd))
            yield cmd, hist
            hist = hist + [cmd]


def load_tbench(per_task: int = 400):
    import pyarrow.parquet as pq

    best = defaultdict(lambda: defaultdict(dict))  # task -> agent -> normalized -> (hash, row)
    for path in sorted((RAW / "tbench").glob("*.parquet")):
        f = pq.ParquetFile(path)
        for g in range(f.num_row_groups):
            cols = ["task_name", "agent", "model", "reward", "trial_id", "steps"]
            for r in f.read_row_group(g, columns=cols).to_pylist():
                try:
                    steps = json.loads(r["steps"]) if r["steps"] else None
                except ValueError:
                    continue
                if not isinstance(steps, list):
                    continue
                # trial_id is often empty. Include task/scaffold and trajectory content so
                # unrelated trials cannot collapse to IDs such as "tbench::26".
                ref = hashlib.sha256(json.dumps(
                    [r["task_name"], r["agent"], r["model"], r["trial_id"], steps],
                    sort_keys=True, separators=(",", ":"),
                ).encode()).hexdigest()[:24]
                slot = best[r["task_name"]][r["agent"]]
                for n, (cmd, hist) in enumerate(tbench_trial(steps)):
                    row = seed("tbench", ref, n, cmd, hist, origin="agent", intent="task",
                               task=r["task_name"], trial=ref, agent=r["agent"], model=r["model"], reward=r["reward"])
                    h = stable_hash(row["id"])
                    old = slot.get(row["normalized"])
                    if old is None or h < old[0]:
                        slot[row["normalized"]] = (h, row)
    for task in sorted(best):
        queues = [sorted(best[task][a].values(), key=lambda x: x[0]) for a in sorted(best[task])]
        taken, i = set(), 0
        while len(taken) < per_task and any(queues):
            q = queues[i % len(queues)]
            i += 1
            while q:
                _, row = q.pop(0)
                if row["normalized"] not in taken:
                    taken.add(row["normalized"])
                    yield row
                    break


LOADERS = {"art": load_art, "nl2bash": load_nl2bash, "tldr": load_tldr, "ssh": load_ssh, "tbench": load_tbench}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="*", help=f"any of {', '.join(LOADERS)} (default: all)")
    args = ap.parse_args()
    args.sources = args.sources or list(LOADERS)
    for s in args.sources:
        if s not in LOADERS:
            ap.error(f"unknown source {s!r}")
    SEEDS.mkdir(parents=True, exist_ok=True)
    for name in args.sources:
        out = SEEDS / f"{name}.jsonl"
        n, uniq = 0, set()
        with out.open("w", encoding="utf-8") as f:
            for row in LOADERS[name]():
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                n += 1
                uniq.add(row["normalized"])
        print(json.dumps({"source": name, "rows": n, "unique_normalized": len(uniq), "out": str(out.relative_to(ROOT))}))


if __name__ == "__main__":
    main()
