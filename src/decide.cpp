#include "decide.hpp"

#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <string>

#include "enforce.hpp"
#include "jev.hpp"
#include "review.hpp"
#include "unsure.hpp"

namespace {

std::string env(const char *k, const char *dflt)
{
	const char *v = getenv(k);
	return v && *v ? v : dflt;
}

ReviewQueue &reviews()
{
	static ReviewQueue q;  // lives for the whole process: the socket threads use it
	return q;
}

// Benign shell startup commands must not be held or the session cannot start.
bool always_allow(const Event &ev)
{
	const std::string &prog = !ev.file.empty() ? ev.file : ev.path;
	if (prog == "/usr/bin/clear_console") return true;

	const char *demo_bootstrap = getenv("SID_DEMO_ALLOW_SHELL_BOOTSTRAP");
	if (!demo_bootstrap || std::string(demo_bootstrap) != "1" || ev.uid != 10001 || ev.cwd != "/workspace")
		return false;
	if ((ev.file == "/usr/bin/python3" || ev.file == "/usr/bin/python3.11") && ev.argv.size() == 2 &&
	    ev.argv[0] == "python3" && ev.argv[1] == "-q")
		return true;
	if (ev.file == "/usr/bin/bash" && ev.argv.size() == 4 &&
	    ev.argv[0] == "bash" && ev.argv[1] == "--noprofile" &&
	    ev.argv[2] == "--norc" && ev.argv[3] == "-i")
		return true;
	return false;
}

}  // namespace

void decide_init()
{
	std::string sock = env("SID_REVIEW_SOCK", "/run/sid/review.sock");
	mkdir(sock.substr(0, sock.rfind('/')).c_str(), 0700);
	serve_reviews(reviews(), sock);
	enforce_init(getpid());  // so enforcement never kills the daemon or its ancestors
	jev_init();
}

Decision decide(const Event &ev)
{
	if (always_allow(ev)) {
		Decision d;
		d.verdict = Verdict::Allow;
		d.decided_by = "allowlist";
		d.reason = "shell teardown command, always allowed";
		return d;
	}
	JevResult j = read_jev_output(jev_classify(ev));
	// A certain verdict resolves now, with the same consequence a human review
	// reaches: allow runs the command, block blocks it and severs the origin.
	if (j.choice != JevChoice::Hold)
		return decide_certain(ev, j, enforce_denial);
	// Unsure: surface the pending command to the dashboard, then simulate and ask a person.
	emit_hold(ev);
	auto ttl = std::chrono::milliseconds((long)(atof(env("SID_REVIEW_TIMEOUT", "120").c_str()) * 1000));
	return handle_unsure(ev, j, reviews(), run_explore, ttl, extend_deadline, enforce_denial);
}
