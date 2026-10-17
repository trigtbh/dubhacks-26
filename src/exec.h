/* Record shared by the eBPF program and the daemon. */
#ifndef SID_EXEC_H
#define SID_EXEC_H

#ifndef __VMLINUX_H__
#include <linux/types.h>
#endif

#define SID_MAXARGS 32
#define SID_ARGLEN 256

struct exec_rec {
	__u64 ts;
	__u32 tid;
	__u32 tgid;
	__u32 ppid;
	__u32 uid;
	__u32 is_execveat;
	__u32 argc;
	__u32 truncated;
	__u32 pad;
	char path[SID_ARGLEN];
	char args[SID_MAXARGS][SID_ARGLEN];
};

#endif
