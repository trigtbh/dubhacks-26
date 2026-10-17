"""Phase 2: gather context for a paused exec. Everything here is passive reads.

The daemon must never exec anything while the capture is live (the child would
pause on itself), so no subprocesses and no shelling out to journalctl etc.
"""
import hashlib
import os
import pwd
import re
import threading
from collections import OrderedDict, defaultdict, deque

WRITABLE_PREFIXES = ("/tmp/", "/dev/shm/", "/var/tmp/", "/home/", "/root/", "/run/user/")
INTERPRETERS = {"bash", "sh", "dash", "zsh", "python", "python3", "perl", "ruby", "node"}
KNOWN_AGENTS = ("/claude", "/codex", "/gemini", "/cline", "/goose", "/aider")  # matched on exe path
HISTORY = 5

_hash_cache = OrderedDict()
_hash_lock = threading.Lock()
_history = defaultdict(lambda: deque(maxlen=HISTORY))
_pkg_files = set()


def load_package_files():
    """Paths installed by dpkg; anything else is 'new'."""
    d = "/var/lib/dpkg/info"
    try:
        names = [n for n in os.listdir(d) if n.endswith(".list")]
    except OSError:
        return 0
    for n in names:
        try:
            with open(os.path.join(d, n), errors="replace") as f:
                _pkg_files.update(line.rstrip("\n") for line in f)
        except OSError:
            pass
    return len(_pkg_files)


def _read(path, mode="r"):
    with open(path, mode) as f:
        return f.read()


def status(pid):
    out = {}
    for line in _read(f"/proc/{pid}/status", "r").splitlines():
        k, _, v = line.partition(":")
        out[k] = v.split()
    return out


def exe_of(pid):
    try:
        return os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return None


def parent_chain(pid):
    chain = []
    try:
        ppid = int(status(pid)["PPid"][0])
    except (OSError, KeyError, ValueError):
        return chain
    while ppid > 0 and len(chain) < 64:
        chain.append({"pid": ppid, "exe": exe_of(ppid)})
        try:
            ppid = int(status(ppid)["PPid"][0])
        except (OSError, KeyError, ValueError):
            break
    return chain


def file_identity(efd):
    """inode, mtime and a hash computed once per (inode, mtime), via the event fd."""
    st = os.fstat(efd)
    key = (st.st_dev, st.st_ino, st.st_mtime_ns)
    with _hash_lock:
        h = _hash_cache.get(key)
    if h is None:
        d = hashlib.sha256()
        off = 0
        try:
            while True:
                chunk = os.pread(efd, 1 << 20, off)
                if not chunk:
                    break
                d.update(chunk)
                off += len(chunk)
            h = d.hexdigest()
        except OSError:
            h = None
        with _hash_lock:
            _hash_cache[key] = h
            while len(_hash_cache) > 4096:
                _hash_cache.popitem(last=False)
    return {"inode": st.st_ino, "mtime": st.st_mtime, "sha256": h, "size": st.st_size}


def is_new(path):
    return path not in _pkg_files or path.startswith(WRITABLE_PREFIXES)


def _pipe_feeder(pid, link):
    """pid of another process holding the other end of a pipe fed to us."""
    for p in os.listdir("/proc"):
        if not p.isdigit() or int(p) == pid:
            continue
        try:
            for fd in os.listdir(f"/proc/{p}/fd"):
                if os.readlink(f"/proc/{p}/fd/{fd}") == link:
                    return int(p)
        except OSError:
            continue
    return None


def stdin_source(pid, interpreter):
    try:
        link = os.readlink(f"/proc/{pid}/fd/0")
    except OSError:
        return None
    out = {"fd0": link}
    if link.startswith("pipe:") and interpreter:  # catches `curl ... | bash`
        feeder = _pipe_feeder(pid, link)
        if feeder:
            out["fed_by"] = {"pid": feeder, "exe": exe_of(feeder)}
            try:
                out["fed_by"]["cmdline"] = _read(f"/proc/{feeder}/cmdline", "rb").replace(b"\0", b" ").decode("utf-8", "replace").strip()
            except OSError:
                pass
    return out


def script_contents(path, argv, cwd):
    """-c code is already in argv; otherwise read the first KB of a file argument."""
    base = os.path.basename(path)
    if not any(base == i or base.startswith(i) for i in INTERPRETERS):
        return None
    if "-c" in argv[1:]:
        return None
    for a in argv[1:]:
        if a.startswith("-"):
            continue
        p = a if a.startswith("/") else os.path.join(cwd or "/", a)
        try:
            with open(p, "rb") as f:
                return f.read(4096).decode("utf-8", "replace")
        except OSError:
            return None
    return None


_NORM = [(re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"), "<ip>"),
         (re.compile(r"(?:/[\w.@+-]+){2,}"), "<path>"),
         (re.compile(r"\b[0-9a-f]{8,}\b"), "<hex>"),
         (re.compile(r"\d+"), "<n>")]


def normalize(text):
    for rx, rep in _NORM:
        text = rx.sub(rep, text)
    return text


def gather(event, tid, efd, role, rec):
    """Fill the event with everything phase 2 lists. `rec` is the eBPF record or None."""
    pid = event["tid"] = tid
    try:
        pid = int(status(tid)["Tgid"][0])
    except (OSError, KeyError, ValueError):
        pass
    event["pid"] = pid

    # who is asking
    try:
        st = status(tid)
        event["uid"], event["gid"] = int(st["Uid"][0]), int(st["Gid"][0])
        event["groups"] = [int(g) for g in st.get("Groups", [])]
        event["ppid"] = int(st["PPid"][0])
        try:
            event["user"] = pwd.getpwuid(event["uid"]).pw_name
        except KeyError:
            event["user"] = str(event["uid"])
    except (OSError, KeyError, ValueError):
        pass
    try:
        event["cwd"] = os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        event["cwd"] = None

    # what is about to run
    event["file"] = os.readlink(f"/proc/self/fd/{efd}")
    event["identity"] = file_identity(efd)
    event["is_new"] = is_new(event["file"])
    event["role"] = role  # "program", or "interpreter" for the 2nd pause of a #! script

    if rec is not None:
        event["path"] = rec["path"]
        event["argv"] = rec["argv"]
        event["truncated"] = rec["truncated"]
        event["syscall"] = rec["syscall"]
    else:
        event["path"], event["argv"], event["truncated"] = event["file"], [], True
        event["syscall"] = "unknown"
        event["note"] = "no eBPF record matched; treated as truncated"

    # where it came from
    chain = parent_chain(pid)
    event["parent_chain"] = chain
    exes = [c["exe"] or "" for c in chain]
    event["via_ssh"] = any(e.endswith("/sshd") for e in exes)
    event["origin"] = {"type": "local"}
    if event["via_ssh"]:
        # TODO: sshd's "Accepted publickey ... from IP ... SHA256:..." log line, matched by sshd pid
        event["origin"] = {"type": "ssh", "sshd_pid": next(c["pid"] for c in chain if (c["exe"] or "").endswith("/sshd"))}
    try:
        for line in _read(f"/proc/{pid}/cgroup").splitlines():
            m = re.search(r"/([^/]+\.service)(?:/|$)", line)
            if m:
                event["service"] = m.group(1)
                if not event["via_ssh"]:
                    event["origin"] = {"type": "service", "service": m.group(1)}
                break
    except OSError:
        pass
    for c in [{"exe": event["file"]}] + chain:
        e = c["exe"] or ""
        if e.endswith(KNOWN_AGENTS) or any(e.rsplit("/", 1)[-1] == a[1:] for a in KNOWN_AGENTS):
            event["origin"] = {"type": "agent", "agent": os.path.basename(e)}
            break
    try:
        event["sessionid"] = int(_read(f"/proc/{pid}/sessionid").strip())
    except (OSError, ValueError):
        event["sessionid"] = None

    # what feeds it
    interp = os.path.basename(event["file"]) in INTERPRETERS or os.path.basename(event["path"]) in INTERPRETERS
    event["stdin"] = stdin_source(pid, interp)
    event["script"] = script_contents(event["file"], event["argv"], event["cwd"])

    # recent history in this session
    hist = _history[event["sessionid"]]
    event["recent"] = list(hist)
    hist.append(" ".join(event["argv"])[:200] or event["path"])

    text = " ".join(event["argv"]) or event["path"]
    event["normalized"] = f"{event['user']} {event['origin']['type']} {normalize(text)}"
    return event
