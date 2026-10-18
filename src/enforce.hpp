// Describing where a command came from, and acting on a denial.
//
// A denial is not just "don't run this one exec": the caller has shown they are
// not to be trusted, so we tear down the way they got in. That severance IS the
// loss of trust -- an SSH caller must reconnect and re-authenticate, a killed
// shell or agent must start a new session -- so there is no trust state to keep.
// plan_enforcement() turns an Event into the concrete processes to kill:
//   - a remote SSH session      -> kill the per-connection sshd (severs the link)
//   - an AI coding agent         -> kill the agent process
//   - a systemd service          -> kill the service's process
//   - a user at a local shell     -> kill the login shell (kicks them out)
//   plus the paused command itself.
// We never touch pid <= 1, the daemon, or any ancestor of the daemon.
#pragma once
#include <functional>
#include <string>
#include <vector>

#include "event.hpp"

struct Target {
	std::string action;  // sever-remote | kill-agent | kill-service | kick-shell | kill-command
	int pid = 0;
	std::string exe;
};

// The processes a denial of this command would kill, most important first.
std::vector<Target> plan_enforcement(const Event &ev);

// A one-line human description of the origin, for the reviewer.
std::string origin_description(const Event &ev);

// The full origin, as JSON, for the front end: type, description, session, the
// parent-process chain, and the sever plan above (what a denial would kill).
std::string origin_json(const Event &ev);

using Killer = std::function<bool(int pid)>;      // SIGKILL a pid; true on success
using Protected = std::function<bool(int pid)>;   // true if the pid must not be killed

// Carry out a plan, returning a JSON array recording what was done to each target.
// Injectable so it can be tested without signalling real processes.
std::string carry_out(const std::vector<Target> &plan, const Killer &kill_fn, const Protected &protect);

// Record which process tree is the daemon's own, so enforcement never kills it.
void enforce_init(int self_pid);

bool enforcement_enabled();  // false when SID_ENFORCE=0

// Deny for real: sever the origin (unless SID_ENFORCE=0). Returns a JSON summary
// of what was killed, for the decision log. `reason` is only for that summary.
std::string enforce_denial(const Event &ev, const std::string &reason);
