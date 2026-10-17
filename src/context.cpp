#include "context.hpp"

#include <dirent.h>
#include <fcntl.h>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <deque>
#include <map>
#include <mutex>
#include <tuple>
#include <unordered_set>

#include "sha256.hpp"

namespace {

const char *const kWritable[] = {"/tmp/", "/dev/shm/", "/var/tmp/", "/home/", "/root/", "/run/user/"};
const char *const kInterpreters[] = {"bash", "sh", "dash", "zsh", "python", "python3", "perl", "ruby", "node"};
const char *const kAgents[] = {"claude", "codex", "gemini", "cline", "goose", "aider"};  // matched on exe path
constexpr size_t kHistory = 5;

std::unordered_set<std::string> g_pkg_files;

std::mutex g_hash_mu;
std::map<std::tuple<uint64_t, uint64_t, int64_t>, std::string> g_hash_cache;

std::mutex g_hist_mu;
std::map<long, std::deque<std::string>> g_history;

std::string slurp(const std::string &path, size_t max = 1 << 20)
{
	std::string out;
	int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return out;
	char buf[4096];
	ssize_t n;
	while (out.size() < max && (n = read(fd, buf, sizeof(buf))) > 0)
		out.append(buf, n);
	close(fd);
	return out;
}

std::string readlink_str(const std::string &path)
{
	char buf[4096];
	ssize_t n = readlink(path.c_str(), buf, sizeof(buf) - 1);
	return n < 0 ? std::string() : std::string(buf, n);
}

std::string base(const std::string &p)
{
	size_t i = p.rfind('/');
	return i == std::string::npos ? p : p.substr(i + 1);
}

bool starts_with(const std::string &s, const char *p) { return s.rfind(p, 0) == 0; }

// "Key:\tv1 v2" -> {v1, v2}
std::vector<std::string> status_field(const std::string &status, const char *key)
{
	std::vector<std::string> out;
	std::string needle = std::string(key) + ":";
	size_t pos = 0;
	while (pos < status.size()) {
		size_t eol = status.find('\n', pos);
		if (eol == std::string::npos)
			eol = status.size();
		if (status.compare(pos, needle.size(), needle) == 0) {
			size_t i = pos + needle.size();
			while (i < eol) {
				while (i < eol && (status[i] == ' ' || status[i] == '\t'))
					i++;
				size_t j = i;
				while (j < eol && status[j] != ' ' && status[j] != '\t')
					j++;
				if (j > i)
					out.push_back(status.substr(i, j - i));
				i = j;
			}
			break;
		}
		pos = eol + 1;
	}
	return out;
}

long to_long(const std::vector<std::string> &v, size_t i = 0, long dflt = 0)
{
	return i < v.size() ? strtol(v[i].c_str(), nullptr, 10) : dflt;
}

std::string exe_of(int pid) { return readlink_str("/proc/" + std::to_string(pid) + "/exe"); }

std::vector<Parent> parent_chain(int pid)
{
	std::vector<Parent> chain;
	long ppid = to_long(status_field(slurp("/proc/" + std::to_string(pid) + "/status"), "PPid"), 0, -1);
	while (ppid > 0 && chain.size() < 64) {
		chain.push_back({(int)ppid, exe_of(ppid)});
		ppid = to_long(status_field(slurp("/proc/" + std::to_string(ppid) + "/status"), "PPid"), 0, -1);
	}
	return chain;
}

bool is_interpreter(const std::string &path)
{
	std::string b = base(path);
	for (const char *i : kInterpreters)
		if (b == i || starts_with(b, i))
			return true;
	return false;
}

int pipe_feeder(int pid, const std::string &link)
{
	DIR *proc = opendir("/proc");
	if (!proc)
		return -1;
	int found = -1;
	while (dirent *e = readdir(proc)) {
		int p = atoi(e->d_name);
		if (p <= 0 || p == pid)
			continue;
		std::string fddir = std::string("/proc/") + e->d_name + "/fd";
		DIR *fds = opendir(fddir.c_str());
		if (!fds)
			continue;
		while (dirent *f = readdir(fds)) {
			if (f->d_name[0] == '.')
				continue;
			if (readlink_str(fddir + "/" + f->d_name) == link) {
				found = p;
				break;
			}
		}
		closedir(fds);
		if (found > 0)
			break;
	}
	closedir(proc);
	return found;
}

void file_identity(Event &ev, int efd)
{
	struct stat st;
	if (fstat(efd, &st) != 0)
		return;
	ev.inode = st.st_ino;
	ev.size = st.st_size;
	ev.mtime = st.st_mtim.tv_sec + st.st_mtim.tv_nsec / 1e9;
	auto key = std::make_tuple((uint64_t)st.st_dev, (uint64_t)st.st_ino,
				   (int64_t)st.st_mtim.tv_sec * 1000000000 + st.st_mtim.tv_nsec);
	{
		std::lock_guard<std::mutex> g(g_hash_mu);
		auto it = g_hash_cache.find(key);
		if (it != g_hash_cache.end()) {
			ev.sha256 = it->second;
			return;
		}
	}
	// Reading through the event fd does not raise another permission event.
	Sha256 h;
	static thread_local char buf[1 << 16];
	off_t off = 0;
	ssize_t n;
	bool ok = true;
	while ((n = pread(efd, buf, sizeof(buf), off)) > 0) {
		h.update(buf, n);
		off += n;
	}
	if (n < 0)
		ok = false;
	ev.sha256 = ok ? h.hex() : "";
	std::lock_guard<std::mutex> g(g_hash_mu);
	if (g_hash_cache.size() > 4096)
		g_hash_cache.clear();
	g_hash_cache[key] = ev.sha256;
}

// Paths, IPs and numbers become placeholders; the cache and tiny classifier key on this.
std::string normalize(const std::string &text)
{
	std::string out;
	size_t i = 0;
	while (i < text.size()) {
		if (text[i] == ' ' || text[i] == '\t') {
			out += text[i++];
			continue;
		}
		size_t j = i;
		while (j < text.size() && text[j] != ' ' && text[j] != '\t')
			j++;
		std::string tok = text.substr(i, j - i);
		i = j;
		size_t slashes = std::count(tok.begin(), tok.end(), '/');
		bool ip = !tok.empty() && std::count(tok.begin(), tok.end(), '.') == 3 &&
			  tok.find_first_not_of("0123456789.") == std::string::npos;
		bool hex = tok.size() >= 8 && tok.find_first_not_of("0123456789abcdef") == std::string::npos;
		if (slashes >= 2 || (slashes == 1 && tok[0] == '/'))
			out += "<path>";
		else if (ip)
			out += "<ip>";
		else if (hex)
			out += "<hex>";
		else
			for (size_t k = 0; k < tok.size();) {
				if (isdigit((unsigned char)tok[k])) {
					while (k < tok.size() && isdigit((unsigned char)tok[k]))
						k++;
					out += "<n>";
				} else
					out += tok[k++];
			}
	}
	return out;
}

}  // namespace

size_t load_package_files()
{
	DIR *d = opendir("/var/lib/dpkg/info");
	if (!d)
		return 0;
	while (dirent *e = readdir(d)) {
		std::string n = e->d_name;
		if (n.size() < 5 || n.compare(n.size() - 5, 5, ".list") != 0)
			continue;
		std::string body = slurp("/var/lib/dpkg/info/" + n, 64 << 20);
		size_t pos = 0;
		while (pos < body.size()) {
			size_t eol = body.find('\n', pos);
			if (eol == std::string::npos)
				eol = body.size();
			g_pkg_files.insert(body.substr(pos, eol - pos));
			pos = eol + 1;
		}
	}
	closedir(d);
	return g_pkg_files.size();
}

void gather(Event &ev, uint32_t tid, int efd, const char *role, const exec_rec *rec)
{
	ev.tid = tid;
	ev.pid = tid;
	ev.role = role;

	std::string st = slurp("/proc/" + std::to_string(tid) + "/status");
	if (!st.empty()) {
		ev.pid = to_long(status_field(st, "Tgid"), 0, tid);
		ev.uid = to_long(status_field(st, "Uid"));
		ev.gid = to_long(status_field(st, "Gid"));
		ev.ppid = to_long(status_field(st, "PPid"));
		for (auto &g : status_field(st, "Groups"))
			ev.groups.push_back(strtoul(g.c_str(), nullptr, 10));
		passwd pw, *res = nullptr;
		char buf[1024];
		if (getpwuid_r(ev.uid, &pw, buf, sizeof(buf), &res) == 0 && res)
			ev.user = res->pw_name;
		else
			ev.user = std::to_string(ev.uid);
	}
	ev.cwd = readlink_str("/proc/" + std::to_string(ev.pid) + "/cwd");

	// what is about to run
	ev.file = readlink_str("/proc/self/fd/" + std::to_string(efd));
	file_identity(ev, efd);
	ev.is_new = g_pkg_files.find(ev.file) == g_pkg_files.end();
	for (const char *w : kWritable)
		if (starts_with(ev.file, w))
			ev.is_new = true;

	if (rec) {
		ev.path = rec->path;
		for (unsigned i = 0; i < rec->argc && i < SID_MAXARGS; i++)
			ev.argv.emplace_back(rec->args[i]);
		ev.truncated = rec->truncated;
		ev.syscall = rec->is_execveat ? "execveat" : "execve";
	} else {
		ev.path = ev.file;
		ev.truncated = true;
		ev.syscall = "unknown";
		ev.note = "no eBPF record matched; treated as truncated";
	}

	// where it came from
	ev.parent_chain = parent_chain(ev.pid);
	for (auto &p : ev.parent_chain)
		if (p.exe.size() >= 5 && p.exe.compare(p.exe.size() - 5, 5, "/sshd") == 0) {
			ev.via_ssh = true;
			ev.origin_type = "ssh";  // TODO: sshd's "Accepted publickey ... from IP ... SHA256:..." line
			ev.origin_detail = "sshd_pid=" + std::to_string(p.pid);
			break;
		}
	std::string cg = slurp("/proc/" + std::to_string(ev.pid) + "/cgroup");
	size_t svc = cg.find(".service");
	if (svc != std::string::npos) {
		size_t s = cg.rfind('/', svc);
		ev.service = cg.substr(s + 1, svc + 8 - (s + 1));
		if (!ev.via_ssh) {
			ev.origin_type = "service";
			ev.origin_detail = ev.service;
		}
	}
	auto check_agent = [&](const std::string &exe) {
		for (const char *a : kAgents)
			if (base(exe) == a) {
				ev.origin_type = "agent";
				ev.origin_detail = a;
				return true;
			}
		return false;
	};
	if (!check_agent(ev.file))
		for (auto &p : ev.parent_chain)
			if (check_agent(p.exe))
				break;
	ev.sessionid = to_long({slurp("/proc/" + std::to_string(ev.pid) + "/sessionid")}, 0, -1);

	// what feeds it
	bool interp = is_interpreter(ev.file) || is_interpreter(ev.path);
	ev.stdin_link = readlink_str("/proc/" + std::to_string(ev.pid) + "/fd/0");
	if (interp && starts_with(ev.stdin_link, "pipe:")) {  // catches `curl ... | bash`
		ev.feeder_pid = pipe_feeder(ev.pid, ev.stdin_link);
		if (ev.feeder_pid > 0) {
			ev.feeder_exe = exe_of(ev.feeder_pid);
			ev.feeder_cmdline = slurp("/proc/" + std::to_string(ev.feeder_pid) + "/cmdline", 4096);
			std::replace(ev.feeder_cmdline.begin(), ev.feeder_cmdline.end(), '\0', ' ');
		}
	}
	if (is_interpreter(ev.file)) {  // -c code is already in argv; otherwise read the script
		bool dash_c = std::find(ev.argv.begin() + (ev.argv.empty() ? 0 : 1), ev.argv.end(), "-c") != ev.argv.end();
		if (!dash_c)
			for (size_t i = 1; i < ev.argv.size(); i++) {
				if (ev.argv[i].empty() || ev.argv[i][0] == '-')
					continue;
				std::string p = ev.argv[i][0] == '/' ? ev.argv[i] : ev.cwd + "/" + ev.argv[i];
				ev.script = slurp(p, 4096);
				ev.has_script = !ev.script.empty();
				break;
			}
	}

	std::string text;
	for (auto &a : ev.argv)
		text += (text.empty() ? "" : " ") + a;
	if (text.empty())
		text = ev.path;

	{
		std::lock_guard<std::mutex> g(g_hist_mu);
		auto &h = g_history[ev.sessionid];
		ev.recent.assign(h.begin(), h.end());
		h.push_back(text.substr(0, 200));
		if (h.size() > kHistory)
			h.pop_front();
		if (g_history.size() > 4096)
			g_history.clear();
	}
	ev.normalized = ev.user + " " + ev.origin_type + " " + normalize(text);
}
