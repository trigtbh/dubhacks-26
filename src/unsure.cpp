#include "unsure.hpp"

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cstdlib>
#include <vector>

#include "changes.hpp"  // kOutcome* names
#include "enforce.hpp"  // origin_description, origin_json

extern char **environ;

namespace {

std::string env(const char *k, const char *dflt)
{
	const char *v = getenv(k);
	return v && *v ? v : dflt;
}

}  // namespace

std::string command_text(const Event &ev)
{
	std::string cmd;
	for (auto &a : ev.argv)
		cmd += (cmd.empty() ? "" : " ") + a;
	return cmd.empty() ? ev.path : cmd;
}

// Value of a top-level string field in a flat JSON object, e.g. field(j,"outcome").
// Good enough for the few fields we read back; the full JSON goes to the front end.
static std::string json_field(const std::string &json, const std::string &key)
{
	std::string needle = "\"" + key + "\":\"";
	size_t at = json.find(needle);
	if (at == std::string::npos)
		return "";
	at += needle.size();
	std::string out;
	for (size_t i = at; i < json.size() && json[i] != '"'; i++) {
		if (json[i] == '\\' && i + 1 < json.size()) {
			char c = json[++i];  // undo the escaping to_json applied
			out += c == 'n' ? '\n' : c == 't' ? '\t' : c == 'r' ? '\r' : c;
		} else
			out += json[i];
	}
	return out;
}

// Value of a top-level numeric field, e.g. field(j,"exit_code").
static long json_int(const std::string &json, const std::string &key, long dflt)
{
	std::string needle = "\"" + key + "\":";
	size_t at = json.find(needle);
	if (at == std::string::npos)
		return dflt;
	return strtol(json.c_str() + at + needle.size(), nullptr, 10);
}

Simulation run_explore(const Event &ev, const ProgressFn &progress)
{
	Simulation s;
	double timeout = atof(env("SID_EXPLORE_TIMEOUT", "10").c_str());
	std::vector<std::string> args = {env("SID_EXPLORE_BIN", "/usr/local/bin/sid-explore"),
					 "--uid", std::to_string(ev.uid), "--gid", std::to_string(ev.gid),
					 "--user", ev.user, "--cwd", ev.cwd.empty() ? "/" : ev.cwd,
					 "--env-pid", std::to_string(ev.pid), "--timeout", std::to_string(timeout)};
	std::string groups;
	for (auto g : ev.groups)
		groups += (groups.empty() ? "" : ",") + std::to_string(g);
	if (!ev.groups.empty())
		args.insert(args.end(), {"--groups", groups});
	if (!ev.file.empty())
		args.insert(args.end(), {"--exe", ev.file});

	// Two pipes: p for sid-explore's stdout (the final report), prog for live snapshots.
	int p[2], prog[2];
	if (pipe2(p, O_CLOEXEC) != 0) {
		s.error = "pipe failed";
		return s;
	}
	bool want_progress = progress != nullptr;
	if (want_progress && pipe2(prog, O_CLOEXEC) != 0) {
		close(p[0]);
		close(p[1]);
		s.error = "pipe failed";
		return s;
	}
	if (want_progress)
		args.insert(args.end(), {"--progress-fd", "3"});
	args.push_back("--");
	if (ev.argv.empty())
		args.push_back(ev.path);
	else
		args.insert(args.end(), ev.argv.begin(), ev.argv.end());

	posix_spawn_file_actions_t fa;
	posix_spawn_file_actions_init(&fa);
	posix_spawn_file_actions_adddup2(&fa, p[1], 1);
	if (want_progress)
		posix_spawn_file_actions_adddup2(&fa, prog[1], 3);  // sid-explore writes snapshots here
	std::vector<char *> av;
	for (auto &a : args)
		av.push_back(const_cast<char *>(a.c_str()));
	av.push_back(nullptr);
	pid_t pid;
	int rc = posix_spawn(&pid, av[0], &fa, nullptr, av.data(), environ);
	posix_spawn_file_actions_destroy(&fa);
	close(p[1]);
	if (want_progress)
		close(prog[1]);
	if (rc != 0) {
		close(p[0]);
		if (want_progress)
			close(prog[0]);
		s.error = "cannot start " + args[0];
		return s;
	}

	// sid-explore enforces its own timeout; this one only guards against it hanging.
	std::string out, prog_buf;
	int budget_ms = (int)(timeout * 1000) + 15000;
	char buf[65536];
	bool out_open = true, prog_open = want_progress;
	while (out_open) {
		pollfd pfds[2] = {{p[0], POLLIN, 0}, {want_progress ? prog[0] : -1, POLLIN, 0}};
		if (poll(pfds, 2, budget_ms) <= 0) {
			kill(pid, SIGKILL);
			s.error = "simulation hung";
			break;
		}
		if (prog_open && (pfds[1].revents & (POLLIN | POLLHUP))) {
			ssize_t n = read(prog[0], buf, sizeof(buf));
			if (n <= 0)
				prog_open = false;
			else {
				prog_buf.append(buf, n);
				size_t nl;
				while ((nl = prog_buf.find('\n')) != std::string::npos) {
					progress(prog_buf.substr(0, nl));
					prog_buf.erase(0, nl + 1);
				}
			}
		}
		if (pfds[0].revents & (POLLIN | POLLHUP)) {
			ssize_t n = read(p[0], buf, sizeof(buf));
			if (n <= 0)
				out_open = false;
			else
				out.append(buf, n);
		}
	}
	close(p[0]);
	if (want_progress)
		close(prog[0]);
	int status = 0;
	waitpid(pid, &status, 0);

	size_t nl = out.find('\n');
	if (nl != std::string::npos) {
		s.summary_json = out.substr(0, nl);
		size_t nl2 = out.find('\n', nl + 1);
		s.full_json = out.substr(nl + 1, nl2 == std::string::npos ? std::string::npos : nl2 - nl - 1);
	}
	s.outcome = json_field(s.summary_json, "outcome");
	s.exit_code = (int)json_int(s.summary_json, "exit_code", -1);
	s.output = json_field(s.full_json, "output");  // captured stdout+stderr, to reuse on approval
	s.succeeded = s.outcome == kOutcomeCompleted && s.exit_code == 0;
	s.ok = s.error.empty() && WIFEXITED(status) && WEXITSTATUS(status) == 0 && !s.full_json.empty();
	if (!s.ok && s.error.empty())
		s.error = "simulation failed (exit " + std::to_string(WIFEXITED(status) ? WEXITSTATUS(status) : -1) + ")";
	return s;
}

Decision decide_certain(const Event &ev, const JevResult &jev, const Enforcer &on_deny)
{
	Decision d;
	d.decided_by = "jev";
	d.has_score = jev.has_probabilities;
	d.score = jev.p_block;
	d.reason = jev.reason.empty() ? jev_json(jev) : jev.reason;
	if (jev.choice == JevChoice::Allow) {  // same as a human approve: let it run
		d.verdict = Verdict::Allow;
		return d;
	}
	// JevChoice::Block -- same as a human deny: block and sever the origin.
	d.verdict = Verdict::Block;
	if (on_deny)
		d.reason += "; enforced " + on_deny(ev, "command blocked by model");
	return d;
}

Decision handle_unsure(const Event &ev, const JevResult &jev, ReviewQueue &q, const Explorer &explore,
		       std::chrono::milliseconds review_ttl, const ExtendDeadline &extend, const Enforcer &on_deny)
{
	Decision d;
	d.decided_by = "review";
	d.has_score = jev.has_probabilities;
	d.score = jev.p_block;
	d.explored = true;

	// Submit the review up front (empty report), so a front end sees it and can
	// watch the file changes build up before the simulation has even finished.
	Review r;
	r.event_id = ev.id;
	r.command = command_text(ev);
	r.user = ev.user;
	r.origin = origin_description(ev);
	r.origin_json = origin_json(ev);  // type, parent chain, and what a denial would sever
	r.reason = jev.reason.empty() ? "model unsure; simulating" : jev.reason + "; simulating";
	r.model_json = jev_json(jev);
	r.summary_json = "null";
	r.full_json = "null";
	// A human rejecting this command -- now, or after it has timed out -- means it
	// is malicious: sever the origin. Approving severs nothing. The queue runs this
	// exactly once, whenever the human actually answers.
	Event ev_copy = ev;
	r.on_resolve = [ev_copy, on_deny](bool approve) -> std::string {
		if (!approve && on_deny)
			return on_deny(ev_copy, "command denied by reviewer");
		return "null";
	};

	// Simulating can take seconds, and a person then decides: keep the kernel
	// waiting rather than letting the daemon's deadline deny the command.
	if (extend)
		extend(std::chrono::milliseconds((long)(atof(env("SID_EXPLORE_TIMEOUT", "10").c_str()) * 1000) +
						 review_ttl.count() + 20000));
	std::string id = q.submit(r, review_ttl);

	Simulation sim = explore(ev, [&](const std::string &snap) { q.progress(id, snap); });
	d.effects = sim.summary_json;
	// Carry the simulated result forward, so an approved command's output and exit
	// code are available to reuse rather than lost with the sandbox.
	d.has_result = sim.ok;
	d.result_exit = sim.exit_code;
	d.result_success = sim.succeeded;
	d.result_output = sim.output;

	// Tell the reviewer plainly how the simulation ended. A command that timed out
	// or tried to reach another machine is only partly previewed; approving it runs
	// it for real on the host anyway, which the front end should make clear.
	std::string note;
	if (sim.outcome == kOutcomeNetwork)
		note = "the command tried to open a connection to another machine; simulation stopped there";
	else if (sim.outcome == kOutcomeTimedOut)
		note = "the command was still running at the time limit; simulation stopped";
	else if (sim.outcome == kOutcomeCrashed)
		note = "the command crashed during simulation; the changes it made before crashing are shown";
	else if (!sim.ok)
		note = "could not simulate: " + sim.error;
	std::string reason = jev.reason;
	if (!note.empty())
		reason += (reason.empty() ? "" : "; ") + note;
	q.finalize(id, sim.summary_json.empty() ? "null" : sim.summary_json, sim.full_json.empty() ? "null" : sim.full_json,
		   reason);

	// Wait up to the review's lifetime for a human. Denial severs via on_resolve
	// (run inside answer()), so nothing to enforce here. A timeout blocks this exec
	// but leaves the review open for a later human decision (which may still sever).
	bool approved = q.wait(id);
	auto final = q.get(id);
	d.verdict = approved ? Verdict::Allow : Verdict::Block;
	std::string state = final ? state_name(final->state) : "unknown";
	d.reason = "model unsure; simulated (" + (sim.outcome.empty() ? std::string("error") : sim.outcome) + "); review " + id +
		   " " + state + (final && !final->answered_by.empty() ? " by " + final->answered_by : "");
	if (final && final->state == ReviewState::TimedOut)
		d.reason += " (blocked; still open for a human to reject and sever, or approve)";
	return d;
}
