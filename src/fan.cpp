#include "fan.hpp"

#include <fcntl.h>
#include <linux/fanotify.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <set>
#include <sstream>
#include <stdexcept>

namespace fan {
namespace {

// Filesystems nothing can be exec'd from.
const std::set<std::string> kSkip = {
    "proc", "sysfs", "cgroup", "cgroup2", "devpts", "devtmpfs", "mqueue", "tracefs", "debugfs",
    "securityfs", "pstore", "bpf", "configfs", "fusectl", "autofs", "binfmt_misc", "hugetlbfs",
    "selinuxfs", "efivarfs", "rpc_pipefs", "nsfs"};

int sys_fanotify_init(unsigned flags, unsigned event_f_flags)
{
	return syscall(SYS_fanotify_init, flags, event_f_flags);
}

int sys_fanotify_mark(int fd, unsigned flags, uint64_t mask, int dirfd, const char *path)
{
	return syscall(SYS_fanotify_mark, fd, flags, mask, dirfd, path);
}

std::string unescape_mount(const std::string &s)  // mountinfo escapes space as \040
{
	std::string o;
	for (size_t i = 0; i < s.size(); i++)
		if (s[i] == '\\' && i + 3 < s.size() + 0 && isdigit((unsigned char)s[i + 1])) {
			o += (char)strtol(s.substr(i + 1, 3).c_str(), nullptr, 8);
			i += 3;
		} else
			o += s[i];
	return o;
}

}  // namespace

int init()
{
	int fd = sys_fanotify_init(FAN_CLOEXEC | FAN_CLASS_CONTENT | FAN_REPORT_TID, O_RDONLY | O_LARGEFILE);
	if (fd < 0)
		throw std::runtime_error(std::string("fanotify_init: ") + strerror(errno) +
					 " (need root and CONFIG_FANOTIFY_ACCESS_PERMISSIONS)");
	return fd;
}

std::vector<std::string> mark_all(int fd, const std::function<void(const std::string &)> &log)
{
	std::vector<std::string> marked;
	std::set<dev_t> seen;
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
		if (kSkip.count(fstype))
			continue;
		struct stat st;
		if (stat(mp.c_str(), &st) != 0 || !seen.insert(st.st_dev).second)
			continue;
		if (sys_fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, FAN_OPEN_EXEC_PERM, AT_FDCWD, mp.c_str()) == 0)
			marked.push_back(mp);
		else
			log("fanotify: could not mark " + mp + " (" + fstype + "): " + strerror(errno));
	}
	return marked;
}

std::vector<Paused> read_events(int fd)
{
	alignas(8) static thread_local char buf[1 << 16];
	std::vector<Paused> out;
	ssize_t n = read(fd, buf, sizeof(buf));
	if (n < 0) {
		if (errno == EINTR || errno == EAGAIN)
			return out;
		throw std::runtime_error(std::string("fanotify read: ") + strerror(errno));
	}
	auto *m = reinterpret_cast<fanotify_event_metadata *>(buf);
	for (; FAN_EVENT_OK(m, n); m = FAN_EVENT_NEXT(m, n)) {
		if (m->vers != FANOTIFY_METADATA_VERSION)
			throw std::runtime_error("fanotify metadata version mismatch");
		if (m->fd < 0)  // queue overflow
			continue;
		if (m->mask & FAN_OPEN_EXEC_PERM)
			out.push_back({m->fd, (uint32_t)m->pid});
		else
			close(m->fd);
	}
	return out;
}

void respond(int fd, int efd, bool allow)
{
	fanotify_response r = {efd, allow ? (uint32_t)FAN_ALLOW : (uint32_t)FAN_DENY};
	if (write(fd, &r, sizeof(r)) != (ssize_t)sizeof(r) && errno != ENOENT)
		throw std::runtime_error(std::string("fanotify respond: ") + strerror(errno));
}

}  // namespace fan
