// sid-daemon: passive command capture.
//
// fanotify (FAN_OPEN_EXEC_PERM) freezes every program launch; an eBPF program
// records the command. We pair them by thread id, gather context, run
// decide(), and answer the kernel. Needs root. If this process dies the kernel
// allows every paused program, so run it under systemd with Restart=always.
//
// Start the persistent model child before capture. During capture, model calls
// use its private socket; our children (including simulations) bypass capture.
// Fanotify mode must not exec children after capture starts; session mode uses
// seccomp filters installed only in authenticated SSH session processes.
#include <bpf/libbpf.h>
#include <linux/seccomp.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>

#include <atomic>
#include <algorithm>
#include <cerrno>
#include <cstdarg>
#include <cstddef>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <memory>
#include <mutex>
#include <random>
#include <thread>
#include <unordered_map>

#include "context.hpp"
#include "decide.hpp"
#include "fan.hpp"
#include "session_rpc.hpp"

namespace {

using Clock = std::chrono::steady_clock;

const char *const kBanner = "THIS IS BEING RUN IN THE CAPTURE";
constexpr int kWorkers = 128;
constexpr auto kMatchWait = std::chrono::milliseconds(50);  // for a late eBPF record

std::string env(const char *k, const char *dflt)
{
	const char *v = getenv(k);
	return v && *v ? v : dflt;
}

const std::string g_log_path = env("SID_EVENT_LOG", "/var/log/sid/events.jsonl");
const std::string g_bpf_obj = env("SID_BPF_OBJ", "/usr/local/lib/sid/exec_trace.bpf.o");
const std::string g_capture_backend = env("SID_CAPTURE_BACKEND", "fanotify");
const std::string g_session_socket = env("SID_SESSION_SOCKET", "/run/sid/session.sock");
const bool g_verbose = env("SID_VERBOSE", "0") == "1";  // multi-line banner per exec
const auto g_timeout = std::chrono::milliseconds((long)(atof(env("SID_DECIDE_TIMEOUT", "2").c_str()) * 1000));

std::mutex g_out_mu;
FILE *g_log = nullptr;

void say(const std::string &m)
{
	std::lock_guard<std::mutex> g(g_out_mu);
	fprintf(stderr, "sid-daemon: %s\n", m.c_str());
}

// ---- eBPF records, paired with pauses by thread id --------------------------

struct Used {
	exec_rec rec;
	std::string resolved;
	Clock::time_point at;
};

std::mutex g_mu;
std::condition_variable g_cv;
std::unordered_map<uint32_t, exec_rec> g_fresh;  // record not yet claimed by a pause
std::unordered_map<uint32_t, Used> g_used;       // for the #! interpreter's second pause

int on_record(void *, void *data, size_t size)
{
	if (size != sizeof(exec_rec))
		return 0;
	const auto *r = static_cast<const exec_rec *>(data);
	{
		std::lock_guard<std::mutex> g(g_mu);
		g_fresh[r->tid] = *r;
		if (g_fresh.size() > 65536)  // execs that never paused (failed, ignored): don't grow forever
			g_fresh.clear();
	}
	g_cv.notify_all();
	return 0;
}

std::string real(const std::string &p)
{
	char buf[4096];
	return p.empty() || !realpath(p.c_str(), buf) ? p : std::string(buf);
}

// Returns the matching record (copied into `out`) or false. `role` is set to
// "interpreter" when the same thread pauses again for a different file.
bool match(uint32_t tid, const std::string &file, exec_rec &out, const char *&role)
{
	auto start = Clock::now();
	std::unique_lock<std::mutex> lk(g_mu);
	for (;;) {
		auto f = g_fresh.find(tid);
		if (f != g_fresh.end()) {
			out = f->second;
			g_fresh.erase(f);
			Used u{out, real(out.path), Clock::now()};
			g_used[tid] = u;
			role = "program";
			return true;
		}
		auto waited = Clock::now() - start;
		auto u = g_used.find(tid);
		if (u != g_used.end() && u->second.resolved != file && waited >= std::chrono::milliseconds(5) &&
		    Clock::now() - u->second.at < std::chrono::seconds(1)) {
			out = u->second.rec;
			role = "interpreter";
			return true;
		}
		if (waited >= kMatchWait) {
			role = "program";
			if (u != g_used.end() && u->second.resolved == file) {
				out = u->second.rec;
				return true;
			}
			return false;
		}
		g_cv.wait_for(lk, std::chrono::milliseconds(5));
	}
}

// ---- answering the kernel, with a per-event deadline ------------------------

struct Pending {
	int ffd = -1, efd = -1, nfd = -1;
	uint64_t notif_id = 0;
	Clock::time_point deadline;
	std::atomic<bool> answered{false};
	std::atomic<bool> allow{false};

	// First caller answers the kernel; a late decision is dropped.
	bool reply(bool a)
	{
		if (answered.exchange(true))
			return false;
		allow.store(a);
		try {
			if (nfd >= 0) {
				seccomp_notif_resp response{};
				response.id = notif_id;
				response.error = a ? 0 : -EACCES;
				if (a) response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
				if (ioctl(nfd, SECCOMP_IOCTL_NOTIF_SEND, &response) != 0 && errno != ENOENT)
					say(std::string("seccomp response failed: ") + strerror(errno));
			} else {
				fan::respond(ffd, efd, a);
			}
		} catch (const std::exception &e) {
			say(e.what());
		}
		return true;
	}
};

std::mutex g_pend_mu;
std::vector<std::shared_ptr<Pending>> g_pending;
thread_local Pending *t_pending = nullptr;  // the event this worker is deciding

void watchdog()
{
	for (;;) {
		std::this_thread::sleep_for(std::chrono::milliseconds(50));
		std::lock_guard<std::mutex> g(g_pend_mu);
		auto now = Clock::now();
		for (auto &p : g_pending)
			if (now > p->deadline)
				p->reply(false);
	}
}

void unregister(const std::shared_ptr<Pending> &p)
{
	std::lock_guard<std::mutex> g(g_pend_mu);
	for (size_t i = 0; i < g_pending.size(); i++)
		if (g_pending[i] == p) {
			g_pending[i] = g_pending.back();
			g_pending.pop_back();
			return;
		}
}

// ---- events ------------------------------------------------------------------

std::string now_iso()
{
	timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	tm t;
	gmtime_r(&ts.tv_sec, &t);
	char buf[48];
	size_t n = strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &t);
	snprintf(buf + n, sizeof(buf) - n, ".%03ld+00:00", ts.tv_nsec / 1000000);
	return buf;
}

std::string new_id()
{
	static std::atomic<uint64_t> n{0};
	static const uint64_t salt = std::random_device{}();
	char buf[24];
	snprintf(buf, sizeof(buf), "%08x%04x", (unsigned)salt, (unsigned)(n++ & 0xffff));
	return buf;
}

void emit(const Event &ev)
{
	std::string cmd;
	for (auto &a : ev.argv)
		cmd += (cmd.empty() ? "" : " ") + a;
	if (cmd.empty())
		cmd = ev.path;
	std::string verdict = ev.verdict;
	for (auto &c : verdict)
		c = toupper(c);

	std::lock_guard<std::mutex> g(g_out_mu);
	if (g_verbose) {
		fprintf(stderr, "======================================================================\n"
				"  %s\n  [%s] %s tid=%u user=%s origin=%s role=%s\n  file: %s  new=%d\n"
				"  cmd:  %.300s\n  by:   %s: %s  (%.1f ms)\n"
				"======================================================================\n",
			kBanner, verdict.c_str(), ev.syscall.c_str(), ev.tid, ev.user.c_str(), ev.origin_type.c_str(),
			ev.role.c_str(), ev.file.c_str(), ev.is_new, cmd.c_str(), ev.decided_by.c_str(), ev.reason.c_str(),
			ev.latency_ms);
	} else {
		fprintf(stderr, "%s [%s] %s: %.200s\n", kBanner, verdict.c_str(), ev.user.c_str(), cmd.c_str());
	}
	if (g_log) {
		std::string j = ev.to_json();
		fwrite(j.data(), 1, j.size(), g_log);
		fputc('\n', g_log);
		fflush(g_log);
	}
}

bool is_loader(const std::string &file)
{
	size_t i = file.rfind('/');
	std::string b = i == std::string::npos ? file : file.substr(i + 1);
	return b.rfind("ld-linux", 0) == 0 || (b.rfind("ld-", 0) == 0 && b.find(".so") != std::string::npos);
}

uint32_t g_own_tgid;

// One field of /proc/<pid>/status, or -1.
long status_num(uint32_t pid, const char *key)
{
	FILE *f = fopen(("/proc/" + std::to_string(pid) + "/status").c_str(), "re");
	if (!f)
		return -1;
	char line[256];
	size_t n = strlen(key);
	long v = -1;
	while (fgets(line, sizeof(line), f))
		if (strncmp(line, key, n) == 0 && line[n] == ':') {
			v = atol(line + n + 1);
			break;
		}
	fclose(f);
	return v;
}

// Our own threads and descendants: the model worker and sid-explore simulations
// must not pause on our decisions.
bool is_own(uint32_t tid)
{
	long tgid = status_num(tid, "Tgid");
	if (tgid == (long)g_own_tgid)
		return true;
	long p = tgid > 0 ? status_num((uint32_t)tgid, "PPid") : -1;
	for (int depth = 0; p > 1 && depth < 64; depth++) {
		if (p == (long)g_own_tgid)
			return true;
		p = status_num((uint32_t)p, "PPid");
	}
	return false;
}

void handle(int ffd, int efd, uint32_t tid)
{
	auto t0 = Clock::now();
	auto pend = std::make_shared<Pending>();
	pend->ffd = ffd;
	pend->efd = efd;
	pend->deadline = t0 + g_timeout;
	{
		std::lock_guard<std::mutex> g(g_pend_mu);
		g_pending.push_back(pend);
	}
	try {
		char link[4096];
		ssize_t n = readlink(("/proc/self/fd/" + std::to_string(efd)).c_str(), link, sizeof(link) - 1);
		std::string file = n > 0 ? std::string(link, n) : std::string();
		if (is_loader(file)) {
			pend->reply(true);
		} else {
			exec_rec rec;
			const char *role = "program";
			bool matched = match(tid, file, rec, role);
			Event ev;
			ev.id = new_id();
			ev.time = now_iso();
			gather(ev, tid, efd, role, matched ? &rec : nullptr);

			Decision d;
			t_pending = pend.get();
			try {
				d = decide(ev);
			} catch (const std::exception &e) {  // fail closed
				d.verdict = Verdict::Block;
				d.decided_by = "error";
				d.reason = std::string("decision failed, failing closed: ") + e.what();
			}
			t_pending = nullptr;
			ev.explored = d.explored;
			ev.effects = d.effects;
			ev.has_result = d.has_result;
			ev.result_exit = d.result_exit;
			ev.result_success = d.result_success;
			ev.result_output = d.result_output;
			ev.verdict = verdict_name(d.verdict);
			ev.decided_by = d.decided_by;
			ev.reason = d.reason;
			ev.model_json = d.model_json;
			ev.attack_id = d.attack_id;
			ev.has_score = d.has_score;
			ev.score = d.score;
			if (!pend->reply(d.verdict == Verdict::Allow) && pend->allow.load() != (d.verdict == Verdict::Allow)) {
				ev.verdict = "block";
				ev.decided_by = "timeout";
				ev.reason = "no answer in time; denied";
			}
			ev.latency_ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
			emit(ev);
		}
	} catch (const std::exception &e) {
		say(std::string("handler error for tid ") + std::to_string(tid) + ": " + e.what());
		pend->reply(false);  // unknown state: fail closed
	}
	unregister(pend);
	close(efd);
}

std::string read_remote(pid_t pid, uintptr_t address, size_t limit, bool *truncated = nullptr)
{
	std::string out;
	if (!address) return out;
	while (out.size() < limit) {
		char chunk[256];
		size_t want = std::min(sizeof(chunk), limit - out.size());
		iovec local{chunk, want};
		iovec remote{reinterpret_cast<void *>(address + out.size()), want};
		ssize_t n = process_vm_readv(pid, &local, 1, &remote, 1, 0);
		if (n <= 0) break;
		const void *zero = memchr(chunk, 0, n);
		size_t got = zero ? static_cast<const char *>(zero) - chunk : static_cast<size_t>(n);
		out.append(chunk, got);
		if (zero) return out;
		if (static_cast<size_t>(n) < want) break;
	}
	if (truncated && out.size() >= limit) *truncated = true;
	return out;
}

void copy_field(char *dst, size_t cap, const std::string &src, bool &truncated)
{
	const size_t n = std::min(cap - 1, src.size());
	memcpy(dst, src.data(), n);
	dst[n] = 0;
	if (src.size() > n) truncated = true;
}

std::string proc_link(pid_t pid, const std::string &name)
{
	char buf[4096];
	std::string path = "/proc/" + std::to_string(pid) + "/" + name;
	ssize_t n = readlink(path.c_str(), buf, sizeof(buf));
	return n > 0 ? std::string(buf, n) : std::string();
}

std::string exec_path(pid_t pid, const seccomp_notif &req, const std::string &name, bool execveat)
{
	const std::string proc = "/proc/" + std::to_string(pid);
	if (!execveat) return name.empty() || name[0] == '/' ? proc + "/root" + name : proc + "/cwd/" + name;
	const int dirfd = static_cast<int64_t>(req.data.args[0]);
	const uint64_t flags = req.data.args[4];
	if (name.empty() && (flags & AT_EMPTY_PATH))
		return dirfd == AT_FDCWD ? proc + "/cwd" : proc + "/fd/" + std::to_string(dirfd);
	if (!name.empty() && name[0] == '/') return proc + "/root" + name;
	if (dirfd == AT_FDCWD) return proc + "/cwd/" + name;
	return proc + "/fd/" + std::to_string(dirfd) + "/" + name;
}

bool read_exec_rec(pid_t pid, const seccomp_notif &req, exec_rec &rec, std::string &open_path)
{
	const bool at = req.data.nr == __NR_execveat;
	const uintptr_t name_ptr = req.data.args[at ? 1 : 0];
	const uintptr_t argv_ptr = req.data.args[at ? 2 : 1];
	bool truncated = false;
	const std::string path_arg = read_remote(pid, name_ptr, SID_ARGLEN - 1, &truncated);
	std::string name = path_arg;
	if (path_arg.empty() && !(at && (req.data.args[4] & AT_EMPTY_PATH))) return false;
	if (name.empty()) {
		int dirfd = static_cast<int64_t>(req.data.args[0]);
		name = dirfd == AT_FDCWD ? proc_link(pid, "cwd") : proc_link(pid, "fd/" + std::to_string(dirfd));
	}
	copy_field(rec.path, sizeof(rec.path), name, truncated);
	rec.is_execveat = at;
	for (unsigned i = 0; i < SID_MAXARGS; ++i) {
		uintptr_t arg_ptr = 0;
		iovec local{&arg_ptr, sizeof(arg_ptr)};
		iovec remote{reinterpret_cast<void *>(argv_ptr + i * sizeof(arg_ptr)), sizeof(arg_ptr)};
		if (process_vm_readv(pid, &local, 1, &remote, 1, 0) != sizeof(arg_ptr) || !arg_ptr) break;
		std::string arg = read_remote(pid, arg_ptr, SID_ARGLEN - 1, &truncated);
		copy_field(rec.args[i], sizeof(rec.args[i]), arg, truncated);
		++rec.argc;
	}
	if (rec.argc == SID_MAXARGS) rec.truncated = 1;
	rec.truncated |= truncated;
	open_path = exec_path(pid, req, path_arg, at);
	return true;
}

void handle_seccomp(int nfd, const seccomp_notif &req)
{
	const uint32_t tid = req.pid;
	auto t0 = Clock::now();
	auto pend = std::make_shared<Pending>();
	pend->nfd = nfd;
	pend->notif_id = req.id;
	pend->deadline = t0 + g_timeout;
	{
		std::lock_guard<std::mutex> g(g_pend_mu);
		g_pending.push_back(pend);
	}
	int efd = -1;
	try {
		exec_rec rec{};
		std::string target;
		if (!read_exec_rec(tid, req, rec, target))
			throw std::runtime_error("cannot read execve arguments from the session process");
		efd = open(target.c_str(), O_RDONLY | O_CLOEXEC);
		if (efd < 0)
			throw std::runtime_error(std::string("cannot open requested executable ") + rec.path + ": " + strerror(errno));
		Event ev;
		ev.id = new_id();
		ev.time = now_iso();
		gather(ev, tid, efd, "program", &rec);

		Decision d;
		t_pending = pend.get();
		try {
			d = decide(ev);
		} catch (const std::exception &e) {
			d.verdict = Verdict::Block;
			d.decided_by = "error";
			d.reason = std::string("decision failed, failing closed: ") + e.what();
		}
		t_pending = nullptr;
		ev.explored = d.explored;
		ev.effects = d.effects;
		ev.has_result = d.has_result;
		ev.result_exit = d.result_exit;
		ev.result_success = d.result_success;
		ev.result_output = d.result_output;
		ev.verdict = verdict_name(d.verdict);
		ev.decided_by = d.decided_by;
		ev.reason = d.reason;
		ev.model_json = d.model_json;
		ev.attack_id = d.attack_id;
		ev.has_score = d.has_score;
		ev.score = d.score;
		if (!pend->reply(d.verdict == Verdict::Allow) && pend->allow.load() != (d.verdict == Verdict::Allow)) {
			ev.verdict = "block";
			ev.decided_by = "timeout";
			ev.reason = "no answer in time; denied";
		}
		ev.latency_ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
		emit(ev);
	} catch (const std::exception &e) {
		say(std::string("seccomp handler error for tid ") + std::to_string(tid) + ": " + e.what());
		pend->reply(false);
	}
	if (efd >= 0) close(efd);
	unregister(pend);
}

// ---- worker pool ---------------------------------------------------------------

struct Job {
	int ffd = -1, efd = -1, nfd = -1;
	uint32_t tid = 0;
	seccomp_notif notif{};
};
std::mutex g_q_mu;
std::condition_variable g_q_cv;
std::deque<Job> g_queue;

void worker()
{
	for (;;) {
		Job j;
		{
			std::unique_lock<std::mutex> lk(g_q_mu);
			g_q_cv.wait(lk, [] { return !g_queue.empty(); });
			j = g_queue.front();
			g_queue.pop_front();
		}
		if (j.nfd >= 0) handle_seccomp(j.nfd, j.notif);
		else handle(j.ffd, j.efd, j.tid);
	}
}

void listen_notifications(int nfd, SessionHello hello)
{
	bool bootstrap = true;
	for (;;) {
		seccomp_notif req{};
		if (ioctl(nfd, SECCOMP_IOCTL_NOTIF_RECV, &req) != 0) {
			if (errno == EINTR) continue;
			if (errno != ENOENT && errno != EBADF)
				say(std::string("seccomp listener stopped: ") + strerror(errno));
			break;
		}
		if (bootstrap && req.pid == hello.pid && req.data.nr == __NR_execve) {
			seccomp_notif_resp response{};
			response.id = req.id;
			response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
			if (ioctl(nfd, SECCOMP_IOCTL_NOTIF_SEND, &response) != 0 && errno != ENOENT)
				say(std::string("cannot release the login shell: ") + strerror(errno));
			bootstrap = false;
			continue;
		}
		{
			std::lock_guard<std::mutex> g(g_q_mu);
			Job j;
			j.nfd = nfd;
			j.tid = req.pid;
			j.notif = req;
			g_queue.push_back(j);
		}
		g_q_cv.notify_one();
	}
	close(nfd);
}

void serve_session(int fd)
{
	// Only the setuid-root session launcher can connect to the mode-0600 socket.
	SessionHello hello{};
	iovec data{&hello, sizeof(hello)};
	char control[CMSG_SPACE(sizeof(int))]{};
	msghdr msg{};
	msg.msg_iov = &data;
	msg.msg_iovlen = 1;
	msg.msg_control = control;
	msg.msg_controllen = sizeof(control);
	ssize_t n = recvmsg(fd, &msg, 0);
	int nfd = -1;
	for (cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c))
		if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len >= CMSG_LEN(sizeof(int))) {
			memcpy(&nfd, CMSG_DATA(c), sizeof(nfd));
			break;
	}
	close(fd);
	if (n != static_cast<ssize_t>(sizeof(hello)) || hello.version != SID_SESSION_RPC_VERSION || hello.pid == 0 || nfd < 0) {
		if (nfd >= 0) close(nfd);
		say("rejected invalid SSH session registration");
		return;
	}
	std::thread(listen_notifications, nfd, hello).detach();
}

int session_listener()
{
	sockaddr_un addr{};
	if (g_session_socket.size() >= sizeof(addr.sun_path))
		throw std::runtime_error("session socket path is too long");
	std::string dir = g_session_socket.substr(0, g_session_socket.find_last_of('/'));
	if (!dir.empty() && mkdir(dir.c_str(), 0755) != 0 && errno != EEXIST)
		throw std::runtime_error("cannot create " + dir + ": " + strerror(errno));
	unlink(g_session_socket.c_str());
	int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	if (fd < 0) throw std::runtime_error(std::string("session socket: ") + strerror(errno));
	addr.sun_family = AF_UNIX;
	memcpy(addr.sun_path, g_session_socket.c_str(), g_session_socket.size() + 1);
	if (bind(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 ||
	    chmod(g_session_socket.c_str(), 0600) != 0 || listen(fd, 64) != 0) {
		int e = errno;
		close(fd);
		unlink(g_session_socket.c_str());
		throw std::runtime_error(std::string("cannot listen on session socket: ") + strerror(e));
	}
	return fd;
}

void sd_notify(const char *msg)
{
	const char *addr = getenv("NOTIFY_SOCKET");
	if (!addr || !*addr)
		return;
	int s = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	if (s < 0)
		return;
	sockaddr_un sa{};
	sa.sun_family = AF_UNIX;
	size_t len = strnlen(addr, sizeof(sa.sun_path) - 1);
	memcpy(sa.sun_path, addr, len);
	if (sa.sun_path[0] == '@')
		sa.sun_path[0] = '\0';
	sendto(s, msg, strlen(msg), 0, reinterpret_cast<sockaddr *>(&sa), offsetof(sockaddr_un, sun_path) + len);
	close(s);
}

int print_libbpf(enum libbpf_print_level lvl, const char *fmt, va_list ap)
{
	if (lvl == LIBBPF_DEBUG)
		return 0;
	std::lock_guard<std::mutex> g(g_out_mu);
	fputs("sid-daemon: libbpf: ", stderr);
	return vfprintf(stderr, fmt, ap);
}

}  // namespace

void extend_deadline(std::chrono::milliseconds from_now)
{
	if (!t_pending)
		return;
	std::lock_guard<std::mutex> g(g_pend_mu);  // the watchdog reads it under this lock
	t_pending->deadline = std::max(t_pending->deadline, Clock::now() + from_now);
}

void emit_hold(const Event &ev, const std::string &model_json)
{
	Event h = ev;  // a provisional "hold" line; the final decision line (same id) settles it
	h.verdict = "hold";
	h.decided_by = "model";
	h.model_json = model_json;  // keep the probabilities on the pending line too
	if (h.reason.empty())
		h.reason = "held for review";
	emit(h);
}

int main()
{
	if (geteuid() != 0) {
		fprintf(stderr, "sid-daemon must run as root\n");
		return 1;
	}
	g_own_tgid = getpid();
	setvbuf(stderr, nullptr, _IOLBF, 0);

	try {
		g_log = fopen(g_log_path.c_str(), "ae");
		if (!g_log)
			throw std::runtime_error("cannot open " + g_log_path);

		const bool session_backend = g_capture_backend == "seccomp";
		if (!session_backend) {
			// Phase 0: eBPF first, fanotify marks last, so nothing of ours pauses itself.
			libbpf_set_print(print_libbpf);
			bpf_object *obj = bpf_object__open_file(g_bpf_obj.c_str(), nullptr);
			if (!obj || libbpf_get_error(obj))
				throw std::runtime_error("cannot open " + g_bpf_obj);
			if (bpf_object__load(obj))
				throw std::runtime_error("loading the eBPF object failed");
			bpf_program *prog;
			bpf_object__for_each_program(prog, obj)
			{
				bpf_link *l = bpf_program__attach(prog);
				if (!l || libbpf_get_error(l))
					throw std::runtime_error(std::string("attaching ") + bpf_program__name(prog) + " failed");
			}
			int map_fd = bpf_object__find_map_fd_by_name(obj, "rb");
			ring_buffer *rb = ring_buffer__new(map_fd, on_record, nullptr, nullptr);
			if (!rb)
				throw std::runtime_error("ring_buffer__new failed");
			std::thread([rb] {
				for (;;)
					ring_buffer__poll(rb, 100);
			}).detach();
			say("eBPF exec recorder attached");
		} else {
			say("Docker SSH session exec notifications enabled");
		}

		decide_init();
		say("indexed " + std::to_string(load_package_files()) + " package files");

		for (int i = 0; i < kWorkers; i++)
			std::thread(worker).detach();
		std::thread(watchdog).detach();
		if (session_backend) {
			int sfd = session_listener();
			say("capture ACTIVE for SSH session process trees via " + g_session_socket +
			    "; events -> " + g_log_path);
			sd_notify("READY=1");
			for (;;) {
				int client = accept4(sfd, nullptr, nullptr, SOCK_CLOEXEC);
				if (client < 0) { if (errno == EINTR) continue; throw std::runtime_error(std::string("session accept: ") + strerror(errno)); }
				std::thread(serve_session, client).detach();
			}
		}
		int ffd = fan::init();

		auto marked = fan::mark_all(ffd, say);
		if (marked.empty()) {  // protecting nothing must never look like success
			fprintf(stderr, "sid-daemon: fatal: could not mark any filesystem; this kernel cannot pause execs "
					"(needs CONFIG_FANOTIFY_ACCESS_PERMISSIONS)\n");
			return 2;  // configuration problem: retrying will not help
		}
		std::string list;
		for (auto &m : marked)
			list += (list.empty() ? "" : ", ") + m;
		say("capture ACTIVE on " + std::to_string(marked.size()) + " filesystems: " + list + "; events -> " + g_log_path);
		sd_notify("READY=1");  // Type=notify: `systemctl restart` returns once the capture is live

		for (;;) {
			for (auto &p : fan::read_events(ffd)) {
				if (p.tid == g_own_tgid || is_own(p.tid)) {  // never deadlock on ourselves
					fan::respond(ffd, p.efd, true);
					close(p.efd);
					continue;
				}
				{
					std::lock_guard<std::mutex> g(g_q_mu);
				g_queue.push_back({ffd, p.efd, -1, p.tid});
				}
				g_q_cv.notify_one();
			}
		}
	} catch (const std::exception &e) {
		fprintf(stderr, "sid-daemon: fatal: %s\n", e.what());
		return g_capture_backend == "seccomp" ? 2 : 1;
	}
}
