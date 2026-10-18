// One model child, loaded before capture. No process is spawned during decide().
#include "jev.hpp"

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <vector>

extern char **environ;

namespace {
using Clock = std::chrono::steady_clock;

std::string env(const char *name, const char *fallback)
{
	const char *value = getenv(name);
	return value && *value ? value : fallback;
}

std::chrono::milliseconds timeout(const char *name, const char *fallback)
{
	std::string text = env(name, fallback);
	size_t end = 0;
	long ms = std::stol(text, &end);
	if (end != text.size() || ms < 1 || ms > 3600000)
		throw std::runtime_error(std::string(name) + " must be milliseconds in 1..3600000");
	return std::chrono::milliseconds(ms);
}

class Worker {
	std::timed_mutex mutex;
	int fd = -1;
	pid_t pid = -1;
	std::chrono::milliseconds request_timeout{1500};

	void stop()
	{
		if (fd >= 0) close(fd);
		fd = -1;
		if (pid > 0) {
			kill(pid, SIGKILL);
			while (waitpid(pid, nullptr, 0) < 0 && errno == EINTR) {}
		}
		pid = -1;
	}

	void wait(short events, Clock::time_point deadline)
	{
		for (;;) {
			auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
			if (ms <= 0) throw std::runtime_error("Laya worker timed out");
			pollfd p{fd, events, 0};
			int rc = poll(&p, 1, (int)ms);
			if (rc < 0 && errno == EINTR) continue;
			if (rc < 0) throw std::runtime_error("Laya poll failed");
			if (rc == 0) throw std::runtime_error("Laya worker timed out");
			if (p.revents & events) return;
			throw std::runtime_error("Laya worker disconnected");
		}
	}

	std::string read_line(Clock::time_point deadline)
	{
		std::string out;
		while (out.size() < 16384) {
			wait(POLLIN, deadline);
			char buf[1024];
			ssize_t n = recv(fd, buf, sizeof(buf), 0);
			if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
			if (n <= 0) throw std::runtime_error("Laya worker disconnected");
			out.append(buf, n);
			size_t newline = out.find('\n');
			if (newline != std::string::npos) {
				if (newline + 1 != out.size()) throw std::runtime_error("unexpected Laya output");
				out.pop_back();
				return out;
			}
		}
		throw std::runtime_error("Laya response too large");
	}

public:
	~Worker() { stop(); }

	void init()
	{
		std::lock_guard<std::timed_mutex> lock(mutex);
		if (fd >= 0) return;
		request_timeout = timeout("SID_MODEL_TIMEOUT_MS", "1500");
		auto deadline = Clock::now() + timeout("SID_MODEL_START_TIMEOUT_MS", "120000");
		std::vector<std::string> args = {
			env("SID_MODEL_PYTHON", access(".venv/bin/python", X_OK) == 0 ? ".venv/bin/python" : "python3"),
			"-I", "-B", env("SID_MODEL_WORKER", access("runtime/laya_worker.py", R_OK) == 0 ?
				"runtime/laya_worker.py" : "/usr/local/lib/sid/runtime/laya_worker.py"),
			"--fd", "3", "--parent-pid", std::to_string(getpid()),
			"--checkpoint", env("SID_LAYA_CHECKPOINT", ".data/pilot-v2/finetune-04/checkpoint"),
			"--device", env("SID_LAYA_DEVICE", "auto")};
		std::vector<char *> argv;
		for (auto &arg : args) argv.push_back(arg.data());
		argv.push_back(nullptr);
		int pair[2];
		if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0)
			throw std::runtime_error("Laya socketpair failed");
		posix_spawn_file_actions_t actions;
		posix_spawn_file_actions_init(&actions);
		posix_spawn_file_actions_addclose(&actions, pair[0]);
		posix_spawn_file_actions_adddup2(&actions, pair[1], 3);
		if (pair[1] != 3) posix_spawn_file_actions_addclose(&actions, pair[1]);
		// Library output goes to the log, never to the model protocol socket.
		posix_spawn_file_actions_adddup2(&actions, STDERR_FILENO, STDOUT_FILENO);
		int rc = posix_spawnp(&pid, argv[0], &actions, nullptr, argv.data(), environ);
		posix_spawn_file_actions_destroy(&actions);
		close(pair[1]);
		if (rc != 0) {
			close(pair[0]);
			pid = -1;
			throw std::runtime_error("cannot start Laya worker: " + std::string(strerror(rc)));
		}
		fd = pair[0];
		try {
			if (fcntl(fd, F_SETFL, O_NONBLOCK) < 0) throw std::runtime_error("Laya nonblocking socket failed");
			if (read_line(deadline) != "{\"ready\":true}") throw std::runtime_error("Laya worker not ready");
		} catch (...) {
			stop();
			throw;
		}
	}

	std::string classify(const Event &event)
	{
		auto deadline = Clock::now() + request_timeout;
		std::unique_lock<std::timed_mutex> lock(mutex, std::defer_lock);
		if (!lock.try_lock_until(deadline)) throw std::runtime_error("Laya inference queue timed out");
		if (fd < 0) throw std::runtime_error("Laya worker unavailable; restart the daemon");
		std::string request = event.to_json() + "\n";
		if (request.size() > 1024 * 1024) throw std::runtime_error("Laya Event too large");
		try {
			for (size_t sent = 0; sent < request.size();) {
				wait(POLLOUT, deadline);
				ssize_t n = send(fd, request.data() + sent, request.size() - sent, MSG_NOSIGNAL);
				if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
				if (n <= 0) throw std::runtime_error("Laya send failed");
				sent += n;
			}
			return read_line(deadline);
		} catch (...) {
			// Never reuse a stream with a late response, and never exec a replacement
			// after capture starts. The daemon blocks on this exception.
			stop();
			throw;
		}
	}
};

Worker &worker()
{
	static Worker instance;
	return instance;
}
}  // namespace

void jev_init() { worker().init(); }
std::string jev_classify(const Event &ev) { return worker().classify(ev); }
