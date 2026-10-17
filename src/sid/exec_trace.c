// eBPF half of the capture (compiled by BCC at daemon start).
// Records every execve/execveat at syscall entry. It cannot pause anything;
// fanotify does the pausing, and the daemon pairs the two by thread id.
#include <linux/sched.h>

#define MAXARGS 32
#define ARGLEN 256

struct exec_t {
    u64 ts;
    u32 tid;
    u32 tgid;
    u32 ppid;
    u32 uid;
    u32 is_execveat;
    u32 argc;
    u32 truncated;
    u32 pad;
    char path[ARGLEN];
    char args[MAXARGS][ARGLEN];
};

BPF_PERCPU_ARRAY(scratch, struct exec_t, 1);
BPF_PERF_OUTPUT(events);

static __always_inline int record(void *ctx, const char *filename,
                                  const char *const *argv, u32 is_execveat)
{
    int zero = 0;
    struct exec_t *e = scratch.lookup(&zero);
    if (!e)
        return 0;

    u64 pid_tgid = bpf_get_current_pid_tgid();
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();

    e->ts = bpf_ktime_get_ns();
    e->tid = (u32)pid_tgid;
    e->tgid = pid_tgid >> 32;
    e->ppid = task->real_parent->tgid;
    e->uid = (u32)bpf_get_current_uid_gid();
    e->is_execveat = is_execveat;
    e->argc = 0;
    e->truncated = 0;
    e->path[0] = 0;

    long n = bpf_probe_read_user_str(e->path, ARGLEN, filename);
    if (n >= ARGLEN)
        e->truncated = 1;

    #pragma unroll
    for (int i = 0; i < MAXARGS; i++) {
        const char *p = NULL;
        bpf_probe_read_user(&p, sizeof(p), &argv[i]);
        if (!p)
            goto done;
        n = bpf_probe_read_user_str(e->args[i], ARGLEN, p);
        if (n >= ARGLEN)
            e->truncated = 1;
        e->argc = i + 1;
    }
    // MAXARGS strings read; anything beyond is cut off.
    {
        const char *p = NULL;
        bpf_probe_read_user(&p, sizeof(p), &argv[MAXARGS]);
        if (p)
            e->truncated = 1;
    }
done:
    events.perf_submit(ctx, e, sizeof(*e));
    return 0;
}

TRACEPOINT_PROBE(syscalls, sys_enter_execve)
{
    return record(args, args->filename, args->argv, 0);
}

TRACEPOINT_PROBE(syscalls, sys_enter_execveat)
{
    return record(args, args->filename, args->argv, 1);
}
