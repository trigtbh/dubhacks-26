// eBPF half of the capture. Records every execve/execveat at syscall entry.
// It cannot pause anything; fanotify does the pausing, and the daemon pairs
// the two by thread id.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include "exec.h"

char LICENSE[] SEC("license") = "GPL";

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 24);
} rb SEC(".maps");

static __always_inline int record(const char *filename, const char *const *argv, __u32 is_execveat)
{
	struct exec_rec *e = bpf_ringbuf_reserve(&rb, sizeof(*e), 0);
	if (!e)
		return 0;

	__u64 pid_tgid = bpf_get_current_pid_tgid();
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();

	e->ts = bpf_ktime_get_ns();
	e->tid = (__u32)pid_tgid;
	e->tgid = pid_tgid >> 32;
	e->ppid = BPF_CORE_READ(task, real_parent, tgid);
	e->uid = (__u32)bpf_get_current_uid_gid();
	e->is_execveat = is_execveat;
	e->argc = 0;
	e->truncated = 0;
	e->pad = 0;
	e->path[0] = 0;

	long n = bpf_probe_read_user_str(e->path, SID_ARGLEN, filename);
	if (n >= SID_ARGLEN)
		e->truncated = 1;

#pragma unroll
	for (int i = 0; i < SID_MAXARGS; i++) {
		const char *p = NULL;
		bpf_probe_read_user(&p, sizeof(p), &argv[i]);
		if (!p)
			goto done;
		n = bpf_probe_read_user_str(e->args[i], SID_ARGLEN, p);
		if (n >= SID_ARGLEN)
			e->truncated = 1;
		e->argc = i + 1;
	}
	{
		/* all slots filled: anything beyond is cut off */
		const char *p = NULL;
		bpf_probe_read_user(&p, sizeof(p), &argv[SID_MAXARGS]);
		if (p)
			e->truncated = 1;
	}
done:
	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tracepoint/syscalls/sys_enter_execve")
int tp_execve(struct trace_event_raw_sys_enter *ctx)
{
	return record((const char *)ctx->args[0], (const char *const *)ctx->args[1], 0);
}

SEC("tracepoint/syscalls/sys_enter_execveat")
int tp_execveat(struct trace_event_raw_sys_enter *ctx)
{
	return record((const char *)ctx->args[1], (const char *const *)ctx->args[2], 1);
}
