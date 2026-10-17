"""fanotify: pause every program launch (FAN_OPEN_EXEC_PERM) until we answer."""
import ctypes
import os
import struct

FAN_CLOEXEC = 0x1
FAN_CLASS_CONTENT = 0x4
FAN_REPORT_TID = 0x100
FAN_MARK_ADD = 0x1
FAN_MARK_FILESYSTEM = 0x100
FAN_OPEN_EXEC_PERM = 0x40000
FAN_Q_OVERFLOW = 0x4000
FAN_ALLOW, FAN_DENY = 1, 2

_EVENT = struct.Struct("IBBHQii")  # event_len vers reserved meta_len mask fd pid(tid)
_libc = ctypes.CDLL(None, use_errno=True)
_libc.fanotify_mark.argtypes = [ctypes.c_int, ctypes.c_uint, ctypes.c_uint64,
                                ctypes.c_int, ctypes.c_char_p]

# Filesystems nothing can be exec'd from.
SKIP_FSTYPES = {
    "proc", "sysfs", "cgroup", "cgroup2", "devpts", "devtmpfs", "mqueue", "tracefs",
    "debugfs", "securityfs", "pstore", "bpf", "configfs", "fusectl", "autofs",
    "binfmt_misc", "hugetlbfs", "selinuxfs", "efivarfs", "rpc_pipefs", "nsfs",
}


def init():
    fd = _libc.fanotify_init(FAN_CLOEXEC | FAN_CLASS_CONTENT | FAN_REPORT_TID, os.O_RDONLY)
    if fd < 0:
        e = ctypes.get_errno()
        raise OSError(e, f"fanotify_init: {os.strerror(e)} (need root and CONFIG_FANOTIFY_ACCESS_PERMISSIONS)")
    return fd


def mount_points():
    """(mountpoint, fstype) for every real filesystem, one per device."""
    seen, out = set(), []
    with open("/proc/self/mountinfo") as f:
        for line in f:
            left, _, right = line.partition(" - ")
            mp = left.split()[4].replace("\\040", " ")
            fstype = right.split()[0]
            if fstype in SKIP_FSTYPES:
                continue
            try:
                dev = os.stat(mp).st_dev
            except OSError:
                continue
            if dev in seen:
                continue
            seen.add(dev)
            out.append((mp, fstype))
    return out


def mark_all(fd, log):
    """Mark every executable-capable filesystem. An unmarked one is a hole."""
    marked = []
    for mp, fstype in mount_points():
        r = _libc.fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, FAN_OPEN_EXEC_PERM,
                                -100, mp.encode())
        if r == 0:
            marked.append(mp)
        else:
            log(f"fanotify: could not mark {mp} ({fstype}): {os.strerror(ctypes.get_errno())}")
    return marked


def read_events(fd):
    """Yield (event_fd, tid) for each paused open-for-exec."""
    buf = os.read(fd, 65536)
    off = 0
    while off + _EVENT.size <= len(buf):
        ev_len, _, _, _, mask, efd, tid = _EVENT.unpack_from(buf, off)
        off += ev_len
        if mask & FAN_Q_OVERFLOW or efd < 0:
            continue
        if mask & FAN_OPEN_EXEC_PERM:
            yield efd, tid
        else:
            os.close(efd)


def respond(fd, efd, allow):
    os.write(fd, struct.pack("ii", efd, FAN_ALLOW if allow else FAN_DENY))
