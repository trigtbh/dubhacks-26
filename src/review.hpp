// Pending approvals for commands the model was unsure about.
//
// The decider submits a Review (the simulation's summary and full report) and
// blocks in wait(); a front end lists, inspects and answers reviews. No answer
// before the deadline means deny, so nothing runs unless a person approved it.
//
// Front ends talk to it over a Unix socket (SID_REVIEW_SOCK, default
// /run/sid/review.sock), one command per line, one JSON object per reply line:
//   LIST                 pending reviews, as summaries
//   GET <id>             one review's summary (top 5 changes + counts)
//   FULL <id>            one review's full report (every change, files read/executed)
//   APPROVE <id> [who]   let the command run for real
//   DENY <id> [who]      block it; the simulation left the real filesystem untouched
//   WATCH                stream new, progress, updated, resolved, and timed_out events
#pragma once
#include <chrono>
#include <condition_variable>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

// Pending  : awaiting a human, the command's exec still paused.
// Approved : a human allowed it.
// Denied   : a human rejected it -> malicious -> its origin is severed.
// TimedOut : no human answered before the exec deadline, so the exec was blocked
//            (fail-closed). NOT a verdict: nothing is severed, and the review
//            stays answerable, so a human can still reject it later (-> severs)
//            or approve it (they accept the risk and re-run it themselves).
enum class ReviewState { Pending, Approved, Denied, TimedOut };

inline const char *state_name(ReviewState s)
{
	return s == ReviewState::Pending ? "pending" : s == ReviewState::Approved ? "approved"
						 : s == ReviewState::Denied ? "denied" : "timed_out";
}

// Only Pending and TimedOut still await a human; the rest are final.
inline bool is_open(ReviewState s) { return s == ReviewState::Pending || s == ReviewState::TimedOut; }

struct Review {
	std::string id;
	std::string event_id;  // the daemon's Event id, to join with events.jsonl
	std::string command, user, origin, reason;
	std::string model_json = "null";      // the JEV output: choice + probabilities
	std::string origin_json = "null";     // structured origin + what a denial would sever
	std::string summary_json, full_json;  // from the simulation
	std::string enforcement = "null";     // what severing did, filled on a denial
	ReviewState state = ReviewState::Pending;
	std::string answered_by;
	std::chrono::system_clock::time_point created, expires;

	// Run once when a human resolves this review, with their approve/deny, even if
	// that happens after a timeout. Returns a JSON enforcement summary ("null" if
	// none). This is where a denial severs the origin. Not serialized.
	std::function<std::string(bool approve)> on_resolve;
};

class ReviewQueue {
public:
	using Listener = std::function<void(const std::string &json_line)>;

	// Stores the review (assigning id/created/expires if unset) and announces it.
	std::string submit(Review r, std::chrono::milliseconds ttl);
	// Replace a pending review's live summary and announce {"event":"progress",...}.
	// Used while the simulation runs; no-op if the id is gone or already resolved.
	bool progress(const std::string &id, const std::string &summary_json);
	// Replace the final report (summary, full, reason) and announce {"event":"updated",...}.
	bool finalize(const std::string &id, const std::string &summary_json, const std::string &full_json,
		       const std::string &reason);
	// A human resolves the review. Allowed while it is open (Pending or TimedOut),
	// so a review may be answered after it timed out. First answer wins; false if
	// the id is unknown or already final. Runs on_resolve (which severs on a deny).
	bool answer(const std::string &id, bool approve, const std::string &by);
	// Blocks until answered or the exec deadline. true = approved. A deadline with
	// no answer marks it TimedOut (the caller blocks the exec) but leaves it open.
	bool wait(const std::string &id);

	std::vector<Review> pending() const;  // every open review (Pending and TimedOut)
	std::optional<Review> get(const std::string &id) const;

	int listen(Listener l);  // returns a token for unlisten
	void unlisten(int token);

	std::string handle(const std::string &line);  // one protocol command -> one JSON reply

private:
	void announce(const std::string &line);
	void finish_locked(Review &r, ReviewState s, const std::string &by);
	void prune_locked();

	mutable std::mutex mu_;
	std::condition_variable cv_;
	std::map<std::string, Review> reviews_;
	std::map<int, Listener> listeners_;
	int next_token_ = 1;
	unsigned long next_id_ = 1;
};

std::string review_summary_json(const Review &r);  // metadata + summary
std::string review_full_json(const Review &r);     // metadata + full report

// Serves q.handle() on a Unix socket, one thread per client. Returns after the
// listening thread starts; throws std::runtime_error if the socket can't be bound.
// The threads never stop, so `q` must live for the rest of the process.
void serve_reviews(ReviewQueue &q, const std::string &sock_path);
