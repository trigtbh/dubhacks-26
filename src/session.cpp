#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "session_rpc.hpp"

namespace {

const char *socket_path()
{
	const char *p = getenv("SID_SESSION_SOCKET");
	return p && *p ? p : "/run/sid/session.sock";
}

int install_exec_filter()
{
#if defined(__aarch64__)
	constexpr uint32_t native_arch = AUDIT_ARCH_AARCH64;
#elif defined(__x86_64__)
	constexpr uint32_t native_arch = AUDIT_ARCH_X86_64;
#else
#error "sid-session supports native Linux ARM64 and x86_64 only"
#endif
	const sock_filter code[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, native_arch, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
		BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, __X32_SYSCALL_BIT, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
#endif
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execve, 1, 0),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execveat, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
	};
	const sock_fprog prog = {static_cast<unsigned short>(sizeof(code) / sizeof(code[0])),
		const_cast<sock_filter *>(code)};
	return syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &prog);
}

int connect_daemon()
{
	int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	if (fd < 0) return -1;
	sockaddr_un addr{};
	addr.sun_family = AF_UNIX;
	if (strlen(socket_path()) >= sizeof(addr.sun_path)) {
		close(fd);
		errno = ENAMETOOLONG;
		return -1;
	}
	strcpy(addr.sun_path, socket_path());
	if (connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0) {
		int e = errno;
		close(fd);
		errno = e;
		return -1;
	}
	return fd;
}

bool send_listener(int socket, int listener, uint32_t pid)
{
	SessionHello hello{SID_SESSION_RPC_VERSION, pid};
	iovec data{&hello, sizeof(hello)};
	char control[CMSG_SPACE(sizeof(int))]{};
	msghdr msg{};
	msg.msg_iov = &data;
	msg.msg_iovlen = 1;
	msg.msg_control = control;
	msg.msg_controllen = sizeof(control);
	struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
	cmsg->cmsg_level = SOL_SOCKET;
	cmsg->cmsg_type = SCM_RIGHTS;
	cmsg->cmsg_len = CMSG_LEN(sizeof(int));
	memcpy(CMSG_DATA(cmsg), &listener, sizeof(listener));
	return sendmsg(socket, &msg, MSG_NOSIGNAL) == static_cast<ssize_t>(sizeof(hello));
}

}  // namespace

int main()
{
	// sshd invokes this setuid-root helper as the authenticated account. The
	// filter is installed while privileged, so it persists without setting
	// no_new_privs; commands such as sudo can still change credentials normally.
	const uid_t uid = getuid();
	const gid_t gid = getgid();
	if (geteuid() != 0) {
		fprintf(stderr, "sid-session: helper must be installed setuid-root\n");
		return 1;
	}
	if (chdir("/workspace") != 0) {
		perror("sid-session: chdir /workspace");
		return 1;
	}
	int listener = install_exec_filter();
	if (listener < 0) {
		fprintf(stderr, "sid-session: cannot install exec notification filter: %s\n", strerror(errno));
		return 1;
	}
	int socket = connect_daemon();
	if (socket < 0 || !send_listener(socket, listener, static_cast<uint32_t>(getpid()))) {
		fprintf(stderr, "sid-session: cannot register with sid-daemon at %s: %s\n", socket_path(), strerror(errno));
		if (socket >= 0) close(socket);
		close(listener);
		return 1;
	}
	close(socket);
	close(listener);

	if (setresgid(gid, gid, gid) != 0 || setresuid(uid, uid, uid) != 0) {
		perror("sid-session: drop privileges");
		return 1;
	}
	const char *command = getenv("SSH_ORIGINAL_COMMAND");
	if (command && *command)
		execl("/bin/bash", "bash", "-lc", command, (char *)nullptr);
	else
		execl("/bin/bash", "bash", "-l", (char *)nullptr);
	perror("sid-session: exec bash");
	return 127;
}
