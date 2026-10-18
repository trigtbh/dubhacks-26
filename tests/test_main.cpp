// Unit tests: `make test` (Linux, root for the overlay/whiteout cases, which skip otherwise).
#include <fcntl.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/un.h>
#include <sys/xattr.h>
#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <thread>
#include <vector>

#include "changes.hpp"
#include "overlay_diff.hpp"
#include "enforce.hpp"
#include "review.hpp"
#include "unsure.hpp"

namespace {

int g_fail = 0, g_pass = 0, g_skip = 0;
std::string g_cur;

#define CHECK(cond)                                                                       \
	do {                                                                              \
		if (cond)                                                                 \
			g_pass++;                                                         \
		else {                                                                    \
			g_fail++;                                                         \
			fprintf(stderr, "FAIL %s: %s:%d: %s\n", g_cur.c_str(), __FILE__, __LINE__, #cond); \
		}                                                                         \
	} while (0)
#define CHECK_EQ(a, b) CHECK((a) == (b))
#define SKIP(why)                                                           \
	do {                                                                \
		g_skip++;                                                   \
		fprintf(stderr, "skip %s: %s\n", g_cur.c_str(), why);       \
		return;                                                     \
	} while (0)

std::vector<std::pair<const char *, std::function<void()>>> &tests()
{
	static std::vector<std::pair<const char *, std::function<void()>>> t;
	return t;
}
struct Reg {
	Reg(const char *n, std::function<void()> f) { tests().push_back({n, f}); }
};
#define TEST(name)                          \
	void name();                        \
	Reg reg_##name(#name, name);        \
	void name()

Change mk(Kind k, bool dir, const std::string &path, double delta = 1, const std::string &digest = "")
{
	Change c;
	c.kind = k;
	c.is_dir = dir;
	c.path = path;
	c.delta = delta;
	c.digest = digest;
	return c;
}

const Change *find(const std::vector<Change> &v, Kind k, const std::string &path)
{
	for (auto &c : v)
		if (c.kind == k && c.path == path)
			return &c;
	return nullptr;
}

// ---- scratch directories ----------------------------------------------------

std::string g_root;  // per-run scratch dir

void sh(const std::string &cmd)  // test setup only
{
	if (system(cmd.c_str()) != 0)
		fprintf(stderr, "setup command failed: %s\n", cmd.c_str());
}
void put(const std::string &p, const std::string &body)
{
	FILE *f = fopen(p.c_str(), "wb");
	fwrite(body.data(), 1, body.size(), f);
	fclose(f);
}
std::string fresh(const std::string &name)
{
	std::string d = g_root + "/" + name;
	sh("rm -rf '" + d + "' && mkdir -p '" + d + "'");
	return d;
}

// ---- bit delta --------------------------------------------------------------

TEST(bit_delta_basics)
{
	CHECK_EQ(bit_delta("", ""), 0.0);
	CHECK_EQ(bit_delta("abc", "abc"), 0.0);
	CHECK_EQ(bit_delta("", "abcd"), 1.0);      // all new bytes count as changed
	CHECK_EQ(bit_delta("abcd", ""), 1.0);
	CHECK_EQ(bit_delta(std::string(1, '\x00'), std::string(1, '\xff')), 1.0);
	CHECK_EQ(bit_delta(std::string(1, '\x00'), std::string(1, '\x01')), 1.0 / 8);
	// one byte appended to 3: 8 of 32 bits
	CHECK_EQ(bit_delta("abc", "abcd"), 0.25);
}

TEST(bit_delta_streaming_matches)
{
	std::string a(10000, 'x'), b = a;
	for (size_t i = 0; i < b.size(); i += 7)
		b[i] ^= 0x5a;
	b += "tail";
	BitDiff d;
	for (size_t off = 0; off < std::max(a.size(), b.size()); off += 333) {
		size_t na = off < a.size() ? std::min<size_t>(333, a.size() - off) : 0;
		size_t nb = off < b.size() ? std::min<size_t>(333, b.size() - off) : 0;
		d.feed(a.data() + off, na, b.data() + off, nb);
	}
	CHECK(std::abs(d.fraction() - bit_delta(a, b)) < 1e-12);
}

// ---- ranking ----------------------------------------------------------------

TEST(rank_dirs_before_files)
{
	std::vector<Change> v = {mk(Kind::Added, false, "/f"), mk(Kind::Moved, true, "/d", 0)};
	rank(v);
	CHECK(v[0].is_dir);  // even a moved dir beats an added file
}

TEST(rank_kinds)
{
	std::vector<Change> v = {mk(Kind::Moved, false, "/a", 0), mk(Kind::Modified, false, "/b", 0.9),
				 mk(Kind::Deleted, false, "/c"), mk(Kind::Added, false, "/d")};
	rank(v);
	CHECK(v[0].kind == Kind::Deleted || v[0].kind == Kind::Added);
	CHECK(v[1].kind == Kind::Deleted || v[1].kind == Kind::Added);
	CHECK(v[2].kind == Kind::Modified);
	CHECK(v[3].kind == Kind::Moved);
}

TEST(rank_by_delta)
{
	std::vector<Change> v = {mk(Kind::Modified, false, "/small", 0.01), mk(Kind::Modified, false, "/big", 0.6),
				 mk(Kind::Modified, false, "/mid", 0.2)};
	rank(v);
	CHECK_EQ(v[0].path, "/big");
	CHECK_EQ(v[1].path, "/mid");
	CHECK_EQ(v[2].path, "/small");
}

TEST(rank_is_total_and_stable)
{
	std::vector<Change> v = {mk(Kind::Added, false, "/b"), mk(Kind::Added, false, "/a")};
	rank(v);
	CHECK_EQ(v[0].path, "/a");  // ties broken by path
}

// ---- moves ------------------------------------------------------------------

TEST(pair_file_move)
{
	std::vector<Change> v = {mk(Kind::Deleted, false, "/old", 1, "f:x"), mk(Kind::Added, false, "/new", 1, "f:x"),
				 mk(Kind::Added, false, "/other", 1, "f:y")};
	pair_moves(v);
	CHECK_EQ(v.size(), 2u);
	auto m = find(v, Kind::Moved, "/new");
	CHECK(m && m->from == "/old" && m->delta == 0);
	CHECK(find(v, Kind::Added, "/other"));
}

TEST(pair_dir_move_drops_children)
{
	std::vector<Change> v = {mk(Kind::Deleted, true, "/src", 1, "d:1"), mk(Kind::Deleted, false, "/src/a", 1, "f:a"),
				 mk(Kind::Added, true, "/dst", 1, "d:1"), mk(Kind::Added, false, "/dst/a", 1, "f:a"),
				 mk(Kind::Added, false, "/srcx", 1, "f:z")};  // not a child, despite the prefix
	pair_moves(v);
	CHECK_EQ(v.size(), 2u);
	auto m = find(v, Kind::Moved, "/dst");
	CHECK(m && m->is_dir && m->from == "/src");
	CHECK(find(v, Kind::Added, "/srcx"));
}

TEST(no_move_without_digest_or_match)
{
	std::vector<Change> v = {mk(Kind::Deleted, false, "/a", 1, ""), mk(Kind::Added, false, "/b", 1, ""),
				 mk(Kind::Deleted, false, "/c", 1, "f:1"), mk(Kind::Added, true, "/d", 1, "f:1")};
	pair_moves(v);
	CHECK_EQ(count(v).moved, 0u);  // empty digests never match; file never pairs with dir
}

// ---- counts and summary -------------------------------------------------------

TEST(counts)
{
	std::vector<Change> v = {mk(Kind::Added, true, "/d"), mk(Kind::Added, false, "/d/f"), mk(Kind::Deleted, false, "/x"),
				 mk(Kind::Modified, false, "/m", 0.5), mk(Kind::Moved, true, "/n", 0)};
	Counts n = count(v);
	CHECK_EQ(n.added, 2u);
	CHECK_EQ(n.dirs_added, 1u);
	CHECK_EQ(n.deleted, 1u);
	CHECK_EQ(n.modified, 1u);
	CHECK_EQ(n.moved, 1u);
	CHECK_EQ(n.dirs_moved, 1u);
	CHECK_EQ(n.total(), 5u);
}

TEST(summary_top5_and_more)
{
	Report r;
	r.argv = {"sh", "-c", "x"};
	for (int i = 0; i < 8; i++)
		r.changes.push_back(mk(Kind::Modified, false, "/f" + std::to_string(i), i / 10.0));
	r.changes.push_back(mk(Kind::Deleted, true, "/important"));
	std::string s = summary_json(r);
	CHECK(s.find("\"more\":4") != std::string::npos);
	CHECK(s.find("/important") < s.find("/f7"));  // dir deletion first
	CHECK(s.find("/f2") == std::string::npos);    // only the top 5 make it
	CHECK(s.find("\"modified\":8") != std::string::npos);
	std::string f = full_json(r);
	CHECK(f.find("/f0") != std::string::npos);  // the full report has everything
}

TEST(json_escaping)
{
	CHECK_EQ(json_str("a\"b\\c\n\x01"), "\"a\\\"b\\\\c\\n\\u0001\"");
}

// ---- overlay diff on a hand-built upper layer ---------------------------------

TEST(diff_handbuilt_upper)
{
	if (geteuid() != 0)
		SKIP("needs root for whiteouts");
	std::string d = fresh("hand"), lo = d + "/lower", up = d + "/upper", mg = d + "/merged";
	sh("mkdir -p " + lo + "/gone_dir/sub " + lo + "/keep " + up + "/keep " + mg + "/keep");
	put(lo + "/gone_dir/sub/x", "x");
	put(lo + "/gone_file", "bye");
	put(lo + "/keep/edit", "aaaa");
	put(lo + "/keep/same", "same");
	put(up + "/keep/edit", "aaab");  // copied up and changed
	put(up + "/keep/same", "same");  // copied up, unchanged: not a change
	put(up + "/new", "hello");
	mknod((up + "/gone_dir").c_str(), S_IFCHR | 0, makedev(0, 0));
	mknod((up + "/gone_file").c_str(), S_IFCHR | 0, makedev(0, 0));

	auto v = diff_overlay(up, lo, "/");
	CHECK(find(v, Kind::Added, "/new"));
	CHECK(find(v, Kind::Deleted, "/gone_file"));
	auto gd = find(v, Kind::Deleted, "/gone_dir");
	CHECK(gd && gd->is_dir);
	CHECK(find(v, Kind::Deleted, "/gone_dir/sub/x"));  // children are listed too
	auto e = find(v, Kind::Modified, "/keep/edit");
	CHECK(e && e->delta > 0 && e->delta < 0.1);
	CHECK(!find(v, Kind::Modified, "/keep/same"));
}

TEST(diff_opaque_dir)
{
	if (geteuid() != 0)
		SKIP("needs root for trusted xattrs");
	std::string d = fresh("opaque"), lo = d + "/lower", up = d + "/upper";
	sh("mkdir -p " + lo + "/dir " + up + "/dir");
	put(lo + "/dir/old", "o");
	put(up + "/dir/fresh", "f");
	if (lsetxattr((up + "/dir").c_str(), "trusted.overlay.opaque", "y", 1, 0) != 0)
		SKIP("this filesystem refuses trusted.overlay xattrs");
	auto v = diff_overlay(up, lo, "/");
	CHECK(find(v, Kind::Deleted, "/dir/old"));
	CHECK(find(v, Kind::Added, "/dir/fresh"));
}

TEST(diff_shown_prefix)
{
	std::string d = fresh("prefix"), lo = d + "/lower", up = d + "/upper";
	sh("mkdir -p " + lo + " " + up);
	put(up + "/notes.txt", "n");
	auto v = diff_overlay(up, lo, "/home/dev");
	CHECK(find(v, Kind::Added, "/home/dev/notes.txt"));
}

TEST(diff_bind_mounted_file)
{
	std::string d = fresh("file");
	put(d + "/orig", "127.0.0.1 localhost\n");
	put(d + "/copy", "127.0.0.1 localhost\n10.0.0.1 evil\n");
	Change c;
	CHECK(diff_file(d + "/orig", d + "/copy", "/etc/hosts", c));
	CHECK(c.kind == Kind::Modified && c.path == "/etc/hosts" && c.delta > 0);
	put(d + "/copy", "127.0.0.1 localhost\n");
	CHECK(!diff_file(d + "/orig", d + "/copy", "/etc/hosts", c));
}

// ---- overlay diff on a real overlayfs mount -----------------------------------

TEST(diff_real_overlay)
{
	if (geteuid() != 0)
		SKIP("needs root to mount");
	std::string d = fresh("real"), lo = d + "/lower", up = d + "/upper", wk = d + "/work", mg = d + "/merged";
	sh("mkdir -p " + lo + "/project/src " + lo + "/logs " + lo + "/cfg " + up + " " + wk + " " + mg);
	put(lo + "/project/src/main.c", "int main(){return 0;}\n");
	put(lo + "/project/README", "readme\n");
	put(lo + "/logs/a.log", std::string(1000, 'a'));
	put(lo + "/cfg/app.conf", "debug=false\nport=80\n");
	put(lo + "/cfg/tiny.conf", std::string(400, 'z'));
	put(lo + "/moveme.txt", "i will move\n");
	std::string opts = "lowerdir=" + lo + ",upperdir=" + up + ",workdir=" + wk;
	if (mount("overlay", mg.c_str(), "overlay", 0, opts.c_str()) != 0)
		SKIP("overlay mount failed (needs a privileged container)");

	// Everything below happens through the overlay; the lower layer must stay intact.
	sh("cd " + mg + " && rm -rf logs && mkdir -p build/out && echo bin > build/out/app"
	   " && sed -i s/false/true/ cfg/app.conf && printf z >> cfg/tiny.conf"
	   " && mv moveme.txt moved.txt && mv project project2");
	auto v = diff_overlay(up, lo, "/");
	umount(mg.c_str());
	pair_moves(v);
	rank(v);

	auto has = [&](Kind k, const char *p) { return find(v, k, p) != nullptr; };
	CHECK(has(Kind::Deleted, "/logs"));
	CHECK(has(Kind::Deleted, "/logs/a.log"));
	CHECK(has(Kind::Added, "/build"));
	CHECK(has(Kind::Added, "/build/out/app"));
	CHECK(has(Kind::Modified, "/cfg/app.conf"));
	CHECK(has(Kind::Modified, "/cfg/tiny.conf"));
	auto mf = find(v, Kind::Moved, "/moved.txt");
	CHECK(mf && mf->from == "/moveme.txt");
	auto md = find(v, Kind::Moved, "/project2");
	CHECK(md && md->is_dir && md->from == "/project");
	CHECK(!has(Kind::Added, "/project2/README"));  // collapsed into the directory move

	// app.conf changed a larger share of its bits than tiny.conf, so ranks above it
	auto pos = [&](const char *p) {
		for (size_t i = 0; i < v.size(); i++)
			if (v[i].path == p)
				return i;
		return v.size();
	};
	CHECK(pos("/cfg/app.conf") < pos("/cfg/tiny.conf"));
	CHECK(v[0].is_dir);  // directories lead the summary

	// the lower layer, i.e. the "real" filesystem, is untouched
	struct stat st;
	CHECK(stat((lo + "/logs/a.log").c_str(), &st) == 0);
	CHECK(stat((lo + "/moveme.txt").c_str(), &st) == 0);
	CHECK(stat((lo + "/build").c_str(), &st) != 0);
}

// ---- review queue -------------------------------------------------------------

Review sample()
{
	Review r;
	r.command = "rm -rf build";
	r.user = "dev";
	r.summary_json = "{\"counts\":{}}";
	r.full_json = "{\"changes\":[]}";
	return r;
}

TEST(review_approve)
{
	ReviewQueue q;
	std::string id = q.submit(sample(), std::chrono::seconds(5));
	CHECK_EQ(q.pending().size(), 1u);
	std::thread t([&] { CHECK(q.answer(id, true, "alice")); });
	CHECK(q.wait(id));
	t.join();
	CHECK(q.get(id)->state == ReviewState::Approved);
	CHECK_EQ(q.get(id)->answered_by, "alice");
	CHECK(!q.answer(id, false, "bob"));  // first answer wins
	CHECK_EQ(q.pending().size(), 0u);
}

TEST(review_deny)
{
	ReviewQueue q;
	std::string id = q.submit(sample(), std::chrono::seconds(5));
	q.answer(id, false, "x");
	CHECK(!q.wait(id));
	CHECK(q.get(id)->state == ReviewState::Denied);
}

TEST(review_timeout_stays_open)
{
	ReviewQueue q;
	std::string id = q.submit(sample(), std::chrono::milliseconds(50));
	CHECK(!q.wait(id));  // blocks the exec
	CHECK(q.get(id)->state == ReviewState::TimedOut);
	CHECK_EQ(q.pending().size(), 1u);  // still awaiting a human
	// A person can still come back and reject it after the timeout.
	CHECK(q.answer(id, false, "late"));
	CHECK(q.get(id)->state == ReviewState::Denied);
	CHECK(!q.answer(id, true, "later"));  // now final; first answer won
}

TEST(review_timeout_then_resolve_runs_callback)
{
	ReviewQueue q;
	Review r = sample();
	int calls = 0;
	bool saw_approve = true;
	r.on_resolve = [&](bool approve) {
		calls++;
		saw_approve = approve;
		return std::string("{\"enabled\":true}");
	};
	std::string id = q.submit(r, std::chrono::milliseconds(50));
	CHECK(!q.wait(id));                 // times out, callback NOT run (no human decision)
	CHECK_EQ(calls, 0);
	CHECK(q.answer(id, false, "ops"));  // human rejects after the timeout -> callback runs
	CHECK_EQ(calls, 1);
	CHECK(!saw_approve);                // a denial
	CHECK(q.get(id)->enforcement == "{\"enabled\":true}");
}

TEST(review_protocol)
{
	ReviewQueue q;
	std::vector<std::string> events;
	q.listen([&](const std::string &l) { events.push_back(l); });
	std::string id = q.submit(sample(), std::chrono::seconds(5));
	CHECK(q.handle("LIST").find("\"id\":\"" + id + "\"") != std::string::npos);
	CHECK(q.handle("GET " + id).find("\"summary\"") != std::string::npos);
	CHECK(q.handle("FULL " + id).find("\"report\"") != std::string::npos);
	CHECK(q.handle("GET nope").find("\"ok\":false") != std::string::npos);
	CHECK(q.handle("BOGUS").find("\"ok\":false") != std::string::npos);
	CHECK(q.handle("APPROVE " + id + " ui user").find("\"approved\"") != std::string::npos);
	CHECK_EQ(q.get(id)->answered_by, "ui user");
	CHECK(q.handle("DENY " + id).find("\"ok\":false") != std::string::npos);
	CHECK_EQ(events.size(), 2u);
	CHECK(events[0].find("\"event\":\"new\"") != std::string::npos);
	CHECK(events[1].find("\"event\":\"resolved\"") != std::string::npos);
}

TEST(review_socket)
{
	static ReviewQueue q;  // the server's threads outlive this test
	std::string path = g_root + "/review.sock";
	serve_reviews(q, path);
	int s = socket(AF_UNIX, SOCK_STREAM, 0);
	sockaddr_un sa{};
	sa.sun_family = AF_UNIX;
	strcpy(sa.sun_path, path.c_str());
	CHECK(connect(s, (sockaddr *)&sa, sizeof(sa)) == 0);
	auto line = [&] {
		std::string l;
		char c;
		while (recv(s, &c, 1, 0) == 1 && c != '\n')
			l += c;
		return l;
	};
	auto say = [&](const std::string &m) { send(s, (m + "\n").data(), m.size() + 1, 0); };
	say("WATCH");
	CHECK(line().find("watching") != std::string::npos);
	std::string id;
	std::thread waiter([&] {
		id = q.submit(sample(), std::chrono::seconds(5));
		CHECK(q.wait(id));
	});
	std::string pushed = line();  // the "new" event arrives without asking
	CHECK(pushed.find("\"event\":\"new\"") != std::string::npos);
	size_t at = pushed.find("\"id\":\"") + 6;
	std::string got = pushed.substr(at, pushed.find('"', at) - at);
	say("APPROVE " + got);
	std::string a = line(), b = line();  // the reply and the "resolved" push, in either order
	CHECK((a + b).find("\"approved\"") != std::string::npos);
	waiter.join();
	CHECK_EQ(got, id);
	close(s);
}

// ---- the JEV model's output format ----------------------------------------------

TEST(jev_parse_documented_example)
{
	JevResult r;
	std::string err;
	CHECK(parse_jev_json(R"({
  "choice": "allow",
  "probabilities": {
    "allow": 0.97,
    "hold": 0.02,
    "block": 0.01
  }
})", r, &err));
	CHECK(r.choice == JevChoice::Allow);
	CHECK(r.has_probabilities);
	CHECK_EQ(r.p_allow, 0.97);
	CHECK_EQ(r.p_hold, 0.02);
	CHECK_EQ(r.p_block, 0.01);
}

TEST(jev_parse_choices)
{
	JevResult r;
	CHECK(parse_jev_json(R"({"choice":"hold","probabilities":{"allow":0.3,"hold":0.6,"block":0.1}})", r));
	CHECK(r.choice == JevChoice::Hold);
	CHECK(parse_jev_json(R"({"probabilities":{"block":0.9,"hold":0.05,"allow":0.05},"choice":"block"})", r));
	CHECK(r.choice == JevChoice::Block);  // key order doesn't matter
	CHECK(parse_jev_json(R"({"choice":"allow"})", r));
	CHECK(!r.has_probabilities);  // probabilities are optional
	CHECK(parse_jev_json(R"({"choice":"hold","reason":"rare for this user","extra":{"x":true}})", r));
	CHECK_EQ(r.reason, "rare for this user");  // unknown fields are ignored
}

TEST(jev_parse_rejects_malformed)
{
	JevResult r;
	std::string err;
	CHECK(!parse_jev_json("", r, &err));
	CHECK(!parse_jev_json(R"({"probabilities":{"allow":1,"hold":0,"block":0}})", r, &err));
	CHECK(err.find("choice") != std::string::npos);
	CHECK(!parse_jev_json(R"({"choice":"maybe"})", r, &err));
	CHECK(!parse_jev_json(R"({"choice":"allow","probabilities":{"allow":1.5,"hold":0,"block":0}})", r, &err));
	CHECK(!parse_jev_json(R"({"choice":"allow","probabilities":{"allow":0.5,"hold":0.1,"block":0.1}})", r, &err));
	CHECK(err.find("sum") != std::string::npos);
	CHECK(!parse_jev_json(R"({"choice":"allow","probabilities":{"allow":1}})", r, &err));
	CHECK(!parse_jev_json(R"({"choice":"allow"} trailing)", r, &err));
	CHECK(!parse_jev_json(R"({"choice":"allow")", r, &err));
}

TEST(jev_unreadable_output_asks_a_person)
{
	for (const char *bad : {"", "not json", R"({"choice":"maybe"})", R"({"choice":"allow","probabilities":{"allow":2}})"}) {
		JevResult r = read_jev_output(bad);
		CHECK(r.choice == JevChoice::Hold);
		CHECK(r.reason.find("unreadable") != std::string::npos);
	}
	CHECK(read_jev_output(R"({"choice":"block"})").choice == JevChoice::Block);
}

TEST(jev_stub_output_is_valid)
{
	std::string err;
	JevResult r;
	CHECK(parse_jev_json(jev_classify(Event{}), r, &err));
	CHECK(r.choice == JevChoice::Allow);  // no model linked: behave as before
}

TEST(jev_round_trip)
{
	JevResult a, b;
	CHECK(parse_jev_json(R"({"choice":"hold","probabilities":{"allow":0.4,"hold":0.45,"block":0.15}})", a));
	CHECK(parse_jev_json(jev_json(a), b));
	CHECK(b.choice == JevChoice::Hold && b.p_hold == 0.45 && b.p_block == 0.15);
}

// ---- the unsure path, with a fake simulation and a fake front end ---------------

Event unsure_event()
{
	Event ev;
	ev.id = "ev1";
	ev.argv = {"rm", "-rf", "build"};
	ev.user = "dev";
	ev.origin_type = "ssh";
	return ev;
}

Simulation fake_sim(const Event &, const ProgressFn &progress)
{
	if (progress)
		progress("{\"counts\":{\"deleted\":1},\"finished\":false}");  // a live snapshot
	Simulation s;
	s.ok = true;
	s.summary_json = "{\"counts\":{\"deleted\":3}}";
	s.full_json = "{\"changes\":[]}";
	s.outcome = "completed";
	return s;
}

// Answers the first review that shows up, the way a front end would.
void answer_when_seen(ReviewQueue &q, bool approve, std::string *seen_reason = nullptr)
{
	for (int i = 0; i < 400; i++) {
		auto p = q.pending();
		if (!p.empty()) {
			if (seen_reason)
				*seen_reason = p[0].reason;
			q.answer(p[0].id, approve, "tester");
			return;
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(5));
	}
}

Simulation crashed_sim(const Event &, const ProgressFn &)
{
	Simulation s;
	s.ok = true;  // the simulation ran fine; the command inside it crashed
	s.summary_json = "{\"outcome\":\"crashed\",\"exit_code\":139}";
	s.full_json = "{\"changes\":[]}";
	s.outcome = "crashed";
	return s;
}

TEST(unsure_forwards_result_on_success)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	Explorer ok = [](const Event &, const ProgressFn &) {
		Simulation s;
		s.ok = true;
		s.summary_json = "{\"outcome\":\"completed\",\"exit_code\":0,\"success\":true}";
		s.full_json = "{\"output\":\"hello\\n\"}";
		s.outcome = "completed";
		s.exit_code = 0;
		s.output = "hello\n";
		s.succeeded = true;
		return s;
	};
	std::thread ui([&] { answer_when_seen(q, true); });
	Decision d = handle_unsure(unsure_event(), j, q, ok, std::chrono::seconds(5), nullptr, nullptr);
	ui.join();
	CHECK(d.verdict == Verdict::Allow);
	CHECK(d.has_result && d.result_success && d.result_exit == 0);
	CHECK_EQ(d.result_output, "hello\n");  // carried forward to reuse on approval
}

TEST(unsure_crash_still_asks_the_user)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	std::thread ui([&] { answer_when_seen(q, true); });  // the user looks at it and approves
	Decision d = handle_unsure(unsure_event(), j, q, crashed_sim, std::chrono::seconds(5), nullptr, nullptr);
	ui.join();
	CHECK(d.verdict == Verdict::Allow);  // a crash is not an auto-rejection
	CHECK(q.get("r1")->reason.find("crashed") != std::string::npos);
}

TEST(unsure_approved_allows)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	j.reason = "rare command for this user";
	std::chrono::milliseconds extended{0};
	std::thread ui([&] { answer_when_seen(q, true); });
	Decision d = handle_unsure(unsure_event(), j, q, fake_sim, std::chrono::seconds(5),
				   [&](std::chrono::milliseconds m) { extended = std::max(extended, m); }, nullptr);
	ui.join();
	CHECK(d.verdict == Verdict::Allow);
	CHECK(d.explored);
	CHECK(d.effects.find("\"deleted\":3") != std::string::npos);
	CHECK(d.reason.find("approved by tester") != std::string::npos);
	CHECK(extended >= std::chrono::seconds(5));  // the daemon was told to wait for the person
}

TEST(unsure_denied_blocks)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	std::thread ui([&] { answer_when_seen(q, false); });
	Decision d = handle_unsure(unsure_event(), j, q, fake_sim, std::chrono::seconds(5), nullptr, nullptr);
	ui.join();
	CHECK(d.verdict == Verdict::Block);
}

TEST(unsure_no_answer_blocks)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	Decision d = handle_unsure(unsure_event(), j, q, fake_sim, std::chrono::milliseconds(50), nullptr, nullptr);
	CHECK(d.verdict == Verdict::Block);
	CHECK(d.reason.find("timed_out") != std::string::npos);
}

TEST(unsure_reject_after_timeout_severs)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	std::string severed_for;
	Enforcer on_deny = [&](const Event &ev, const std::string &) {
		severed_for = ev.user;
		return std::string("{\"enabled\":true}");
	};
	// No one answers in time: the exec is blocked, review left open, nothing severed.
	Decision d = handle_unsure(unsure_event(), j, q, fake_sim, std::chrono::milliseconds(50), nullptr, on_deny);
	CHECK(d.verdict == Verdict::Block);
	CHECK(severed_for.empty());  // a bare timeout is not a verdict
	// The person comes back after the timeout and rejects it -> now it severs.
	CHECK(q.answer("r1", false, "ops"));
	CHECK_EQ(severed_for, "dev");
}

TEST(unsure_failed_simulation_still_asks)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	std::thread ui([&] { answer_when_seen(q, false); });
	Explorer broken = [](const Event &, const ProgressFn &) {
		Simulation s;
		s.error = "cannot start sid-explore";
		s.outcome = "error";
		return s;
	};
	Decision d = handle_unsure(unsure_event(), j, q, broken, std::chrono::seconds(5), nullptr, nullptr);
	ui.join();
	CHECK(d.verdict == Verdict::Block);  // still asked a person, who denied it
	CHECK(q.get("r1")->reason.find("could not simulate") != std::string::npos);
}

TEST(unsure_network_attempt_reported)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	Explorer tried_net = [](const Event &, const ProgressFn &) {
		Simulation s;
		s.ok = true;
		s.summary_json = R"({"outcome":"network","network":[{"destination":"93.184.215.14:443"}]})";
		s.full_json = "{}";
		s.outcome = "network";
		return s;
	};
	std::string note;
	std::thread ui([&] { answer_when_seen(q, true); });  // the user accepts it anyway, at their peril
	Decision d = handle_unsure(unsure_event(), j, q, tried_net, std::chrono::seconds(5), nullptr, nullptr);
	ui.join();
	CHECK(d.verdict == Verdict::Allow);
	CHECK(d.reason.find("network") != std::string::npos);
	CHECK(q.get("r1")->reason.find("another machine") != std::string::npos);
}

// ---- origin and enforcement -----------------------------------------------------

Event ssh_event()
{
	Event ev;
	ev.id = "e";
	ev.argv = {"rm", "-rf", "/etc"};
	ev.user = "dev";
	ev.uid = 1000;
	ev.pid = 5000;
	ev.file = "/usr/bin/rm";
	ev.via_ssh = true;
	ev.origin_type = "ssh";
	ev.parent_chain = {{5000, "/usr/bin/rm"}, {4000, "/usr/bin/bash"}, {3000, "/usr/sbin/sshd"}, {800, "/usr/sbin/sshd"}, {1, "/sbin/init"}};
	return ev;
}

TEST(plan_ssh_severs_connection)
{
	auto plan = plan_enforcement(ssh_event());
	// closest sshd is the session one (pid 3000), not the master (800)
	bool severed = false, cmd = false;
	for (auto &t : plan) {
		if (t.action == "sever-remote") {
			severed = true;
			CHECK_EQ(t.pid, 3000);
		}
		if (t.action == "kill-command")
			cmd = (t.pid == 5000);
	}
	CHECK(severed);
	CHECK(cmd);
}

TEST(plan_local_shell_and_agent)
{
	Event local;
	local.pid = 200;
	local.uid = 1000;
	local.origin_type = "local";
	local.parent_chain = {{200, "/bin/cat"}, {150, "/usr/bin/bash"}, {1, "/sbin/init"}};
	bool kick = false;
	for (auto &t : plan_enforcement(local))
		if (t.action == "kick-shell")
			kick = (t.pid == 150);
	CHECK(kick);

	Event agent;
	agent.pid = 77;
	agent.origin_type = "agent";
	agent.origin_detail = "claude";
	agent.parent_chain = {{77, "/usr/bin/python3"}, {66, "/usr/local/bin/claude"}, {1, "/sbin/init"}};
	bool killed = false;
	for (auto &t : plan_enforcement(agent))
		if (t.action == "kill-agent")
			killed = (t.pid == 66);
	CHECK(killed);
}

TEST(carry_out_respects_guards)
{
	std::vector<Target> plan = {{"sever-remote", 3000, "/usr/sbin/sshd"}, {"kill-command", 5000, "/usr/bin/rm"},
				    {"kill-command", 1, "/sbin/init"}};
	std::vector<int> killed;
	Killer k = [&](int pid) {
		killed.push_back(pid);
		return true;
	};
	Protected prot = [](int pid) { return pid == 3000; };  // pretend 3000 is the daemon's ancestor
	std::string j = carry_out(plan, k, prot);
	CHECK(killed.size() == 1u && killed[0] == 5000);  // 3000 protected, 1 is pid<=1
	CHECK(j.find("\"pid\":3000,\"exe\":\"/usr/sbin/sshd\",\"protected\":true,\"killed\":false") != std::string::npos);
	CHECK(j.find("\"pid\":5000,\"exe\":\"/usr/bin/rm\",\"protected\":false,\"killed\":true") != std::string::npos);
}

TEST(origin_description_and_json)
{
	Event ev = ssh_event();
	CHECK(origin_description(ev).find("remote SSH session") != std::string::npos);
	CHECK(origin_description(ev).find("sshd (pid 3000)") != std::string::npos);
	std::string j = origin_json(ev);
	CHECK(j.find("\"type\":\"ssh\"") != std::string::npos);
	CHECK(j.find("\"sever\":[") != std::string::npos);
	CHECK(j.find("\"action\":\"sever-remote\",\"pid\":3000") != std::string::npos);
	CHECK(j.find("\"parents\":[") != std::string::npos);
}

TEST(model_allow_runs_without_severing)
{
	JevResult j;
	parse_jev_json(R"({"choice":"allow","probabilities":{"allow":0.97,"hold":0.02,"block":0.01}})", j);
	bool enforced = false;
	Enforcer on_deny = [&](const Event &, const std::string &) {
		enforced = true;
		return std::string("{}");
	};
	Decision d = decide_certain(ssh_event(), j, on_deny);
	CHECK(d.verdict == Verdict::Allow);
	CHECK(!enforced);
	CHECK(d.has_score && d.score == 0.01);
}

TEST(model_block_severs_like_a_denial)
{
	JevResult j;
	parse_jev_json(R"({"choice":"block","probabilities":{"allow":0.01,"hold":0.04,"block":0.95}})", j);
	std::string severed_for;
	Enforcer on_deny = [&](const Event &ev, const std::string &) {
		severed_for = ev.user;
		return std::string("{\"enabled\":true,\"actions\":[]}");
	};
	Decision d = decide_certain(ssh_event(), j, on_deny);
	CHECK(d.verdict == Verdict::Block);
	CHECK_EQ(severed_for, "dev");  // same consequence as a human denial
	CHECK(d.reason.find("enforced") != std::string::npos);
	CHECK(d.score == 0.95);
}

TEST(unsure_denied_enforces_origin)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	std::string severed_for;
	Enforcer on_deny = [&](const Event &ev, const std::string &) {
		severed_for = ev.user;
		return std::string("{\"enabled\":true,\"actions\":[]}");
	};
	std::thread ui([&] { answer_when_seen(q, false); });
	Decision d = handle_unsure(ssh_event(), j, q, fake_sim, std::chrono::seconds(5), nullptr, on_deny);
	ui.join();
	CHECK(d.verdict == Verdict::Block);
	CHECK_EQ(severed_for, "dev");  // enforcement ran, with the denied command's event
	CHECK(q.get("r1")->enforcement.find("\"enabled\":true") != std::string::npos);  // recorded on the review
}

TEST(unsure_approved_does_not_enforce)
{
	ReviewQueue q;
	JevResult j;
	j.choice = JevChoice::Hold;
	bool enforced = false;
	Enforcer on_deny = [&](const Event &, const std::string &) {
		enforced = true;
		return std::string("{}");
	};
	std::thread ui([&] { answer_when_seen(q, true); });
	Decision d = handle_unsure(ssh_event(), j, q, fake_sim, std::chrono::seconds(5), nullptr, on_deny);
	ui.join();
	CHECK(d.verdict == Verdict::Allow);
	CHECK(!enforced);  // an approved command is never severed
}

TEST(review_carries_model_output)
{
	ReviewQueue q;
	JevResult j;
	parse_jev_json(R"({"choice":"hold","probabilities":{"allow":0.4,"hold":0.45,"block":0.15}})", j);
	std::thread ui([&] { answer_when_seen(q, false); });
	handle_unsure(unsure_event(), j, q, fake_sim, std::chrono::seconds(5), nullptr, nullptr);
	ui.join();
	std::string listed = review_summary_json(*q.get("r1"));
	CHECK(listed.find("\"model\":{\"choice\":\"hold\",\"probabilities\":{\"allow\":0.4,\"hold\":0.45,\"block\":0.15}}") !=
	      std::string::npos);
}

}  // namespace

int main(int argc, char **argv)
{
	const char *base = getenv("TEST_TMP");
	g_root = std::string(base ? base : "/tmp") + "/sid-test-" + std::to_string(getpid());
	sh("mkdir -p " + g_root);
	for (auto &t : tests()) {
		if (argc > 1 && !strstr(t.first, argv[1]))
			continue;
		g_cur = t.first;
		int before = g_fail;
		t.second();
		fprintf(stderr, "%s %s\n", g_fail == before ? "ok  " : "FAIL", t.first);
	}
	sh("rm -rf " + g_root);
	fprintf(stderr, "\n%d checks passed, %d failed, %d tests skipped\n", g_pass, g_fail, g_skip);
	return g_fail ? 1 : 0;
}
