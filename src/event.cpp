#include "event.hpp"

#include <cstdio>

namespace {

std::string esc(const std::string &s)
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
				o += (char)c;  // non-ASCII bytes pass through; invalid UTF-8 is the log reader's problem
		}
	}
	return o + "\"";
}

std::string num(double v)
{
	char b[32];
	snprintf(b, sizeof(b), "%.6g", v);
	return b;
}

struct J {
	std::string s = "{";
	bool first = true;
	void key(const char *k)
	{
		if (!first) s += ",";
		first = false;
		s += esc(k) + ":";
	}
	void str(const char *k, const std::string &v) { key(k); s += esc(v); }
	void raw(const char *k, const std::string &v) { key(k); s += v; }
	void arr(const char *k, const std::vector<std::string> &v)
	{
		key(k);
		s += "[";
		for (size_t i = 0; i < v.size(); i++) s += (i ? "," : "") + esc(v[i]);
		s += "]";
	}
};

}  // namespace

std::string Event::to_json() const
{
	J j;
	j.str("id", id);
	j.str("time", time);
	j.str("syscall", syscall);
	j.str("role", role);
	j.raw("tid", std::to_string(tid));
	j.raw("pid", std::to_string(pid));
	j.raw("ppid", std::to_string(ppid));
	j.raw("uid", std::to_string(uid));
	j.raw("gid", std::to_string(gid));
	std::string g = "[";
	for (size_t i = 0; i < groups.size(); i++) g += (i ? "," : "") + std::to_string(groups[i]);
	j.raw("groups", g + "]");
	j.str("user", user);
	j.str("cwd", cwd);
	j.str("path", path);
	j.str("file", file);
	j.arr("argv", argv);
	j.raw("truncated", truncated ? "true" : "false");
	if (!note.empty()) j.str("note", note);
	j.raw("inode", std::to_string(inode));
	j.raw("size", std::to_string(size));
	j.raw("mtime", num(mtime));
	j.str("sha256", sha256);
	j.raw("is_new", is_new ? "true" : "false");
	std::string o = "{\"type\":" + esc(origin_type);
	if (!origin_detail.empty()) o += ",\"detail\":" + esc(origin_detail);
	j.raw("origin", o + "}");
	j.raw("via_ssh", via_ssh ? "true" : "false");
	if (!service.empty()) j.str("service", service);
	j.raw("sessionid", std::to_string(sessionid));
	std::string pc = "[";
	for (size_t i = 0; i < parent_chain.size(); i++)
		pc += (i ? "," : "") + std::string("{\"pid\":") + std::to_string(parent_chain[i].pid) +
		      ",\"exe\":" + esc(parent_chain[i].exe) + "}";
	j.raw("parent_chain", pc + "]");
	j.str("stdin", stdin_link);
	if (feeder_pid > 0)
		j.raw("stdin_feeder", "{\"pid\":" + std::to_string(feeder_pid) + ",\"exe\":" + esc(feeder_exe) +
					  ",\"cmdline\":" + esc(feeder_cmdline) + "}");
	if (has_script) j.str("script", script);
	j.arr("recent", recent);
	j.str("normalized", normalized);
	j.str("verdict", verdict);
	j.str("decided_by", decided_by);
	j.str("reason", reason);
	j.raw("model", model_json.empty() ? "null" : model_json);
	j.raw("score", has_score ? num(score) : "null");
	j.raw("explored", explored ? "true" : "false");
	j.raw("effects", effects.empty() ? "null" : effects);
	if (has_result)
		j.raw("result", "{\"exit_code\":" + std::to_string(result_exit) + ",\"success\":" +
				    (result_success ? "true" : "false") + ",\"output\":" + esc(result_output) + "}");
	else
		j.raw("result", "null");
	j.raw("score_after", "null");
	if (!attack_id.empty()) j.str("attack_id", attack_id);
	j.raw("latency_ms", num(latency_ms));
	return j.s + "}";
}
