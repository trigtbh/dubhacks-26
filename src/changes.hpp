// What a simulated command did to the filesystem, ranked for a person to review.
// Pure logic: no syscalls, so it is unit-testable anywhere.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

enum class Kind { Added, Deleted, Modified, Moved };

inline const char *kind_name(Kind k)
{
	return k == Kind::Added ? "added" : k == Kind::Deleted ? "deleted" : k == Kind::Modified ? "modified" : "moved";
}

struct Change {
	Kind kind = Kind::Modified;
	bool is_dir = false;
	std::string path;  // where it is after the command (for Deleted: where it was)
	std::string from;  // Moved only: where it was before
	uint64_t old_size = 0, new_size = 0;
	double delta = 0;    // fraction of bits changed, 0..1 (Added/Deleted are 1, Moved is 0)
	std::string digest;  // content identity (file sha256, or a dir manifest hash); used to pair moves
	std::string note;    // e.g. "metadata only", "symlink"
};

struct Counts {
	size_t added = 0, deleted = 0, modified = 0, moved = 0;
	size_t dirs_added = 0, dirs_deleted = 0, dirs_moved = 0;  // subsets of the above
	size_t total() const { return added + deleted + modified + moved; }
};

// An attempt by the simulated command to reach another machine. The simulation
// stops at the first one: the command never gets the connection.
struct NetAttempt {
	std::string program;      // the executable that tried
	std::string destination;  // "93.184.215.14:443", or the host name for a DNS lookup
	std::string detail;       // "connect", "DNS lookup", ...
};

// How a simulation ended.
//   completed: the command exited by itself
//   crashed:   the command died on a fatal signal (segfault, abort, ...)
//   timed_out: still running at the time limit; stopped
//   network:   tried to reach another machine; stopped there
//   error:     the simulation could not be set up (see Report::error)
// None of these is a verdict: a crashed, timed-out or network command is still
// shown to a person to approve or reject, exactly like a clean completion.
inline const char *const kOutcomeCompleted = "completed";
inline const char *const kOutcomeCrashed = "crashed";
inline const char *const kOutcomeTimedOut = "timed_out";
inline const char *const kOutcomeNetwork = "network";
inline const char *const kOutcomeError = "error";
inline const char *const kOutcomeRunning = "running";  // progress snapshot only

// Everything one simulation produced.
struct Report {
	std::vector<std::string> argv;
	std::string cwd, user;
	std::vector<Change> changes;   // ranked
	std::vector<std::string> read;  // files opened read-only
	std::vector<std::string> executed;
	std::string outcome = kOutcomeCompleted;
	std::vector<NetAttempt> network;
	bool finished = true;  // false for a progress snapshot taken while the command runs
	int exit_code = -1;
	bool timed_out = false;
	std::string output;  // first few KB of stdout+stderr
	std::string error;   // set when the simulation itself failed
	double elapsed_ms = 0;
};

// Fraction of differing bits between two byte strings. Bytes past the end of
// the shorter one count as fully changed; two empty strings differ by 0.
double bit_delta(const std::string &before, const std::string &after);

// Streaming version of bit_delta for files too big to hold in memory.
class BitDiff {
public:
	void feed(const char *a, size_t na, const char *b, size_t nb);  // aligned chunks of each side
	double fraction() const;

private:
	uint64_t diff_bits_ = 0, len_a_ = 0, len_b_ = 0;
};

// Ranking for summaries, most important first:
//   1. directories before files
//   2. additions and deletions, then modifications, then moves
//   3. larger fraction of bits changed first
//   (then by path, so the order is stable)
bool more_important(const Change &a, const Change &b);
void rank(std::vector<Change> &changes);

// Pair each Deleted with an Added of identical content into one Moved, and
// drop the children of moved directories (they moved with their parent).
void pair_moves(std::vector<Change> &changes);

Counts count(const std::vector<Change> &changes);

// JSON for the front end. The summary has the counts and the top `top` changes;
// the full report has every change, the files read and executed, and the output.
std::string summary_json(const Report &r, size_t top = 5);
std::string full_json(const Report &r);
std::string json_str(const std::string &s);
