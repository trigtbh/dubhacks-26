#include "review.hpp"

#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <thread>

#include "changes.hpp"

namespace {

long long epoch_ms(std::chrono::system_clock::time_point t)
{
	return std::chrono::duration_cast<std::chrono::milliseconds>(t.time_since_epoch()).count();
}

std::string meta_json(const Review &r)
{
	return "\"id\":" + json_str(r.id) + ",\"event_id\":" + json_str(r.event_id) + ",\"command\":" + json_str(r.command) +
	       ",\"user\":" + json_str(r.user) + ",\"origin\":" + json_str(r.origin) + ",\"origin_info\":" + r.origin_json +
	       ",\"reason\":" + json_str(r.reason) + ",\"model\":" + r.model_json +
	       ",\"enforcement\":" + r.enforcement +
	       ",\"state\":" + json_str(state_name(r.state)) + ",\"answered_by\":" + json_str(r.answered_by) +
	       ",\"created_ms\":" + std::to_string(epoch_ms(r.created)) + ",\"expires_ms\":" + std::to_string(epoch_ms(r.expires));
}

std::string err(const std::string &m) { return "{\"ok\":false,\"error\":" + json_str(m) + "}"; }

bool send_all(int fd, const std::string &s)
{
	size_t off = 0;
	while (off < s.size()) {
		ssize_t n = send(fd, s.data() + off, s.size() - off, MSG_NOSIGNAL);
		if (n <= 0)
			return false;
		off += n;
	}
	return true;
}

// Replies and WATCH pushes share the socket. Shared, because a push copied out
// of the listener list may still arrive after the client has gone.
struct Conn {
	std::mutex mu;
	int fd;
	bool open = true;
	void send(const std::string &s)
	{
		std::lock_guard<std::mutex> g(mu);
		if (open)
			send_all(fd, s);
	}
};

void client(ReviewQueue *q, int fd)
{
	std::string buf;
	char chunk[4096];
	int token = 0;
	auto conn = std::make_shared<Conn>();
	conn->fd = fd;
	for (;;) {
		ssize_t n = recv(fd, chunk, sizeof(chunk), 0);
		if (n <= 0)
			break;
		buf.append(chunk, n);
		size_t eol;
		while ((eol = buf.find('\n')) != std::string::npos) {
			std::string line = buf.substr(0, eol);
			buf.erase(0, eol + 1);
			if (!line.empty() && line.back() == '\r')
				line.pop_back();
			std::string reply;
			if (line == "WATCH") {
				if (!token)
					token = q->listen([conn](const std::string &l) { conn->send(l + "\n"); });
				reply = "{\"ok\":true,\"watching\":true}";
			} else
				reply = q->handle(line);
			conn->send(reply + "\n");
		}
	}
	if (token)
		q->unlisten(token);
	std::lock_guard<std::mutex> g(conn->mu);
	conn->open = false;
	close(fd);
}

}  // namespace

std::string review_summary_json(const Review &r) { return "{" + meta_json(r) + ",\"summary\":" + r.summary_json + "}"; }
std::string review_full_json(const Review &r) { return "{" + meta_json(r) + ",\"report\":" + r.full_json + "}"; }

// Drop reviews that are final (or timed out) and past their retention. Callers
// hold mu_. A TimedOut review is kept well past its deadline so a human can still
// come back and reject it; once dropped, it was simply never answered.
void ReviewQueue::prune_locked()
{
	auto now = std::chrono::system_clock::now();
	auto retain = std::chrono::minutes(10);
	for (auto it = reviews_.begin(); it != reviews_.end();) {
		bool stale = it->second.state != ReviewState::Pending && it->second.expires + retain < now;
		it = stale ? reviews_.erase(it) : std::next(it);
	}
}

std::string ReviewQueue::submit(Review r, std::chrono::milliseconds ttl)
{
	std::string line;
	{
		std::lock_guard<std::mutex> g(mu_);
		prune_locked();
		if (r.id.empty())
			r.id = "r" + std::to_string(next_id_++);
		r.state = ReviewState::Pending;
		r.created = std::chrono::system_clock::now();
		r.expires = r.created + ttl;
		reviews_[r.id] = r;
		line = "{\"event\":\"new\",\"review\":" + review_summary_json(r) + "}";
	}
	announce(line);
	return r.id;
}

bool ReviewQueue::progress(const std::string &id, const std::string &summary_json)
{
	std::string line;
	{
		std::lock_guard<std::mutex> g(mu_);
		auto it = reviews_.find(id);
		if (it == reviews_.end() || it->second.state != ReviewState::Pending)
			return false;
		it->second.summary_json = summary_json;
		line = "{\"event\":\"progress\",\"id\":" + json_str(id) + ",\"summary\":" + summary_json + "}";
	}
	announce(line);
	return true;
}

bool ReviewQueue::finalize(const std::string &id, const std::string &summary_json, const std::string &full_json,
			   const std::string &reason)
{
	std::string line;
	{
		std::lock_guard<std::mutex> g(mu_);
		auto it = reviews_.find(id);
		if (it == reviews_.end())
			return false;
		it->second.summary_json = summary_json;
		it->second.full_json = full_json;
		it->second.reason = reason;
		line = "{\"event\":\"updated\",\"review\":" + review_summary_json(it->second) + "}";
	}
	announce(line);
	return true;
}

void ReviewQueue::finish_locked(Review &r, ReviewState s, const std::string &by)
{
	r.state = s;
	r.answered_by = by;
	cv_.notify_all();
}

bool ReviewQueue::answer(const std::string &id, bool approve, const std::string &by)
{
	std::function<std::string(bool)> on_resolve;
	{
		std::lock_guard<std::mutex> g(mu_);
		auto it = reviews_.find(id);
		if (it == reviews_.end() || !is_open(it->second.state))  // answerable even after a timeout
			return false;
		finish_locked(it->second, approve ? ReviewState::Approved : ReviewState::Denied, by);
		on_resolve = it->second.on_resolve;
	}
	// Enforcement runs outside the lock (a denial severs real processes). It does
	// not race the first-answer check above: finish_locked already made the state
	// final, so a second answer() returns early and never reaches here.
	std::string enf = on_resolve ? on_resolve(approve) : std::string("null");
	std::string line;
	{
		std::lock_guard<std::mutex> g(mu_);
		auto it = reviews_.find(id);
		if (it != reviews_.end())
			it->second.enforcement = enf;
		line = "{\"event\":\"resolved\",\"id\":" + json_str(id) + ",\"state\":" + json_str(approve ? "approved" : "denied") +
		       ",\"enforcement\":" + enf + "}";
	}
	announce(line);
	return true;
}

bool ReviewQueue::wait(const std::string &id)
{
	std::unique_lock<std::mutex> lk(mu_);
	auto it = reviews_.find(id);
	if (it == reviews_.end())
		return false;
	auto deadline = it->second.expires;
	cv_.wait_until(lk, deadline, [&] { return it->second.state != ReviewState::Pending; });
	bool timed_out = false;
	if (it->second.state == ReviewState::Pending) {
		// No human in time: block the exec, but leave the review open so a person
		// can still reject it (severing) or approve it afterward. No sever here.
		it->second.state = ReviewState::TimedOut;
		timed_out = true;
	}
	bool ok = it->second.state == ReviewState::Approved;
	prune_locked();
	lk.unlock();
	if (timed_out)
		announce("{\"event\":\"timed_out\",\"id\":" + json_str(id) + "}");
	return ok;
}

std::vector<Review> ReviewQueue::pending() const
{
	std::lock_guard<std::mutex> g(mu_);
	std::vector<Review> out;
	for (auto &kv : reviews_)
		if (is_open(kv.second.state))
			out.push_back(kv.second);
	return out;
}

std::optional<Review> ReviewQueue::get(const std::string &id) const
{
	std::lock_guard<std::mutex> g(mu_);
	auto it = reviews_.find(id);
	if (it == reviews_.end())
		return std::nullopt;
	return it->second;
}

int ReviewQueue::listen(Listener l)
{
	std::lock_guard<std::mutex> g(mu_);
	listeners_[next_token_] = std::move(l);
	return next_token_++;
}

void ReviewQueue::unlisten(int token)
{
	std::lock_guard<std::mutex> g(mu_);
	listeners_.erase(token);
}

void ReviewQueue::announce(const std::string &line)
{
	std::map<int, Listener> ls;
	{
		std::lock_guard<std::mutex> g(mu_);
		ls = listeners_;
	}
	for (auto &kv : ls)
		kv.second(line);
}

std::string ReviewQueue::handle(const std::string &line)
{
	std::istringstream in(line);
	std::string cmd, id, by;
	in >> cmd >> id;
	std::getline(in >> std::ws, by);
	if (cmd == "LIST") {
		std::string s = "{\"ok\":true,\"reviews\":[";
		auto p = pending();
		for (size_t i = 0; i < p.size(); i++)
			s += (i ? "," : "") + review_summary_json(p[i]);
		return s + "]}";
	}
	if (cmd == "GET" || cmd == "FULL") {
		auto r = get(id);
		if (!r)
			return err("no such review: " + id);
		return "{\"ok\":true,\"review\":" + (cmd == "GET" ? review_summary_json(*r) : review_full_json(*r)) + "}";
	}
	if (cmd == "APPROVE" || cmd == "DENY") {
		if (!answer(id, cmd == "APPROVE", by.empty() ? "frontend" : by))
			return err("no pending review: " + id);
		return "{\"ok\":true,\"id\":" + json_str(id) + ",\"state\":" + json_str(cmd == "APPROVE" ? "approved" : "denied") + "}";
	}
	return err("unknown command; use LIST, GET <id>, FULL <id>, APPROVE <id>, DENY <id>, WATCH");
}

void serve_reviews(ReviewQueue &q, const std::string &sock_path)
{
	int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (s < 0)
		throw std::runtime_error(std::string("review socket: ") + strerror(errno));
	sockaddr_un sa{};
	sa.sun_family = AF_UNIX;
	if (sock_path.size() >= sizeof(sa.sun_path))
		throw std::runtime_error("review socket path too long");
	memcpy(sa.sun_path, sock_path.c_str(), sock_path.size() + 1);
	unlink(sock_path.c_str());
	if (bind(s, reinterpret_cast<sockaddr *>(&sa), sizeof(sa)) != 0 || listen(s, 16) != 0)
		throw std::runtime_error("cannot listen on " + sock_path + ": " + strerror(errno));
	chmod(sock_path.c_str(), 0600);  // root-only: whoever can connect can approve commands
	std::thread([&q, s] {
		for (;;) {
			int c = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
			if (c >= 0)
				std::thread(client, &q, c).detach();
		}
	}).detach();
}
