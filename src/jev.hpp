// Model interface used by command review. jev_laya.cpp starts a persistent Laya
// child in jev_init() and sends Event JSON over a private socket for inference.
//
// jev_classify() sees the fully gathered Event: the command (argv, file, script),
// the caller's context (user, uid/groups, origin: local/ssh/service/agent,
// parent chain, stdin feeder) and the session's recent commands (Event::to_json()
// serializes all of it). It returns the model's JSON output, as text:
//   {"choice": "allow", "probabilities": {"allow": 0.97, "hold": 0.02, "block": 0.01}}
// "hold" means the model is unsure: the command is simulated and a person decides.
// An optional "reason" string is shown to that person. It is called concurrently
// from many daemon threads, so it must be thread-safe.
#pragma once
#include <string>

#include "event.hpp"

enum class JevChoice { Allow, Hold, Block };

inline const char *jev_choice_name(JevChoice c)
{
	return c == JevChoice::Allow ? "allow" : c == JevChoice::Hold ? "hold" : "block";
}

struct JevResult {
	JevChoice choice = JevChoice::Allow;
	bool has_probabilities = false;
	double p_allow = 0, p_hold = 0, p_block = 0;
	std::string reason;  // optional; shown to the reviewer for Hold
};

void jev_init();                         // load weights; called once before the capture goes live
std::string jev_classify(const Event &ev);  // the model's JSON output

// The model's JSON -> JevResult. False (with *err set) if it is malformed: no or
// unknown "choice", or probabilities that are not numbers in [0, 1] summing to ~1.
bool parse_jev_json(const std::string &json, JevResult &out, std::string *err = nullptr);

// What the daemon acts on. Output that can't be parsed becomes Hold: a person
// decides, rather than the command silently running or silently failing.
JevResult read_jev_output(const std::string &json);

// JevResult -> the same JSON shape, for the review payload and the event log.
std::string jev_json(const JevResult &r);
