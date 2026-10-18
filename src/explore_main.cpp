// sid-explore: run one command against a throwaway copy-on-write view of the
// filesystem and report what it would change.
//
//   sid-explore [--uid N --gid N --groups a,b --user NAME --cwd DIR --env-pid PID
//                --exe PATH --timeout SEC --progress-fd N] -- argv...
//
// Every real mount is covered by an overlayfs whose upper layer lives on a
// private tmpfs, inside a private mount, pid, network, ipc and uts namespace.
// When this process exits the namespaces and the tmpfs go away, so nothing
// the command did reaches the real filesystem. Prints two lines of JSON: the
// summary (counts + top 5 changes), then the full report. Exit 0 on success,
// 1 if the simulation could not be set up (the JSON then carries "error").
//
// Two ways it stops early, both reported in the outcome:
//   - the command is still running at --timeout       (outcome "timed_out")
//   - the command tries to open a connection to another machine (outcome
//     "network"): a seccomp supervisor catches connect() before the kernel acts,
//     records the destination, and tears the sandbox down. Local (AF_UNIX) and
//     loopback connections are allowed through, since they reach nothing outside.
// With --progress-fd, a summary snapshot is written to that fd every ~250ms while
// the command runs, so a caller can show the file changes building up live.
// Needs root. Linux only.
#include <arpa/inet.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <sys/fanotify.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "changes.hpp"
#include "overlay_diff.hpp"

namespace {

using Clock = std::chrono::steady_clock;

const char *const kBase = "/var/lib/sid/explore";
constexpr size_t kOutputMax = 4096;

// Filesystems that hold no user files, plus the ones we rebuild ourselves.
const std::set<std::string> kSkipFs = {
    "proc", "sysfs", "cgroup", "cgroup2", "devpts", "devtmpfs", "mqueue", "tracefs", "debugfs",
    "securityfs", "pstore", "bpf", "configfs", "fusectl", "autofs", "binfmt_misc", "hugetlbfs",
    "selinuxfs", "efivarfs", "rpc_pipefs", "nsfs"};
const char *const kSkipUnder[] = {"/proc", "/sys", "/dev", kBase};

// The capabilities a default container keeps; a simulated root command gets no more.
const int kKeepCaps[] = {CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_FOWNER, CAP_FSETID, CAP_KILL, CAP_SETGID, CAP_SETUID,
			 CAP_SETPCAP, CAP_NET_BIND_SERVICE, CAP_NET_RAW, CAP_SYS_CHROOT, CAP_AUDIT_WRITE, CAP_SETFCAP};

struct Opts {
	uid_t uid = 0;
	gid_t gid = 0;
	std::vector<gid_t> groups;
	bool groups_set = false;
	std::string user, cwd = "/", exe;
	int env_pid = -1;
	int progress_fd = -1;
	double timeout = 10;
	std::vector<std::string> argv;
};

struct Layer {
	std::string mp;      // where it is mounted on the real system
	bool is_file = false;
	std::string upper, work, target;  // target: where the copy is mounted under the sandbox root
};

[[noreturn]] void die(const std::string &m) { throw std::runtime_error(m + (errno ? std::string(": ") + strerror(errno) : "")); }

bool under(const std::string &p, const std::string &d)
{
	return p == d || (p.size() > d.size() && p.compare(0, d.size(), d) == 0 && p[d.size()] == '/');
}

std::string unescape_mount(const std::string &s)  // mountinfo escapes space as \040
{
	std::string o;
	for (size_t i = 0; i < s.size(); i++)
		if (s[i] == '\\' && i + 3 < s.size() && isdigit((unsigned char)s[i + 1])) {
			o += (char)strtol(s.substr(i + 1, 3).c_str(), nullptr, 8);
			i += 3;
		} else
			o += s[i];
	return o;
}

// Mount points worth covering, parents before children, last mount at a point wins.
std::vector<std::string> mounts()
{
	std::vector<std::string> out;
	std::ifstream mi("/proc/self/mountinfo");
	std::string line;
	while (std::getline(mi, line)) {
		size_t dash = line.find(" - ");
		if (dash == std::string::npos)
			continue;
		std::istringstream left(line.substr(0, dash)), right(line.substr(dash + 3));
		std::string tok, mp, fstype;
		for (int i = 0; i < 5 && (left >> tok); i++)
			if (i == 4)
				mp = unescape_mount(tok);
		right >> fstype;
		bool skip = kSkipFs.count(fstype) || mp.find_first_of(",:\\") != std::string::npos;
		for (const char *u : kSkipUnder)
			skip = skip || under(mp, u);
		if (skip)
			continue;
		out.erase(std::remove(out.begin(), out.end(), mp), out.end());
		out.push_back(mp);
	}
	std::stable_sort(out.begin(), out.end(), [](const std::string &a, const std::string &b) {
		return std::count(a.begin(), a.end(), '/') + (a != "/") < std::count(b.begin(), b.end(), '/') + (b != "/");
	});
	return out;
}

void mkdirs(const std::string &p)
{
	for (size_t i = 1; i <= p.size(); i++)
		if (i == p.size() || p[i] == '/')
			mkdir(p.substr(0, i).c_str(), 0755);
}

bool copy_file(const std::string &from, const std::string &to)
{
	int a = open(from.c_str(), O_RDONLY | O_CLOEXEC);
	if (a < 0)
		return false;
	struct stat st;
	fstat(a, &st);
	int b = open(to.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st.st_mode & 07777);
	char buf[1 << 16];
	ssize_t n;
	while (b >= 0 && (n = read(a, buf, sizeof(buf))) > 0)
		if (write(b, buf, n) != n)
			break;
	close(a);
	if (b < 0)
		return false;
	(void)!fchown(b, st.st_uid, st.st_gid);
	fchmod(b, st.st_mode & 07777);  // not left to the umask: a mode difference reads as a change
	close(b);
	return true;
}

std::string root_path(const std::string &root, const std::string &mp) { return mp == "/" ? root : root + mp; }

// Build the sandbox root: an overlay per directory mount, a scratch copy per file mount.
std::vector<Layer> build_root(const std::string &w, const std::string &root)
{
	std::vector<Layer> layers;
	int i = 0;
	for (auto &mp : mounts()) {
		struct stat st;
		if (stat(mp.c_str(), &st) != 0)
			continue;
		Layer l;
		l.mp = mp;
		l.target = root_path(root, mp);
		std::string tag = std::to_string(i++);
		if (S_ISDIR(st.st_mode)) {
			if (mp != "/" && access(l.target.c_str(), F_OK) != 0)
				continue;  // no mount point in the parent copy; creating one would show up as a change
			l.upper = w + "/u" + tag;
			l.work = w + "/w" + tag;
			mkdirs(l.upper);
			mkdirs(l.work);
			// metacopy=off: copy-ups carry full data, so the upper file is always the whole new content.
			std::string o = "lowerdir=" + mp + ",upperdir=" + l.upper + ",workdir=" + l.work +
					",redirect_dir=off,metacopy=off,index=off";
			if (mount("overlay", l.target.c_str(), "overlay", 0, o.c_str()) != 0) {
				if (mp == "/")
					die("overlay on /");
				fprintf(stderr, "sid-explore: skipping %s: overlay failed: %s\n", mp.c_str(), strerror(errno));
				continue;
			}
		} else if (S_ISREG(st.st_mode)) {
			l.is_file = true;
			l.upper = w + "/f" + tag;
			if (access(l.target.c_str(), F_OK) != 0 || !copy_file(mp, l.upper) ||
			    mount(l.upper.c_str(), l.target.c_str(), nullptr, MS_BIND, nullptr) != 0)
				continue;
		} else
			continue;
		layers.push_back(l);
	}
	return layers;
}

// /dev for the sandbox: a small tmpfs with the harmless character devices only.
void build_dev(const std::string &root)
{
	std::string dev = root + "/dev";
	if (mount("tmpfs", dev.c_str(), "tmpfs", MS_NOSUID | MS_NOEXEC, "mode=755,size=1m") != 0)
		die("tmpfs on /dev");
	for (const char *n : {"null", "zero", "full", "random", "urandom", "tty"}) {
		std::string t = dev + "/" + n;
		close(open(t.c_str(), O_CREAT | O_WRONLY | O_CLOEXEC, 0666));
		mount((std::string("/dev/") + n).c_str(), t.c_str(), nullptr, MS_BIND, nullptr);
	}
	mkdir((dev + "/shm").c_str(), 01777);
	mount("tmpfs", (dev + "/shm").c_str(), "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777,size=64m");
	for (auto &l : {std::make_pair("/proc/self/fd", "/fd"), std::make_pair("/proc/self/fd/0", "/stdin"),
			std::make_pair("/proc/self/fd/1", "/stdout"), std::make_pair("/proc/self/fd/2", "/stderr")})
		(void)!symlink(l.first, (dev + l.second).c_str());
}

void ro_bind(const std::string &src, const std::string &dst, bool rec)
{
	if (mount(src.c_str(), dst.c_str(), nullptr, MS_BIND | (rec ? MS_REC : 0), nullptr) == 0)
		mount(nullptr, dst.c_str(), nullptr, MS_BIND | MS_REMOUNT | MS_RDONLY | (rec ? MS_REC : 0), nullptr);
}

std::vector<std::string> read_env(int pid)
{
	std::vector<std::string> env;
	if (pid > 0) {
		std::ifstream f("/proc/" + std::to_string(pid) + "/environ", std::ios::binary);
		std::string kv;
		while (std::getline(f, kv, '\0'))
			if (!kv.empty())
				env.push_back(kv);
	}
	if (env.empty())
		env = {"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"};
	return env;
}

// ---- network-attempt detection via seccomp user notification -------------------
//
// The command runs in an empty network namespace, so a real external connection
// is already impossible. We also want to notice the *attempt*, stop, and tell the
// person. A seccomp filter traps connect() and hands each one to this process
// (the supervisor), which is in an ancestor pid namespace and can read the target
// address out of the calling thread's memory to decide: local/loopback -> let it
// through; anything else -> an external attempt.

#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif

// Install a filter that traps connect() to the returned listener fd. Best effort:
// -1 (with the command still runnable) if the kernel lacks user notifications.
int install_connect_filter()
{
	struct sock_filter prog[] = {
	    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
	    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 0, 3),
	    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
	    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
	    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
	    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),  // other arch or other syscall: allow
	};
	struct sock_fprog fprog = {sizeof(prog) / sizeof(prog[0]), prog};
	// Installed while the child is still root (CAP_SYS_ADMIN in this namespace), so
	// no PR_SET_NO_NEW_PRIVS is needed and setuid binaries in the sandbox still work.
	// The filter persists across the later setuid and the execve.
	return syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &fprog);
}

// Send one byte, plus `fd` as an SCM_RIGHTS control message when fd >= 0.
void send_fd(int sock, int fd)
{
	char c = fd >= 0 ? 'y' : 'n';
	iovec io{&c, 1};
	char cbuf[CMSG_SPACE(sizeof(int))] = {};
	msghdr msg{};
	msg.msg_iov = &io;
	msg.msg_iovlen = 1;
	if (fd >= 0) {
		msg.msg_control = cbuf;
		msg.msg_controllen = sizeof(cbuf);
		cmsghdr *cm = CMSG_FIRSTHDR(&msg);
		cm->cmsg_level = SOL_SOCKET;
		cm->cmsg_type = SCM_RIGHTS;
		cm->cmsg_len = CMSG_LEN(sizeof(int));
		memcpy(CMSG_DATA(cm), &fd, sizeof(int));
	}
	(void)!sendmsg(sock, &msg, 0);
}

// Wait up to timeout_ms for the byte+fd from send_fd. Returns the fd, or -1.
int recv_fd(int sock, int timeout_ms)
{
	pollfd pf{sock, POLLIN, 0};
	if (poll(&pf, 1, timeout_ms) <= 0)
		return -1;
	char c;
	iovec io{&c, 1};
	char cbuf[CMSG_SPACE(sizeof(int))] = {};
	msghdr msg{};
	msg.msg_iov = &io;
	msg.msg_iovlen = 1;
	msg.msg_control = cbuf;
	msg.msg_controllen = sizeof(cbuf);
	if (recvmsg(sock, &msg, 0) <= 0)
		return -1;
	for (cmsghdr *cm = CMSG_FIRSTHDR(&msg); cm; cm = CMSG_NXTHDR(&msg, cm))
		if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS) {
			int fd;
			memcpy(&fd, CMSG_DATA(cm), sizeof(int));
			return fd;
		}
	return -1;
}

bool is_loopback(const sockaddr_storage &ss)
{
	if (ss.ss_family == AF_INET) {
		uint32_t a = ntohl(reinterpret_cast<const sockaddr_in &>(ss).sin_addr.s_addr);
		return (a >> 24) == 127;  // 127.0.0.0/8
	}
	if (ss.ss_family == AF_INET6) {
		const auto &a6 = reinterpret_cast<const sockaddr_in6 &>(ss).sin6_addr;
		return IN6_IS_ADDR_LOOPBACK(&a6);
	}
	return false;
}

// "93.184.215.14:443", or "[::1]:80", or "" if not an IP address we can print.
std::string addr_text(const sockaddr_storage &ss)
{
	char ip[64] = {};
	if (ss.ss_family == AF_INET) {
		const auto &s = reinterpret_cast<const sockaddr_in &>(ss);
		inet_ntop(AF_INET, &s.sin_addr, ip, sizeof(ip));
		return std::string(ip) + ":" + std::to_string(ntohs(s.sin_port));
	}
	if (ss.ss_family == AF_INET6) {
		const auto &s = reinterpret_cast<const sockaddr_in6 &>(ss);
		inet_ntop(AF_INET6, &s.sin6_addr, ip, sizeof(ip));
		return "[" + std::string(ip) + "]:" + std::to_string(ntohs(s.sin6_port));
	}
	return "";
}

std::string comm_of(int pid)
{
	std::ifstream f("/proc/" + std::to_string(pid) + "/comm");
	std::string c;
	std::getline(f, c);
	return c;
}

// Runs as pid 1 of the new pid namespace: mount /proc, start the command, reap.
// `sp` is a socket on which the command child sends its seccomp listener fd.
[[noreturn]] void sandbox_init(const Opts &o, const std::string &root, int out_fd, int sp)
{
	try {
		std::string proc = root + "/proc";
		if (mount("proc", proc.c_str(), "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, nullptr) != 0)
			die("mount /proc");
		for (const char *p : {"/sys", "/irq", "/bus", "/sysrq-trigger"})
			ro_bind(proc + p, proc + p, false);
		ro_bind("/sys", root + "/sys", true);
	} catch (const std::exception &e) {
		dprintf(out_fd, "sid-explore: %s\n", e.what());
		_exit(126);
	}
	pid_t cmd = fork();
	if (cmd == 0) {
		int null = open((root + "/dev/null").c_str(), O_RDONLY);
		dup2(null, 0);
		dup2(out_fd, 1);
		dup2(out_fd, 2);
		setsid();
		std::vector<std::string> env = read_env(o.env_pid);
		if (chroot(root.c_str()) != 0 || (chdir(o.cwd.c_str()) != 0 && chdir("/") != 0))
			_exit(126);
		// Trap connect() to the supervisor while still root, and hand it the listener.
		// The filter is inherited across the exec and by any child the command spawns.
		int listener = install_connect_filter();
		send_fd(sp, listener);
		if (listener >= 0)
			close(listener);
		for (int c = 0; c <= CAP_LAST_CAP; c++)
			if (std::find(std::begin(kKeepCaps), std::end(kKeepCaps), c) == std::end(kKeepCaps))
				prctl(PR_CAPBSET_DROP, c, 0, 0, 0);
		std::vector<gid_t> groups = o.groups_set ? o.groups : std::vector<gid_t>{o.gid};
		if (setgroups(groups.size(), groups.data()) != 0 || setgid(o.gid) != 0 || setuid(o.uid) != 0)
			_exit(126);
		std::vector<char *> av, ev;
		for (auto &a : o.argv)
			av.push_back(const_cast<char *>(a.c_str()));
		av.push_back(nullptr);
		for (auto &e : env)
			ev.push_back(const_cast<char *>(e.c_str()));
		ev.push_back(nullptr);
		if (!o.exe.empty())
			execve(o.exe.c_str(), av.data(), ev.data());
		execvpe(av[0], av.data(), ev.data());
		dprintf(2, "sid-explore: cannot run %s: %s\n", av[0], strerror(errno));
		_exit(127);
	}
	int status = 0, code = 127;
	for (;;) {
		pid_t p = wait(&status);
		if (p < 0)
			break;
		if (p == cmd)
			code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
	}
	_exit(code);  // also kills anything the command left running: we are the namespace's init
}

std::string fd_path(int fd)
{
	char buf[4096];
	ssize_t n = readlink(("/proc/self/fd/" + std::to_string(fd)).c_str(), buf, sizeof(buf) - 1);
	return n < 0 ? std::string() : std::string(buf, n);
}

struct Access {
	std::set<std::string> read, written, executed;
};

// Map a path seen through the sandbox back to the path the user knows.
std::string shown_path(const std::string &p, const std::string &root, const std::vector<Layer> &layers)
{
	for (auto &l : layers)
		if (l.is_file && p == l.upper)
			return l.mp;
	if (p == root)
		return "/";
	if (under(p, root))
		return p.substr(root.size());
	return "";
}

void drain(int fan, const std::string &root, const std::vector<Layer> &layers, Access &acc)
{
	alignas(fanotify_event_metadata) char buf[16384];
	for (;;) {
		ssize_t n = read(fan, buf, sizeof(buf));
		if (n <= 0)
			return;
		for (auto *m = reinterpret_cast<fanotify_event_metadata *>(buf); FAN_EVENT_OK(m, n); m = FAN_EVENT_NEXT(m, n)) {
			if (m->fd < 0)
				continue;
			std::string p = shown_path(fd_path(m->fd), root, layers);
			close(m->fd);
			if (p.empty())
				continue;
			if (m->mask & FAN_OPEN_EXEC)
				acc.executed.insert(p);
			if (m->mask & FAN_CLOSE_WRITE)
				acc.written.insert(p);
			else if (m->mask & FAN_CLOSE_NOWRITE)
				acc.read.insert(p);
		}
	}
}

// Diff every layer's upper against its lower into one ranked change list. Reads
// only the upper and lower trees, never the live overlay, so it is safe to call
// repeatedly while the command is still running.
std::vector<Change> collect_changes(const std::vector<Layer> &layers)
{
	std::vector<Change> all;
	for (auto &l : layers) {
		if (l.is_file) {
			Change c;
			if (diff_file(l.mp, l.upper, l.mp, c))
				all.push_back(c);
			continue;
		}
		auto v = diff_overlay(l.upper, l.mp, l.mp);
		all.insert(all.end(), v.begin(), v.end());
	}
	pair_moves(all);
	rank(all);
	return all;
}

// Fill the files-read / files-executed lists from what fanotify saw.
void fill_access(Report &r, const Access &acc)
{
	r.read.clear();
	for (auto &p : acc.read)
		if (!acc.written.count(p))
			r.read.push_back(p);
	r.executed.assign(acc.executed.begin(), acc.executed.end());
}

// One summary snapshot of the changes so far, for a caller watching live.
void emit_progress(int fd, const Opts &o, const std::vector<Layer> &layers, const Access &acc, double elapsed_ms)
{
	if (fd < 0)
		return;
	Report snap;
	snap.argv = o.argv;
	snap.cwd = o.cwd;
	snap.user = o.user.empty() ? std::to_string(o.uid) : o.user;
	snap.finished = false;
	snap.outcome = kOutcomeRunning;
	snap.elapsed_ms = elapsed_ms;
	snap.changes = collect_changes(layers);
	fill_access(snap, acc);
	std::string line = summary_json(snap) + "\n";
	(void)!write(fd, line.data(), line.size());
}

// Handle one trapped connect(). Returns true and fills `attempt` if it targets
// an external machine (so the simulation should stop); false means it was local
// or loopback and has been allowed to proceed.
bool handle_connect(int notif, NetAttempt &attempt)
{
	seccomp_notif req{};
	seccomp_notif_resp resp{};
	if (ioctl(notif, SECCOMP_IOCTL_NOTIF_RECV, &req) != 0)
		return false;
	resp.id = req.id;

	sockaddr_storage ss{};
	uint64_t ptr = req.data.args[1];
	uint64_t len = std::min<uint64_t>(req.data.args[2], sizeof(ss));
	bool read_ok = false;
	int mfd = open(("/proc/" + std::to_string(req.pid) + "/mem").c_str(), O_RDONLY | O_CLOEXEC);
	if (mfd >= 0) {
		read_ok = pread(mfd, &ss, len, (off_t)ptr) == (ssize_t)len;
		close(mfd);
	}

	// Local sockets, loopback, and anything we could not read: let it through.
	// (The empty netns still blocks any real connectivity.) Only a clearly
	// external IP destination counts as an attempt worth stopping for.
	bool external = read_ok && (ss.ss_family == AF_INET || ss.ss_family == AF_INET6) && !is_loopback(ss);
	if (!external) {
		resp.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
		ioctl(notif, SECCOMP_IOCTL_NOTIF_SEND, &resp);
		return false;
	}
	attempt.program = comm_of(req.pid);
	attempt.destination = addr_text(ss);
	attempt.detail = "connect";
	resp.error = -ENETUNREACH;  // deny the call; we are tearing the sandbox down anyway
	ioctl(notif, SECCOMP_IOCTL_NOTIF_SEND, &resp);
	return true;
}

Opts parse(int argc, char **argv)
{
	Opts o;
	int i = 1;
	auto val = [&](const char *flag) -> std::string {
		if (i + 1 >= argc)
			throw std::runtime_error(std::string(flag) + " needs a value");
		return argv[++i];
	};
	for (; i < argc; i++) {
		std::string a = argv[i];
		if (a == "--") {
			i++;
			break;
		} else if (a == "--uid")
			o.uid = std::stoul(val("--uid"));
		else if (a == "--gid")
			o.gid = std::stoul(val("--gid"));
		else if (a == "--groups") {
			std::stringstream ss(val("--groups"));
			std::string g;
			while (std::getline(ss, g, ','))
				if (!g.empty())
					o.groups.push_back(std::stoul(g));
			o.groups_set = true;
		} else if (a == "--user")
			o.user = val("--user");
		else if (a == "--cwd")
			o.cwd = val("--cwd");
		else if (a == "--exe")
			o.exe = val("--exe");
		else if (a == "--env-pid")
			o.env_pid = std::stoi(val("--env-pid"));
		else if (a == "--progress-fd")
			o.progress_fd = std::stoi(val("--progress-fd"));
		else if (a == "--timeout")
			o.timeout = std::stod(val("--timeout"));
		else
			throw std::runtime_error("unknown option " + a);
	}
	for (; i < argc; i++)
		o.argv.push_back(argv[i]);
	if (o.argv.empty())
		throw std::runtime_error("usage: sid-explore [options] -- command [args...]");
	return o;
}

void simulate(const Opts &o, Report &r)
{
	auto t0 = Clock::now();
	// CLONE_NEWPID applies to our children: the fork below becomes pid 1 there.
	if (unshare(CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS) != 0)
		die("unshare");
	if (mount(nullptr, "/", nullptr, MS_REC | MS_PRIVATE, nullptr) != 0)
		die("making mounts private");
	// A fresh tmpfs, private to this namespace: upper layers never land on a real filesystem.
	const char *size = getenv("SID_EXPLORE_SIZE");
	mkdirs(kBase);
	if (mount("tmpfs", kBase, "tmpfs", 0, (std::string("mode=700,size=") + (size && *size ? size : "1g")).c_str()) != 0)
		die("tmpfs on " + std::string(kBase));
	std::string w = kBase, root = w + "/root";
	mkdirs(root);

	std::vector<Layer> layers = build_root(w, root);
	build_dev(root);

	int fan = fanotify_init(FAN_CLASS_NOTIF | FAN_CLOEXEC | FAN_NONBLOCK, O_RDONLY | O_LARGEFILE);
	if (fan < 0)
		die("fanotify_init");
	const uint64_t mask = FAN_CLOSE_NOWRITE | FAN_CLOSE_WRITE | FAN_OPEN_EXEC;
	for (auto &l : layers)
		fanotify_mark(fan, FAN_MARK_ADD | (l.is_file ? 0 : FAN_MARK_MOUNT), mask, AT_FDCWD, l.target.c_str());

	int out_fd = open((w + "/output").c_str(), O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
	// The command child sends its seccomp listener back over this socket.
	int sp[2];
	if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sp) != 0)
		die("socketpair");
	pid_t init = fork();
	if (init < 0)
		die("fork");
	if (init == 0) {
		close(sp[0]);
		sandbox_init(o, root, out_fd, sp[1]);
	}
	close(sp[1]);
	int notif = recv_fd(sp[0], 3000);  // -1 if the kernel has no user notifications
	close(sp[0]);

	Access acc;
	int status = 0;
	bool done = false, reaped = false;
	auto t_snap = t0;
	auto deadline = t0 + std::chrono::milliseconds((long)(o.timeout * 1000));
	while (!done) {
		pollfd pfds[2] = {{fan, POLLIN, 0}, {notif, POLLIN, 0}};
		poll(pfds, notif >= 0 ? 2 : 1, 50);
		drain(fan, root, layers, acc);
		if (notif >= 0 && (pfds[1].revents & POLLIN)) {
			NetAttempt attempt;
			if (handle_connect(notif, attempt)) {
				r.outcome = kOutcomeNetwork;
				r.network.push_back(attempt);
				done = true;
			}
		}
		if (!done && waitpid(init, &status, WNOHANG) == init) {
			r.outcome = kOutcomeCompleted;
			reaped = true;
			done = true;
		}
		if (!done && Clock::now() > deadline) {
			r.outcome = kOutcomeTimedOut;
			r.timed_out = true;
			done = true;
		}
		if (o.progress_fd >= 0 && Clock::now() - t_snap >= std::chrono::milliseconds(250)) {
			t_snap = Clock::now();
			emit_progress(o.progress_fd, o, layers, acc, std::chrono::duration<double, std::milli>(t_snap - t0).count());
		}
	}
	// Collapse the sandbox: killing pid 1 of the namespace stops the command and
	// anything it spawned. Skip it when the command already exited on its own.
	if (!reaped) {
		kill(init, SIGKILL);  // takes the whole pid namespace with it
		waitpid(init, &status, 0);
	}
	if (notif >= 0)
		close(notif);
	drain(fan, root, layers, acc);
	close(fan);
	r.exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
	// A command that died on a fatal signal crashed. sandbox_init reports it to us
	// as exit code 128+signal, so recover the signal here. This is not a timeout or
	// a network stop, so only reclassify a run that otherwise completed on its own.
	if (r.outcome == kOutcomeCompleted && r.exit_code > 128) {
		int sig = r.exit_code - 128;
		if (sig == SIGSEGV || sig == SIGABRT || sig == SIGBUS || sig == SIGILL || sig == SIGFPE || sig == SIGSYS ||
		    sig == SIGTRAP || sig == SIGQUIT)
			r.outcome = kOutcomeCrashed;
	}

	char buf[kOutputMax];
	ssize_t n = pread(out_fd, buf, sizeof(buf), 0);
	r.output.assign(buf, n > 0 ? n : 0);
	close(out_fd);

	r.changes = collect_changes(layers);
	fill_access(r, acc);
	r.finished = true;
	r.elapsed_ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

}  // namespace

int main(int argc, char **argv)
{
	Report r;
	int rc = 0;
	try {
		Opts o = parse(argc, argv);
		r.argv = o.argv;
		r.cwd = o.cwd;
		r.user = o.user.empty() ? std::to_string(o.uid) : o.user;
		if (geteuid() != 0)
			throw std::runtime_error("sid-explore must run as root");
		simulate(o, r);
	} catch (const std::exception &e) {
		r.error = e.what();
		r.outcome = kOutcomeError;
		rc = 1;
	}
	printf("%s\n%s\n", summary_json(r).c_str(), full_json(r).c_str());
	return rc;
}
