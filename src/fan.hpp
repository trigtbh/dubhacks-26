#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// fanotify: pause every program launch (FAN_OPEN_EXEC_PERM) until we answer.
namespace fan {

int init();  // fanotify group fd; throws std::runtime_error
// Mark every executable-capable filesystem (an unmarked one is a hole). Returns the marked mount points.
std::vector<std::string> mark_all(int fd, const std::function<void(const std::string &)> &log);

struct Paused {
	int efd;       // open handle to the exact file about to run; caller closes it
	uint32_t tid;  // thread that is frozen (FAN_REPORT_TID)
};
// Blocks for the next batch of paused execs.
std::vector<Paused> read_events(int fd);
void respond(int fd, int efd, bool allow);

}  // namespace fan
