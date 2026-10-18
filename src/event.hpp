// The one event type every part of sid uses, and what decide() returns.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

struct Parent {
	int pid = 0;
	std::string exe;
};

struct Event {
	std::string id, time, syscall, role;  // role: "program", or "interpreter" for a #! script's 2nd pause
	uint32_t tid = 0, pid = 0, ppid = 0, uid = 0, gid = 0;
	std::vector<uint32_t> groups;
	std::string user, cwd;

	std::string path;  // as given to execve, made absolute
	std::string file;  // resolved executable opened for inspection
	std::vector<std::string> argv;
	bool truncated = false;
	std::string note;

	uint64_t inode = 0, size = 0;
	double mtime = 0;
	std::string sha256;
	bool is_new = false;  // not from a package, or in a writable folder

	std::string origin_type = "local";  // local | ssh | service | agent
	std::string origin_detail;
	bool via_ssh = false;
	std::string service;
	long sessionid = -1;
	std::vector<Parent> parent_chain;

	std::string stdin_link;
	int feeder_pid = -1;  // process holding the other end of a pipe feeding us (curl ... | bash)
	std::string feeder_exe, feeder_cmdline;
	bool has_script = false;
	std::string script;  // first KB of a script argument

	std::vector<std::string> recent;
	std::string normalized;

	// filled by decide()
	std::string verdict, decided_by, reason, attack_id;
	bool has_score = false;
	double score = 0;
	bool explored = false;
	std::string effects;  // simulation summary JSON, when explored
	// The simulated run's result, carried forward so an approved command's output
	// and exit code can be reused. has_result is false when nothing was simulated.
	bool has_result = false;
	int result_exit = -1;
	bool result_success = false;
	std::string result_output;
	double latency_ms = 0;

	std::string to_json() const;
};

enum class Verdict { Allow, Hold, Block };

struct Decision {
	Verdict verdict = Verdict::Allow;
	std::string decided_by, reason, attack_id;
	bool has_score = false;
	double score = 0;
	bool explored = false;
	std::string effects;  // simulation summary JSON
	// The simulated run's result, to reuse if the command is approved.
	bool has_result = false;
	int result_exit = -1;
	bool result_success = false;
	std::string result_output;
};

inline const char *verdict_name(Verdict v)
{
	return v == Verdict::Allow ? "allow" : v == Verdict::Hold ? "hold" : "block";
}
