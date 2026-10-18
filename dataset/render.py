"""Event JSON -> the text the decision model reads. Shared by training and serving.

    echo '<event json>' | .venv/bin/python -I dataset/render.py      # print the model input

The input is the JSON `Event::to_json()` writes (src/event.cpp), plus the optional fields listed
in dataset/MODEL_INPUT.md (`perms`, `line`, `parent_cmdline`). Missing fields are simply left out
of the text, so today's events and dataset rows both render.

Order matters: laya keeps the first `max_len` tokens of the state and drops the rest, so the
command comes first and the long, less decisive parts (history, script) come last.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys

MAX_COMMAND = 2000
MAX_SCRIPT = 1000
MAX_FILES = 10
SHELLS = {"sh", "bash", "dash", "zsh", "ash", "ksh"}

# The question the model answers. Part of the contract: training rows and the runtime must ask it
# with the same words, or the trained head reads a different prompt than it was fitted on.
VERDICT_QUESTION = {
    "type": "choice",
    "instructions": "Should the command under review be allowed to run?",
    "criteria": {
        "allow": "Clearly routine and safe given this context",
        "hold": "Not clearly safe; the owner must confirm before it runs",
        "block": "Clearly malicious, or clearly destructive and unintended",
    },
}


def base(p: str) -> str:
    return p.rsplit("/", 1)[-1]


def shell_c_script(argv: list[str]) -> str | None:
    """The script of `bash -c '<line>'` (also -lc, -ec, ...), or None."""
    if not argv or base(argv[0]) not in SHELLS:
        return None
    for i, a in enumerate(argv[1:], 1):
        if a.startswith("-") and not a.startswith("--") and "c" in a[1:]:
            return argv[i + 1] if i + 1 < len(argv) else None
        if not a.startswith("-"):
            return None
    return None


def command_text(ev: dict) -> str:
    """Best full text of what is about to run: a captured shell line, a `-c` script, or argv."""
    if ev.get("line"):
        return ev["line"]
    argv = ev.get("argv") or []
    script = shell_c_script(argv)
    if script is not None:
        return script
    return shlex.join(argv) if argv else ev.get("path", "")


# ---------------------------------------------------------------------------------------------
# Files touched, inferred from the command text. Nothing has run yet when the model decides, so
# this is a guess from argv and redirections, not an observation.

WRAPPERS = {"sudo", "env", "nohup", "time", "nice", "ionice", "timeout", "stdbuf", "doas", "exec", "command"}
WRAPPER_VALUE_FLAGS = {
    "sudo": {"-u", "-g", "-U", "-C", "-D", "-R", "-T", "-p", "-r", "-t", "--user", "--group"},
    "doas": {"-u", "-C"}, "env": {"-u", "--unset", "-C", "--chdir"},
    "nice": {"-n", "--adjustment"}, "ionice": {"-c", "-n", "-p", "-P", "-u"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "stdbuf": {"-i", "-o", "-e"}, "time": {"-f", "-o", "--format", "--output"},
    "exec": {"-a"},
}
DELETE = {"rm", "rmdir", "shred", "unlink", "srm", "wipe"}
PERMS = {"chmod", "chown", "chgrp", "chattr", "setfacl", "setcap"}  # first operand is the mode/owner
WRITE = {"tee", "touch", "mkdir", "truncate", "ln"}
COPY = {"cp", "mv", "install", "rsync", "scp"}
READ = {"cat", "head", "tail", "wc", "sort", "uniq", "file", "stat", "less", "more", "strings",
        "sha256sum", "sha1sum", "md5sum", "readlink", "realpath", "diff", "cmp"}
READ_VALUE_FLAGS = {"head": {"-n", "-c", "--lines", "--bytes"},
                    "tail": {"-n", "-c", "--lines", "--bytes"},
                    "sort": {"-k", "-t", "--key", "--field-separator"}}
OUTPUT_FLAG = {"curl": {"-o", "--output"}, "wget": {"-O", "--output-document"}}
REDIRECTS = {">": "write", ">>": "write", ">|": "write", "&>": "write", "<": "read"}
SEPARATORS = {";", "|", "||", "&&", "&", "(", ")", "|&", "\n"}


def looks_like_path(tok: str) -> bool:
    # Generic operands may be embedded program text. Known file-taking commands handle
    # their operands separately, including legitimate long or newline-containing filenames.
    if "\n" in tok or len(tok) > 200 or "://" in tok or tok.startswith("-") or tok in ("/dev/null", "-"):
        return False
    return tok.startswith(("/", "./", "../", "~")) or "/" in tok


def resolve(p: str, cwd: str) -> str:
    if p.startswith(("/", "~")) or not cwd:
        return p
    return os.path.normpath(os.path.join(cwd, p))


def tokens(text: str) -> list[str]:
    try:
        lex = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>\n")
        lex.whitespace = " \t\r"  # unquoted newlines are shell command boundaries
        lex.whitespace_split = True
        lex.commenters = ""
        return list(lex)
    except ValueError:  # unbalanced quotes, e.g. a truncated argv
        return text.split()


def simple_commands(toks: list[str]):
    cur = []
    for t in toks + [";"]:
        if t in SEPARATORS or (t and all(c in ";&|()\n" for c in t)):
            if cur:
                yield cur
            cur = []
        else:
            cur.append(t)


def strip_prefix(cmd: list[str]) -> list[str]:
    """Drop VAR=x assignments and wrappers (sudo -u root, env, timeout 5, ...)."""
    k = 0
    while k < len(cmd):
        t = cmd[k]
        if re.fullmatch(r"\w+=.*", t):
            k += 1
        elif base(t) in WRAPPERS:
            wrapper = base(t)
            k += 1
            while k < len(cmd) and cmd[k].startswith("-"):
                flag = cmd[k]
                k += 1
                if flag == "--":
                    break
                if flag in WRAPPER_VALUE_FLAGS.get(wrapper, ()):
                    k += 1
            if wrapper == "timeout" and k < len(cmd):
                k += 1  # required duration, not a command operand
        else:
            break
    return cmd[k:]


def without_heredoc_bodies(text: str) -> str:
    """Remove heredoc data before inferring file operations; never evaluate expansions.

    This recognizes quoted/escaped delimiter words, <<-, multiple heredocs and incomplete
    bodies. Quoted shell strings containing << are preserved. Shell expansions inside an
    unquoted body are outside this heuristic. Bodies fed to shell interpreters or ssh may
    execute, but their effects are also omitted here: absence from this estimate is not safety.
    """
    out, pending, quote, i = [], [], None, 0
    word = re.compile(r'''(?:[^\s;&|()<>\\'"]+|'[^']*'|"(?:\\.|[^"\\])*"|\\.)+''')
    while i < len(text):
        char = text[i]
        if char == "\\" and quote != "'" and i + 1 < len(text):
            out.append(text[i:i + 2])
            i += 2
            continue
        if quote:
            out.append(char)
            if char == quote:
                quote = None
            i += 1
            continue
        if char in "'\"`":
            quote = char
        if char == "#" and (i == 0 or text[i - 1].isspace() or text[i - 1] in ";&|()"):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
            continue
        arithmetic = 3 if text.startswith("$((", i) else 2 if text.startswith("((", i) else 0
        if arithmetic:
            end, depth = i + arithmetic, 2
            while end < len(text) and depth:
                depth += (text[end] == "(") - (text[end] == ")")
                end += 1
            out.append(text[i:end])  # << inside arithmetic is a shift, not a heredoc
            i = end
            continue
        if text.startswith("<<<", i):
            out.append("<<<")
            i += 3
            continue
        if text.startswith("<<", i):
            end = i + 2
            strip_tabs = end < len(text) and text[end] == "-"
            end += int(strip_tabs)
            while end < len(text) and text[end] in " \t":
                end += 1
            match = word.match(text, end)
            if match:
                try:
                    delimiter = shlex.split(match[0])[0]
                except (ValueError, IndexError):
                    delimiter = None
                if delimiter is not None:
                    pending.append((delimiter, strip_tabs))
                    out.append(" ")
                    i = match.end()
                    continue
        out.append(char)
        i += 1
        if char == "\n" and pending:
            for delimiter, strip_tabs in pending:
                while i < len(text):
                    end = text.find("\n", i)
                    end = len(text) if end < 0 else end + 1
                    line = text[i:end].rstrip("\n")
                    i = end
                    if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                        break
            pending = []
    return "".join(out)


def infer_files(text: str, cwd: str = "", _depth: int = 0) -> list[tuple[str, str]]:
    """[(op, path)] with op in read | write | delete | perms, in order of appearance. Follows `cd`."""
    out: list[tuple[str, str]] = []
    for cmd in simple_commands(tokens(without_heredoc_bodies(text))):
        cmd = strip_prefix(cmd)
        if not cmd:
            continue
        subscript = shell_c_script(cmd)
        if subscript is not None and _depth < 4:
            out += infer_files(subscript, cwd, _depth + 1)
        verb, operands, n = base(cmd[0]), [], 1
        while n < len(cmd):
            t = cmd[n]
            if t == "<<<" and n + 1 < len(cmd):
                n += 2  # here-string data, not a filename
            elif t in REDIRECTS and n + 1 < len(cmd):
                if cmd[n + 1] != "/dev/null" and not cmd[n + 1].startswith("&"):  # skip 2>&1
                    out.append((REDIRECTS[t], resolve(cmd[n + 1], cwd)))
                n += 2
            elif t in OUTPUT_FLAG.get(verb, ()) and n + 1 < len(cmd):
                out.append(("write", resolve(cmd[n + 1], cwd)))
                n += 2
            elif t in READ_VALUE_FLAGS.get(verb, ()) and n + 1 < len(cmd):
                n += 2
            else:
                operands.append(t)
                n += 1
        args = [t for t in operands if not t.startswith("-")]
        if verb == "cd":
            cwd = resolve(args[0], cwd) if args else "~"
            continue
        if subscript is not None:
            files = []  # script text is not a path; nested operations were handled above
        elif verb == "dd":
            files = [("read" if t.startswith("if=") else "write", resolve(t[3:], cwd))
                     for t in args if t.startswith(("if=", "of="))]
        elif verb in PERMS:
            files = [("perms", t) for t in args[1:]]
        elif verb == "sed":
            in_place = any(t.startswith("-i") or t == "--in-place" for t in operands)
            names, skip, script_flag = [], False, False
            for t in operands:
                if skip:
                    skip = False
                elif t in ("-e", "-f"):
                    skip = script_flag = True
                elif not t.startswith("-"):
                    names.append(t)
            files = [("write" if in_place else "read", t) for t in (names if script_flag else names[1:])]
        elif verb == "find":
            deletes = "-delete" in operands or any(base(t) in DELETE for t in operands)
            files = [("delete" if deletes else "read", args[0] if args else ".")]
        elif verb in COPY and len(args) >= 2:
            files = [("read", t) for t in args[:-1]] + [("write", args[-1])]
        elif verb in DELETE:
            files = [("delete", t) for t in args]
        elif verb in WRITE:
            files = [("write", t) for t in args]
        elif verb in READ:
            files = [("read", t) for t in args if t != "-"]
        else:
            files = [("read", t) for t in args if looks_like_path(t)]
        out += [(op, resolve(t, cwd)) for op, t in files]
    seen, uniq = set(), []
    for f in out:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    return uniq[:MAX_FILES]


# ---------------------------------------------------------------------------------------------


def yes(v) -> str:
    return "yes" if v else "no"


def render(ev: dict) -> str:
    lines = []
    cmd = command_text(ev)
    lines.append("command: " + cmd[:MAX_COMMAND] + (" [cut]" if len(cmd) > MAX_COMMAND else ""))
    if ev.get("truncated"):
        lines.append("note: the captured arguments were cut short")
    if ev.get("parent_cmdline"):
        lines.append("started by: " + ev["parent_cmdline"][:300])
    feeder = ev.get("stdin_feeder")
    if feeder:
        lines.append("stdin: piped from " + (feeder.get("cmdline") or feeder.get("exe") or "?")[:300])
    prog = ev.get("file") or ev.get("path")
    if prog:
        extra = " (new: not from a package, or in a writable folder)" if ev.get("is_new") else ""
        lines.append(f"program: {prog}{extra}")

    origin = ev.get("origin") or {}
    if origin.get("type"):
        lines.append("origin: " + origin["type"] + (f" ({origin['detail']})" if origin.get("detail") else ""))

    perms = ev.get("perms") or {}
    user = ev.get("user")
    if user is not None:
        who = f"user: {user} (uid {ev.get('uid')}"
        if perms.get("account"):
            who += f", {perms['account']} account"
        lines.append(who + ")")
    if perms:
        if perms.get("groups"):
            lines.append("groups: " + ", ".join(perms["groups"]))
        if perms.get("sudo"):
            lines.append("sudo rights: " + perms["sudo"])
        if "under_sudo" in perms:
            lines.append("running under sudo: " + yes(perms["under_sudo"]))
        if "caps" in perms:
            caps = perms["caps"]  # root has all ~40; listing them only costs tokens
            lines.append("capabilities: " + ("all" if len(caps) >= 30 else ", ".join(caps) or "none"))
    if ev.get("cwd"):
        lines.append("cwd: " + ev["cwd"])

    files = ev["files"] if "files" in ev else infer_files(cmd, ev.get("cwd", ""))
    if files:
        lines.append("files (inferred): " + "; ".join(f"{op} {p}" for op, p in files))

    hist = ev.get("recent") or []
    if hist:
        lines.append("history (oldest first):")
        lines += [f"  {h}" for h in hist]
    if ev.get("script"):
        lines.append("script (start):")
        lines.append(ev["script"][:MAX_SCRIPT])
    return "\n".join(lines)


def training_row(ev: dict, label: str) -> dict:
    """A laya-train JSONL row for one event; label is allow | hold | block."""
    assert label in VERDICT_QUESTION["criteria"], label
    return {"state": render(ev), "questions": {"verdict": VERDICT_QUESTION}, "expected": {"verdict": label}}


if __name__ == "__main__":
    for line in sys.stdin:
        if line.strip():
            print(render(json.loads(line)))
            print("-" * 60)
