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

// Benign commands the shell itself runs that must never be held, or routine
// actions hang (clear_console runs on every logout). Matched on the resolved
// program, so a copy planted elsewhere under the same name is not covered.
bool always_allow(const Event &ev)
{
	static const char *const paths[] = {"/usr/bin/clear_console"};
	const std::string &prog = !ev.file.empty() ? ev.file : ev.path;
	for (const char *p : paths)
		if (prog == p || (prog.empty() && !ev.argv.empty() && ev.argv[0] == p))
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
