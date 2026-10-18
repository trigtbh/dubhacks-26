// The unsure path end to end, without the fanotify capture: pretend the model
// was unsure about a command, simulate it with sid-explore, publish the review
// on the socket, and wait for a front end to answer.
//
//   sid-demo-unsure --uid 1000 --gid 1000 --user dev --cwd /home/dev -- rm -rf build
// then, from another shell:
//   echo LIST | socat - UNIX-CONNECT:$SID_REVIEW_SOCK
//   echo "APPROVE r1" | socat - UNIX-CONNECT:$SID_REVIEW_SOCK
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <string>

#include "enforce.hpp"
#include "unsure.hpp"

int main(int argc, char **argv)
{
	Event ev;
	ev.id = "demo";
	ev.cwd = "/";
	ev.pid = getpid();  // the real daemon fills origin/parent_chain from /proc; this demo runs locally
	int i = 1;
	for (; i < argc && std::string(argv[i]) != "--"; i += 2) {
		std::string k = argv[i], v = i + 1 < argc ? argv[i + 1] : "";
		if (k == "--uid") ev.uid = std::stoul(v);
		else if (k == "--gid") ev.gid = std::stoul(v);
		else if (k == "--user") ev.user = v;
		else if (k == "--cwd") ev.cwd = v;
	}
	for (i++; i < argc; i++)
		ev.argv.push_back(argv[i]);
	ev.path = ev.argv.empty() ? "" : ev.argv[0];

	static ReviewQueue q;
	const char *sock = getenv("SID_REVIEW_SOCK");
	serve_reviews(q, sock ? sock : "/run/sid/review.sock");

	// Stands in for the model's JSON output; the daemon reads it the same way.
	const char *model = getenv("SID_DEMO_JEV");
	JevResult j = read_jev_output(model ? model : R"({"choice":"hold","probabilities":{"allow":0.4,"hold":0.45,"block":0.15}})");
	if (j.choice != JevChoice::Hold) {
		printf("model chose %s; nothing to review\n", jev_choice_name(j.choice));
		return 0;
	}
	enforce_init(getpid());  // the guard keeps enforcement from killing this demo's own session
	const char *ttl = getenv("SID_REVIEW_TIMEOUT");
	auto review_ttl = std::chrono::milliseconds((long)((ttl && *ttl ? atof(ttl) : 60.0) * 1000));
	Decision d = handle_unsure(ev, j, q, run_explore, review_ttl, nullptr, enforce_denial);
	printf("verdict=%s reason=\"%s\"\n", verdict_name(d.verdict), d.reason.c_str());
	// The real daemon keeps the review queue alive for its whole life; this one-shot
	// demo would exit here, closing the socket. Linger so a late (post-timeout)
	// decision can still be made against the still-open review.
	const char *linger = getenv("SID_DEMO_LINGER");
	if (linger && atoi(linger) > 0) {
		printf("review still open; waiting %ss for a late decision...\n", linger);
		fflush(stdout);
		sleep(atoi(linger));
	}
	return 0;
}
