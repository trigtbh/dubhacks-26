#include "changes.hpp"

#include <algorithm>
#include <cstdio>
#include <map>

namespace {

int popcount8(unsigned char c) { return __builtin_popcount(c); }

int kind_rank(Kind k) { return k == Kind::Added || k == Kind::Deleted ? 0 : k == Kind::Modified ? 1 : 2; }

bool under(const std::string &path, const std::string &dir)
{
	if (dir == "/")
		return path.size() > 1 && path[0] == '/';
	return path.size() > dir.size() && path.compare(0, dir.size(), dir) == 0 && path[dir.size()] == '/';
}

std::string num(double v)
{
	char b[32];
	snprintf(b, sizeof(b), "%.4g", v);
	return b;
}

std::string change_json(const Change &c)
{
	std::string s = "{\"kind\":" + json_str(kind_name(c.kind)) + ",\"type\":" + json_str(c.is_dir ? "dir" : "file") +
			",\"path\":" + json_str(c.path);
	if (c.kind == Kind::Moved)
		s += ",\"from\":" + json_str(c.from);
	if (!c.is_dir)
		s += ",\"old_size\":" + std::to_string(c.old_size) + ",\"new_size\":" + std::to_string(c.new_size);
	s += ",\"delta\":" + num(c.delta);
	if (!c.note.empty())
		s += ",\"note\":" + json_str(c.note);
	return s + "}";
}

std::string counts_json(const Counts &n)
{
	return "{\"added\":" + std::to_string(n.added) + ",\"deleted\":" + std::to_string(n.deleted) +
	       ",\"modified\":" + std::to_string(n.modified) + ",\"moved\":" + std::to_string(n.moved) +
	       ",\"dirs_added\":" + std::to_string(n.dirs_added) + ",\"dirs_deleted\":" + std::to_string(n.dirs_deleted) +
	       ",\"dirs_moved\":" + std::to_string(n.dirs_moved) + ",\"total\":" + std::to_string(n.total()) + "}";
}

std::string str_arr(const std::vector<std::string> &v)
{
	std::string s = "[";
	for (size_t i = 0; i < v.size(); i++)
		s += (i ? "," : "") + json_str(v[i]);
	return s + "]";
}

std::string net_json(const std::vector<NetAttempt> &v)
{
	std::string s = "[";
	for (size_t i = 0; i < v.size(); i++)
		s += std::string(i ? "," : "") + "{\"program\":" + json_str(v[i].program) + ",\"destination\":" +
		     json_str(v[i].destination) + ",\"detail\":" + json_str(v[i].detail) + "}";
	return s + "]";
}

std::string head_json(const Report &r)
{
	std::string s = "{\"command\":" + str_arr(r.argv) + ",\"cwd\":" + json_str(r.cwd) + ",\"user\":" + json_str(r.user) +
			",\"finished\":" + (r.finished ? "true" : "false") + ",\"outcome\":" + json_str(r.outcome) +
			",\"network\":" + net_json(r.network) +
			",\"exit_code\":" + std::to_string(r.exit_code) + ",\"timed_out\":" + (r.timed_out ? "true" : "false") +
			",\"elapsed_ms\":" + num(r.elapsed_ms);
	if (!r.error.empty())
		s += ",\"error\":" + json_str(r.error);
	return s + ",\"counts\":" + counts_json(count(r.changes)) + ",\"files_read\":" + std::to_string(r.read.size()) +
	       ",\"files_executed\":" + std::to_string(r.executed.size());
}

}  // namespace

std::string json_str(const std::string &s)
{
	std::string o = "\"";
	for (unsigned char c : s) {
		switch (c) {
		case '"': o += "\\\""; break;
		case '\\': o += "\\\\"; break;
		case '\n': o += "\\n"; break;
		case '\r': o += "\\r"; break;
		case '\t': o += "\\t"; break;
		default:
			if (c < 0x20 || c == 0x7f) {
				char b[8];
				snprintf(b, sizeof(b), "\\u%04x", c);
				o += b;
			} else
				o += (char)c;
		}
	}
	return o + "\"";
}

void BitDiff::feed(const char *a, size_t na, const char *b, size_t nb)
{
	size_t common = std::min(na, nb);
	for (size_t i = 0; i < common; i++)
		diff_bits_ += popcount8((unsigned char)(a[i] ^ b[i]));
	diff_bits_ += 8 * (std::max(na, nb) - common);
	len_a_ += na;
	len_b_ += nb;
}

double BitDiff::fraction() const
{
	uint64_t longest = std::max(len_a_, len_b_);
	return longest ? (double)diff_bits_ / (8.0 * longest) : 0.0;
}

double bit_delta(const std::string &before, const std::string &after)
{
	BitDiff d;
	d.feed(before.data(), before.size(), after.data(), after.size());
	return d.fraction();
}

bool more_important(const Change &a, const Change &b)
{
	if (a.is_dir != b.is_dir)
		return a.is_dir;
	if (kind_rank(a.kind) != kind_rank(b.kind))
		return kind_rank(a.kind) < kind_rank(b.kind);
	if (a.delta != b.delta)
		return a.delta > b.delta;
	return a.path < b.path;
}

void rank(std::vector<Change> &changes) { std::stable_sort(changes.begin(), changes.end(), more_important); }

void pair_moves(std::vector<Change> &changes)
{
	// Directories first, so a moved directory's children are dropped rather than
	// paired one by one.
	std::vector<Change> moved;
	for (bool dirs : {true, false}) {
		std::multimap<std::string, size_t> added;  // digest -> index
		for (size_t i = 0; i < changes.size(); i++)
			if (changes[i].kind == Kind::Added && changes[i].is_dir == dirs && !changes[i].digest.empty())
				added.emplace(changes[i].digest, i);
		std::vector<bool> gone(changes.size(), false);
		for (size_t i = 0; i < changes.size(); i++) {
			Change &d = changes[i];
			if (d.kind != Kind::Deleted || d.is_dir != dirs || d.digest.empty())
				continue;
			auto it = added.find(d.digest);
			if (it == added.end())
				continue;
			Change m = changes[it->second];
			m.kind = Kind::Moved;
			m.from = d.path;
			m.old_size = d.old_size;
			m.delta = 0;
			gone[i] = gone[it->second] = true;
			added.erase(it);
			moved.push_back(m);
		}
		std::vector<Change> keep;
		for (size_t i = 0; i < changes.size(); i++) {
			if (gone[i])
				continue;
			const Change &c = changes[i];
			bool child_of_move = false;
			for (auto &m : moved)
				if (m.is_dir && ((c.kind == Kind::Added && under(c.path, m.path)) ||
						 (c.kind == Kind::Deleted && under(c.path, m.from))))
					child_of_move = true;
			if (!child_of_move)
				keep.push_back(c);
		}
		changes.swap(keep);
	}
	changes.insert(changes.end(), moved.begin(), moved.end());
}

Counts count(const std::vector<Change> &changes)
{
	Counts n;
	for (auto &c : changes)
		switch (c.kind) {
		case Kind::Added: n.added++; n.dirs_added += c.is_dir; break;
		case Kind::Deleted: n.deleted++; n.dirs_deleted += c.is_dir; break;
		case Kind::Modified: n.modified++; break;
		case Kind::Moved: n.moved++; n.dirs_moved += c.is_dir; break;
		}
	return n;
}

std::string summary_json(const Report &r, size_t top)
{
	std::vector<Change> sorted = r.changes;
	rank(sorted);
	std::string s = head_json(r) + ",\"top\":[";
	for (size_t i = 0; i < sorted.size() && i < top; i++)
		s += (i ? "," : "") + change_json(sorted[i]);
	return s + "],\"more\":" + std::to_string(sorted.size() > top ? sorted.size() - top : 0) + "}";
}

std::string full_json(const Report &r)
{
	std::vector<Change> sorted = r.changes;
	rank(sorted);
	std::string s = head_json(r) + ",\"changes\":[";
	for (size_t i = 0; i < sorted.size(); i++)
		s += (i ? "," : "") + change_json(sorted[i]);
	return s + "],\"read\":" + str_arr(r.read) + ",\"executed\":" + str_arr(r.executed) +
	       ",\"output\":" + json_str(r.output) + "}";
}
