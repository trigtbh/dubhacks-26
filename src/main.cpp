// sid-daemon: passive command capture.
//
// fanotify (FAN_OPEN_EXEC_PERM) freezes every program launch; an eBPF program
// records the command. We pair them by thread id, gather context, run
// decide(), and answer the kernel. Needs root. If this process dies the kernel
// allows every paused program, so run it under systemd with Restart=always.
//
// This process must never exec anything (no system/popen/fork+exec): the child
// would pause on itself.
#include <bpf/libbpf.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <atomic>
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
	int ffd, efd;
	Clock::time_point deadline;
	std::atomic<bool> answered{false};
	bool allow = false;

	// First caller answers the kernel; a late decision is dropped.
	bool reply(bool a)
	{
		if (answered.exchange(true))
			return false;
		allow = a;
		try {
			fan::respond(ffd, efd, a);
		} catch (const std::exception &e) {
			say(e.what());
		}
		return true;
	}
};

std::mutex g_pend_mu;
std::vector<std::shared_ptr<Pending>> g_pending;

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

bool is_own(uint32_t tid)
{
	FILE *f = fopen(("/proc/" + std::to_string(tid) + "/status").c_str(), "re");
	if (!f)
		return false;
	char line[256];
	bool own = false;
	while (fgets(line, sizeof(line), f))
		if (strncmp(line, "Tgid:", 5) == 0) {
			own = (uint32_t)atoi(line + 5) == g_own_tgid;
			break;
		}
	fclose(f);
	return own;
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
			try {
				d = decide(ev);
			} catch (const std::exception &e) {  // fail closed
				d.verdict = Verdict::Block;
				d.decided_by = "error";
				d.reason = std::string("decision failed, failing closed: ") + e.what();
			}
			ev.verdict = verdict_name(d.verdict);
			ev.decided_by = d.decided_by;
			ev.reason = d.reason;
			ev.attack_id = d.attack_id;
			ev.has_score = d.has_score;
			ev.score = d.score;
			if (!pend->reply(d.verdict == Verdict::Allow) && pend->allow != (d.verdict == Verdict::Allow)) {
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

// ---- worker pool ---------------------------------------------------------------

struct Job {
	int ffd, efd;
	uint32_t tid;
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
		handle(j.ffd, j.efd, j.tid);
	}
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

		// Phase 0: set up. eBPF first, marks last, so nothing of ours can pause on itself.
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

		decide_init();
		say("indexed " + std::to_string(load_package_files()) + " package files");

		int ffd = fan::init();
		for (int i = 0; i < kWorkers; i++)
			std::thread(worker).detach();
		std::thread(watchdog).detach();

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
					g_queue.push_back({ffd, p.efd, p.tid});
				}
				g_q_cv.notify_one();
			}
		}
	} catch (const std::exception &e) {
		fprintf(stderr, "sid-daemon: fatal: %s\n", e.what());
		return 1;
	}
}
