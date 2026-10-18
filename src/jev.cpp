#include "jev.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>

#include "changes.hpp"

namespace {

// Just enough JSON for the model's output: objects, strings, numbers, true/false/null.
// Nested objects are flattened into dotted keys ("probabilities.allow").
struct Parser {
	explicit Parser(const std::string &text) : s(text) {}
	const std::string &s;
	size_t i = 0;
	std::map<std::string, std::string> strings;
	std::map<std::string, double> numbers;
	std::string err;

	void ws()
	{
		while (i < s.size() && isspace((unsigned char)s[i]))
			i++;
	}
	bool fail(const std::string &m)
	{
		if (err.empty())
			err = m + " at offset " + std::to_string(i);
		return false;
	}
	bool lit(const char *w)
	{
		size_t n = strlen(w);
		if (s.compare(i, n, w) != 0)
			return fail(std::string("expected ") + w);
		i += n;
		return true;
	}
	bool str(std::string &out)
	{
		if (i >= s.size() || s[i] != '"')
			return fail("expected a string");
		for (i++; i < s.size() && s[i] != '"'; i++) {
			if (s[i] == '\\' && i + 1 < s.size()) {
				char c = s[++i];
				out += c == 'n' ? '\n' : c == 't' ? '\t' : c == 'r' ? '\r' : c;  // \uXXXX kept literally
			} else
				out += s[i];
		}
		if (i >= s.size())
			return fail("unterminated string");
		i++;
		return true;
	}
	bool value(const std::string &key)
	{
		ws();
		if (i >= s.size())
			return fail("unexpected end");
		char c = s[i];
		if (c == '{')
			return object(key + ".");
		if (c == '"') {
			std::string v;
			if (!str(v))
				return false;
			strings[key] = v;
			return true;
		}
		if (c == 't')
			return lit("true");
		if (c == 'f')
			return lit("false");
		if (c == 'n')
			return lit("null");
		if (c == '[')
			return fail("arrays are not expected here");
		const char *start = s.c_str() + i;
		char *end;
		double d = strtod(start, &end);
		if (end == start)
			return fail("expected a value");
		i += end - start;
		numbers[key] = d;
		return true;
	}
	bool object(const std::string &prefix)
	{
		ws();
		if (i >= s.size() || s[i] != '{')
			return fail("expected an object");
		i++;
		ws();
		if (i < s.size() && s[i] == '}') {
			i++;
			return true;
		}
		for (;;) {
			ws();
			std::string k;
			if (!str(k))
				return false;
			ws();
			if (i >= s.size() || s[i] != ':')
				return fail("expected ':'");
			i++;
			if (!value(prefix + k))
				return false;
			ws();
			if (i < s.size() && s[i] == ',') {
				i++;
				continue;
			}
			if (i < s.size() && s[i] == '}') {
				i++;
				return true;
			}
			return fail("expected ',' or '}'");
		}
	}
};

std::string num(double v)
{
	char b[32];
	snprintf(b, sizeof(b), "%.4g", v);
	return b;
}

}  // namespace

bool parse_jev_json(const std::string &json, JevResult &out, std::string *err)
{
	auto bad = [&](const std::string &m) {
		if (err)
			*err = m;
		return false;
	};
	Parser p{json};
	if (!p.object(""))
		return bad("malformed model output: " + p.err);
	p.ws();
	if (p.i != json.size())
		return bad("malformed model output: trailing characters");

	JevResult r;
	auto c = p.strings.find("choice");
	if (c == p.strings.end())
		return bad("model output has no \"choice\"");
	if (c->second == "allow")
		r.choice = JevChoice::Allow;
	else if (c->second == "hold")
		r.choice = JevChoice::Hold;
	else if (c->second == "block")
		r.choice = JevChoice::Block;
	else
		return bad("unknown choice \"" + c->second + "\"");

	const char *keys[] = {"probabilities.allow", "probabilities.hold", "probabilities.block"};
	double *dst[] = {&r.p_allow, &r.p_hold, &r.p_block};
	int found = 0;
	for (int k = 0; k < 3; k++) {
		auto it = p.numbers.find(keys[k]);
		if (it == p.numbers.end())
			continue;
		if (!(it->second >= 0 && it->second <= 1))
			return bad(std::string(keys[k]) + " is not in [0, 1]");
		*dst[k] = it->second;
		found++;
	}
	if (found != 0 && found != 3)
		return bad("probabilities need all of allow, hold and block");
	if (found == 3) {
		double sum = r.p_allow + r.p_hold + r.p_block;
		if (std::fabs(sum - 1) > 0.05)  // allows for rounding in the model's output
			return bad("probabilities sum to " + num(sum) + ", not 1");
		r.has_probabilities = true;
	}
	auto reason = p.strings.find("reason");
	if (reason != p.strings.end())
		r.reason = reason->second;
	out = r;
	return true;
}

JevResult read_jev_output(const std::string &json)
{
	JevResult r;
	std::string err;
	if (parse_jev_json(json, r, &err))
		return r;
	r = JevResult{};
	r.choice = JevChoice::Hold;
	r.reason = "model output unreadable (" + err + "); asking a person";
	return r;
}

std::string jev_json(const JevResult &r)
{
	std::string s = "{\"choice\":" + json_str(jev_choice_name(r.choice));
	if (r.has_probabilities)
		s += ",\"probabilities\":{\"allow\":" + num(r.p_allow) + ",\"hold\":" + num(r.p_hold) +
		     ",\"block\":" + num(r.p_block) + "}";
	if (!r.reason.empty())
		s += ",\"reason\":" + json_str(r.reason);
	return s + "}";
}
