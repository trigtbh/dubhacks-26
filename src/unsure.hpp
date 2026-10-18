// What happens when the JEV model can't tell whether a command is benign or
// malicious: simulate it, show a person what it would change, and let them decide.
//
//   1. run the command under sid-explore: a copy-on-write view of every mount, no
//      network, as the original user, in the original directory
//   2. turn the overlay's upper layers into added/deleted/modified/moved changes,
//      ranked (dirs first; add/delete, then modify, then move; biggest % of bits changed)
//   3. submit a Review (summary: counts + top 5; full: every change, files read/run)
//      to the ReviewQueue, where a front end picks it up (see review.hpp)
//   4. approved -> the paused command runs for real; denied or no answer -> blocked.
//      The simulation never touched the real filesystem either way.
#pragma once
#include <chrono>
#include <functional>
#include <string>

#include "event.hpp"
#include "jev.hpp"
#include "review.hpp"

struct Simulation {
	bool ok = false;
	std::string summary_json, full_json;  // the two lines sid-explore prints
	std::string outcome;                  // completed | timed_out | network | error
	std::string error;
};

// Called with each live summary snapshot (one JSON object) while the command runs.
using ProgressFn = std::function<void(const std::string &summary_json)>;
using Explorer = std::function<Simulation(const Event &, const ProgressFn &)>;
using ExtendDeadline = std::function<void(std::chrono::milliseconds from_now)>;
// Carry out a denial (sever the origin). Returns a JSON summary. See enforce.hpp.
using Enforcer = std::function<std::string(const Event &ev, const std::string &reason)>;

// Spawns sid-explore (SID_EXPLORE_BIN, default /usr/local/bin/sid-explore) for the
// event's command and collects its report, forwarding live snapshots to `progress`
// (may be null). Times out after SID_EXPLORE_TIMEOUT seconds (default 10).
Simulation run_explore(const Event &ev, const ProgressFn &progress);

// A final allow/deny for a command, with the same consequence a human review
// reaches: an allow runs it; a deny blocks it AND severs the origin via `on_deny`.
// Used for the model's certain verdicts (jev allow/block) so they behave exactly
// like a reviewer's approve/deny. `jev` carries the probabilities, if any.
Decision decide_certain(const Event &ev, const JevResult &jev, const Enforcer &on_deny);

// The whole unsure path. `extend` pushes the daemon's answer deadline out while a
// person decides (pass nullptr outside the daemon). `on_deny` severs the origin
// when the reviewer denies the command (pass nullptr to skip enforcement).
Decision handle_unsure(const Event &ev, const JevResult &jev, ReviewQueue &q, const Explorer &explore,
		       std::chrono::milliseconds review_ttl, const ExtendDeadline &extend, const Enforcer &on_deny);

std::string command_text(const Event &ev);
