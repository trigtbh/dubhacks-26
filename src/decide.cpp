#include "decide.hpp"

void decide_init()
{
	// TODO(laya): load models here.
}

Decision decide(const Event &ev)
{
	(void)ev;
	// TODO(laya): replace this stub.
	Decision d;
	d.verdict = Verdict::Allow;
	d.decided_by = "stub";
	d.reason = "stub decider: return allow (Laya not wired in yet)";
	return d;
}
