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
