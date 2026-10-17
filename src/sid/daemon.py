"""sid-daemon: passive command capture.

fanotify (FAN_OPEN_EXEC_PERM) freezes every program launch; an eBPF program
records the command. We pair them by thread id, gather context, run decide(),
and answer the kernel. Needs root. If this process dies the kernel allows every
paused program, so run it under systemd with Restart=always.
"""
import ctypes
import datetime
import json
import os
import socket
import struct
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import context, fan
from .decide import ALLOW, BLOCK, Decision, decide

EVENT_LOG = os.environ.get("SID_EVENT_LOG", "/var/log/sid/events.jsonl")
DECIDE_TIMEOUT = float(os.environ.get("SID_DECIDE_TIMEOUT", "2"))  # s; no answer -> deny
MATCH_WAIT = 0.05  # s to wait for a late eBPF record
BPF_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "exec_trace.c")
MAXARGS, ARGLEN = 32, 256  # keep in sync with exec_trace.c
VERBOSE = os.environ.get("SID_VERBOSE") == "1"  # multi-line banner per exec
CAPTURE_BANNER = "THIS IS BEING RUN IN THE CAPTURE"

_log_lock = threading.Lock()
_log_file = None
_cond = threading.Condition()
_fresh = {}   # tid -> eBPF record not yet claimed by a pause
_used = {}    # tid -> (record, resolved_path, claimed_at) for #! interpreter pauses
_pool = ThreadPoolExecutor(max_workers=128, thread_name_prefix="exec")
_stats = {"events": 0, "loader_allows": 0, "unmatched": 0}


def log(msg):
    print(f"sid-daemon: {msg}", file=sys.stderr, flush=True)


def is_loader(path):
    b = os.path.basename(path)
    return b.startswith("ld-linux") or (b.startswith("ld-") and ".so" in b)


# ---- eBPF side -----------------------------------------------------------

def _cstr(raw):
    return bytes(raw).split(b"\0", 1)[0].decode("utf-8", "surrogateescape")


_HDR = struct.Struct("QIIIIIIII")  # ts tid tgid ppid uid is_execveat argc truncated pad
_ARGS_OFF = _HDR.size + ARGLEN  # struct exec_t in exec_trace.c: header, path[256], args[32][256]


def on_record(_cpu, data, size):
    raw = ctypes.string_at(data, size)  # BCC can't build a ctype for char[32][256]
    ts, tid, tgid, ppid, uid, is_at, argc, trunc, _ = _HDR.unpack_from(raw)
    rec = {
        "ts": ts, "tid": tid, "tgid": tgid, "ppid": ppid, "uid": uid,
        "syscall": "execveat" if is_at else "execve",
        "path": _cstr(raw[_HDR.size:_ARGS_OFF]),
        "argv": [_cstr(raw[_ARGS_OFF + i * ARGLEN:_ARGS_OFF + (i + 1) * ARGLEN]) for i in range(min(argc, MAXARGS))],
        "truncated": bool(trunc),
    }
    with _cond:
        _fresh[tid] = rec
        _cond.notify_all()


def bpf_thread():
    while True:
        bpf.perf_buffer_poll(timeout=100)


def match(tid, file):
    """Pair a pause with its eBPF record. Returns (record|None, role)."""
    start = time.monotonic()
    with _cond:
        while True:
            rec = _fresh.pop(tid, None)
            if rec:
                _used[tid] = (rec, os.path.realpath(rec["path"]) if rec["path"] else "", time.monotonic())
                return rec, "program"
            prev = _used.get(tid)
            waited = time.monotonic() - start
            # Same thread paused again for a different file: a #! script's interpreter.
            if prev and prev[1] != file and waited >= 0.005 and time.monotonic() - prev[2] < 1.0:
                return prev[0], "interpreter"
            if waited >= MATCH_WAIT:
                return (prev[0] if prev and prev[1] == file else None), "program"
            _cond.wait(0.005)


# ---- fanotify side -------------------------------------------------------

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def emit(event):
    cmd = " ".join(event.get("argv") or []) or event.get("path") or "?"
    with _log_lock:
        if VERBOSE:
            print("=" * 70, file=sys.stderr)
            print(f"  {CAPTURE_BANNER}", file=sys.stderr)
            print(f"  [{event['verdict'].upper()}] {event['syscall']} tid={event['tid']} user={event.get('user')} "
                  f"origin={event['origin']['type']} role={event['role']}", file=sys.stderr)
            print(f"  file: {event['file']}  new={event['is_new']}", file=sys.stderr)
            print(f"  by:   {event['decided_by']}: {event['reason']}  ({event['latency_ms']} ms)", file=sys.stderr)
            print("=" * 70, file=sys.stderr)
        else:
            print(f"{CAPTURE_BANNER} [{event['verdict'].upper()}] {event.get('user')}: {cmd[:200]}",
                  file=sys.stderr)
        sys.stderr.flush()
        if _log_file:
            _log_file.write(json.dumps(event, default=str) + "\n")
            _log_file.flush()


def handle(fan_fd, efd, tid):
    t0 = time.monotonic()
    answered = threading.Lock()  # first to take it answers the kernel; a late decision is dropped
    answer = {}

    def reply(allow):
        if answered.acquire(blocking=False):
            answer["allow"] = allow
            try:
                fan.respond(fan_fd, efd, allow)
            except OSError as e:
                log(f"respond failed: {e}")
            return True
        return False

    watchdog = threading.Timer(DECIDE_TIMEOUT, lambda: reply(False))
    watchdog.start()
    try:
        file = os.readlink(f"/proc/self/fd/{efd}")
        if is_loader(file):
            _stats["loader_allows"] += 1
            reply(True)
            return
        rec, role = match(tid, file)
        if rec is None:
            _stats["unmatched"] += 1
        event = {"id": uuid.uuid4().hex[:12], "time": now_iso()}
        context.gather(event, tid, efd, role, rec)
        event.update(score=None, explored=False, effects=[], score_after=None)
        try:
            d = decide(event)
        except Exception as e:  # fail closed
            d = Decision(BLOCK, "error", f"decision failed, failing closed: {e!r}")
        if event["truncated"] and d.verdict == ALLOW and d.decided_by != "stub":
            d = Decision("hold", "truncated", "arguments were cut off; never auto-allowed")
        event.update(verdict=d.verdict, decided_by=d.decided_by, reason=d.reason,
                     score=d.score, attack_id=d.attack_id)
        reply(d.verdict == ALLOW)
        if "allow" in answer and answer["allow"] != (d.verdict == ALLOW):
            event.update(verdict=BLOCK, decided_by="timeout", reason="no answer in time; denied")
        event["latency_ms"] = round((time.monotonic() - t0) * 1000, 2)
        _stats["events"] += 1
        emit(event)
    except Exception as e:
        log(f"handler error for tid {tid}: {e!r}")
        reply(False)  # unknown state: fail closed
    finally:
        watchdog.cancel()
        try:
            os.close(efd)
        except OSError:
            pass


def main():
    global bpf, _log_file
    if os.geteuid() != 0:
        sys.exit("sid-daemon must run as root")
    from bcc import BPF

    os.makedirs(os.path.dirname(EVENT_LOG), exist_ok=True)
    _log_file = open(EVENT_LOG, "a")
    own_tgid = os.getpid()

    # Phase 0: set up. eBPF first (BCC compiles in-process), then marks, last, so
    # nothing of ours can pause on itself.
    log("loading eBPF exec recorder")
    bpf = BPF(src_file=BPF_SRC)
    bpf["events"].open_perf_buffer(on_record, page_cnt=512, lost_cb=lambda *_: log("WARNING: eBPF records lost"))
    threading.Thread(target=bpf_thread, daemon=True).start()

    log(f"indexed {context.load_package_files()} package files")
    # TODO(laya): load honeytokens, tiny classifier and Laya here.

    fan_fd = fan.init()
    marked = fan.mark_all(fan_fd, log)
    log(f"capture ACTIVE on {len(marked)} filesystems: {', '.join(marked)}; events -> {EVENT_LOG}")

    sd_notify("READY=1")  # systemd (Type=notify) holds `systemctl restart` until the capture is live
    while True:
        for efd, tid in fan.read_events(fan_fd):
            # Our own threads never exec; if one somehow does, don't deadlock on ourselves.
            if tid == own_tgid or _is_own(tid, own_tgid):
                fan.respond(fan_fd, efd, True)
                os.close(efd)
                continue
            _pool.submit(handle, fan_fd, efd, tid)


def sd_notify(msg):
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
        sock.connect("\0" + addr[1:] if addr.startswith("@") else addr)
        sock.sendall(msg.encode())


def _is_own(tid, own_tgid):
    try:
        with open(f"/proc/{tid}/status") as f:
            for line in f:
                if line.startswith("Tgid:"):
                    return int(line.split()[1]) == own_tgid
    except OSError:
        pass
    return False


if __name__ == "__main__":
    main()
