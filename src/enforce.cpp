#include "enforce.hpp"

#include <signal.h>
#include <stdio.h>
#include <string.h>

#include <cstdlib>

#include "changes.hpp"  // json_str

namespace {

int g_self_pid = 0;

std::string basename_of(const std::string &p)
{
	size_t i = p.rfind('/');
	return i == std::string::npos ? p : p.substr(i + 1);
}

bool is_shell(const std::string &exe)
{
	static const char *shells[] = {"bash", "sh", "dash", "zsh", "fish", "ksh", "tcsh", "csh"};
	std::string b = basename_of(exe);
	for (const char *s : shells)
		if (b == s)
			return true;
	return false;
}

// One field of /proc/<pid>/status (here only PPid), or -1.
long ppid_of(int pid)
{
	FILE *f = fopen(("/proc/" + std::to_string(pid) + "/status").c_str(), "re");
	if (!f)
		return -1;
	char line[256];
	long v = -1;
	while (fgets(line, sizeof(line), f))
		if (strncmp(line, "PPid:", 5) == 0) {
			v = atol(line + 5);
			break;
		}
	fclose(f);
	return v;
}

// Would killing `pid` also kill the daemon? True if it is the daemon or one of
// its ancestors (walking up from the daemon until init).
bool hits_daemon(int pid)
{
	if (g_self_pid <= 0)
		return false;
	for (long p = g_self_pid; p > 1; p = ppid_of((int)p))
		if (p == pid)
			return true;
	return false;
}

std::vector<Target> denial_plan(const Event &ev)
{
	const char *demo = getenv("SID_DEMO_COMMAND_ONLY");
	if (!demo || strcmp(demo, "1") != 0)
		return plan_enforcement(ev);
	bool shell_parent = false;
	for (const auto &p : ev.parent_chain)
		if (is_shell(p.exe)) {
			shell_parent = true;
			break;
		}
	if (!shell_parent || ev.pid <= 0)
		return {};
	return {{"kill-command", (int)ev.pid, ev.file.empty() ? ev.path : ev.file}};
}

std::string target_json(const Target &t, bool protected_, bool killed)
{
	return "{\"action\":" + json_str(t.action) + ",\"pid\":" + std::to_string(t.pid) + ",\"exe\":" + json_str(t.exe) +
	       ",\"protected\":" + (protected_ ? "true" : "false") + ",\"killed\":" + (killed ? "true" : "false") + "}";
}

}  // namespace

std::vector<Target> plan_enforcement(const Event &ev)
{
	std::vector<Target> plan;
	if (ev.via_ssh) {
		for (auto &p : ev.parent_chain)  // the per-connection sshd nearest the command
			if (basename_of(p.exe) == "sshd") {
				plan.push_back({"sever-remote", p.pid, p.exe});
				break;
			}
	} else if (ev.origin_type == "agent") {
		for (auto &p : ev.parent_chain)
			if (basename_of(p.exe) == ev.origin_detail) {
				plan.push_back({"kill-agent", p.pid, p.exe});
				break;
			}
	} else if (ev.origin_type == "service") {
		if (!ev.parent_chain.empty()) {  // toward the service's root process
			auto &p = ev.parent_chain.back();
			plan.push_back({"kill-service", p.pid, p.exe});
		}
	} else {  // local user: the login shell they are typing at
		for (auto &p : ev.parent_chain)
			if (is_shell(p.exe)) {
				plan.push_back({"kick-shell", p.pid, p.exe});
				break;
			}
	}
	// If we found no anchor, fall back to the command's immediate parent.
	if (plan.empty() && !ev.parent_chain.empty())
		plan.push_back({"kill-parent", ev.parent_chain.front().pid, ev.parent_chain.front().exe});
	// Always include the paused command itself.
	if (ev.pid > 0)
		plan.push_back({"kill-command", (int)ev.pid, ev.file.empty() ? ev.path : ev.file});
	return plan;
}

std::string origin_description(const Event &ev)
{
	std::string who = "user '" + ev.user + "' (uid " + std::to_string(ev.uid) + ")";
	if (ev.via_ssh) {
		std::string via;
		for (auto &p : ev.parent_chain)
			if (basename_of(p.exe) == "sshd") {
				via = " via sshd (pid " + std::to_string(p.pid) + ")";
				break;
			}
		return "remote SSH session: " + who + via;
	}
	if (ev.origin_type == "agent")
		return "AI coding agent '" + ev.origin_detail + "' run by " + who;
	if (ev.origin_type == "service")
		return "systemd service '" + ev.service + "'";
	for (auto &p : ev.parent_chain)
		if (is_shell(p.exe))
			return "local shell (" + basename_of(p.exe) + ", pid " + std::to_string(p.pid) + "): " + who;
	return "local process: " + who;
}

std::string origin_json(const Event &ev)
{
	std::string parents = "[";
	for (size_t i = 0; i < ev.parent_chain.size(); i++)
		parents += (i ? "," : "") + std::string("{\"pid\":") + std::to_string(ev.parent_chain[i].pid) +
			   ",\"exe\":" + json_str(ev.parent_chain[i].exe) + "}";
	parents += "]";
	std::string sever = "[";
	auto plan = denial_plan(ev);
	for (size_t i = 0; i < plan.size(); i++)
		sever += (i ? "," : "") + std::string("{\"action\":") + json_str(plan[i].action) + ",\"pid\":" +
			 std::to_string(plan[i].pid) + ",\"exe\":" + json_str(plan[i].exe) + "}";
	sever += "]";
	return "{\"type\":" + json_str(ev.origin_type) + ",\"description\":" + json_str(origin_description(ev)) +
	       ",\"via_ssh\":" + (ev.via_ssh ? "true" : "false") +
	       (ev.service.empty() ? "" : ",\"service\":" + json_str(ev.service)) +
	       ",\"user\":" + json_str(ev.user) + ",\"uid\":" + std::to_string(ev.uid) +
	       ",\"sessionid\":" + std::to_string(ev.sessionid) + ",\"parents\":" + parents + ",\"sever\":" + sever + "}";
}

std::string carry_out(const std::vector<Target> &plan, const Killer &kill_fn, const Protected &protect)
{
	std::string out = "[";
	for (size_t i = 0; i < plan.size(); i++) {
		bool prot = plan[i].pid <= 1 || protect(plan[i].pid);
		bool killed = !prot && kill_fn(plan[i].pid);
		out += (i ? "," : "") + target_json(plan[i], prot, killed);
	}
	return out + "]";
}

void enforce_init(int self_pid) { g_self_pid = self_pid; }

bool enforcement_enabled()
{
	const char *v = getenv("SID_ENFORCE");
	return !(v && std::string(v) == "0");
}

std::string enforce_denial(const Event &ev, const std::string &reason)
{
	(void)reason;
	if (!enforcement_enabled())
		return "{\"enabled\":false}";
	std::string actions = carry_out(denial_plan(ev), [](int pid) { return kill(pid, SIGKILL) == 0; }, hits_daemon);
	return "{\"enabled\":true,\"actions\":" + actions + "}";
}
