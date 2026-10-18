#include "overlay_diff.hpp"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/xattr.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>
#include <set>

#include "sha256.hpp"

namespace {

std::string join(const std::string &a, const std::string &b)
{
	if (a.empty() || a == "/")
		return "/" + b;
	return a + "/" + b;
}

bool lstat_ok(const std::string &p, struct stat &st) { return lstat(p.c_str(), &st) == 0; }

bool is_whiteout(const struct stat &st) { return S_ISCHR(st.st_mode) && st.st_rdev == makedev(0, 0); }

bool is_opaque(const std::string &dir)
{
	char v[4] = {};
	ssize_t n = lgetxattr(dir.c_str(), "trusted.overlay.opaque", v, sizeof(v));
	return n == 1 && v[0] == 'y';
}

std::vector<std::string> list_dir(const std::string &dir)
{
	std::vector<std::string> names;
	DIR *d = opendir(dir.c_str());
	if (!d)
		return names;
	while (dirent *e = readdir(d))
		if (strcmp(e->d_name, ".") && strcmp(e->d_name, ".."))
			names.push_back(e->d_name);
	closedir(d);
	std::sort(names.begin(), names.end());
	return names;
}

std::string link_target(const std::string &p)
{
	char buf[4096];
	ssize_t n = readlink(p.c_str(), buf, sizeof(buf));
	return n < 0 ? std::string() : std::string(buf, n);
}

// Identity of a non-directory: content hash for files, target for symlinks.
std::string entry_digest(const std::string &p, const struct stat &st)
{
	if (S_ISLNK(st.st_mode))
		return "l:" + link_target(p);
	if (S_ISREG(st.st_mode))
		return "f:" + file_digest(p);
	return "";
}

// Recursive manifest of a directory tree, so a moved directory can be recognised.
std::string dir_digest(const std::string &dir)
{
	Sha256 h;
	for (auto &n : list_dir(dir)) {
		std::string p = dir + "/" + n;
		struct stat st;
		if (!lstat_ok(p, st))
			continue;
		std::string d = S_ISDIR(st.st_mode) ? "d:" + dir_digest(p) : entry_digest(p, st);
		std::string rec = n + '\0' + d + '\n';
		h.update(rec.data(), rec.size());
	}
	return h.hex();
}

// "mode 644 -> 4755, owner 1000:1000 -> 0:0" (only the parts that changed)
std::string meta_note(const struct stat &a, const struct stat &b)
{
	char buf[128];
	std::string n;
	if ((a.st_mode & 07777) != (b.st_mode & 07777)) {
		snprintf(buf, sizeof(buf), "mode %o -> %o", a.st_mode & 07777, b.st_mode & 07777);
		n = buf;
	}
	if (a.st_uid != b.st_uid || a.st_gid != b.st_gid) {
		snprintf(buf, sizeof(buf), "owner %u:%u -> %u:%u", a.st_uid, a.st_gid, b.st_uid, b.st_gid);
		n += (n.empty() ? "" : ", ") + std::string(buf);
	}
	return n;
}

double file_delta(const std::string &a, const std::string &b)
{
	int fa = open(a.c_str(), O_RDONLY | O_CLOEXEC), fb = open(b.c_str(), O_RDONLY | O_CLOEXEC);
	BitDiff d;
	static thread_local char ba[1 << 16], bb[1 << 16];
	for (;;) {
		ssize_t na = fa < 0 ? 0 : read(fa, ba, sizeof(ba));
		ssize_t nb = fb < 0 ? 0 : read(fb, bb, sizeof(bb));
		if (na <= 0 && nb <= 0)
			break;
		d.feed(ba, na > 0 ? na : 0, bb, nb > 0 ? nb : 0);
	}
	if (fa >= 0)
		close(fa);
	if (fb >= 0)
		close(fb);
	return d.fraction();
}

struct Walker {
	std::vector<Change> out;

	Change make(Kind k, bool dir, const std::string &shown, const struct stat *before, const struct stat *after)
	{
		Change c;
		c.kind = k;
		c.is_dir = dir;
		c.path = shown;
		c.old_size = before && !dir ? before->st_size : 0;
		c.new_size = after && !dir ? after->st_size : 0;
		c.delta = 1;
		return c;
	}

	// Everything under `real` existed before and is now gone (or the reverse).
	void whole_tree(Kind k, const std::string &real, const std::string &shown)
	{
		struct stat st;
		if (!lstat_ok(real, st))
			return;
		bool dir = S_ISDIR(st.st_mode);
		Change c = make(k, dir, shown, k == Kind::Deleted ? &st : nullptr, k == Kind::Added ? &st : nullptr);
		c.digest = dir ? "d:" + dir_digest(real) : entry_digest(real, st);
		if (S_ISLNK(st.st_mode))
			c.note = "symlink";
		out.push_back(c);
		if (dir)
			for (auto &n : list_dir(real))
				whole_tree(k, real + "/" + n, join(shown, n));
	}

	void entry(const std::string &upper, const std::string &lower, const std::string &shown)
	{
		struct stat us, ls;
		if (!lstat_ok(upper, us))
			return;
		bool had = lstat_ok(lower, ls);

		if (is_whiteout(us)) {
			if (had)
				whole_tree(Kind::Deleted, lower, shown);
			return;
		}
		if (S_ISDIR(us.st_mode)) {
			if (had && !S_ISDIR(ls.st_mode)) {  // file replaced by a directory
				whole_tree(Kind::Deleted, lower, shown);
				had = false;
			}
			if (!had) {
				whole_tree(Kind::Added, upper, shown);  // a new directory is complete in upper
				return;
			}
			std::set<std::string> in_upper;
			for (auto &n : list_dir(upper)) {
				in_upper.insert(n);
				entry(upper + "/" + n, lower + "/" + n, join(shown, n));
			}
			if (is_opaque(upper))  // lower's contents are hidden: whatever upper lacks was deleted
				for (auto &n : list_dir(lower))
					if (!in_upper.count(n))
						whole_tree(Kind::Deleted, lower + "/" + n, join(shown, n));
			return;
		}
		// a file, symlink or other non-directory in upper
		if (had && S_ISDIR(ls.st_mode)) {  // directory replaced by a file
			whole_tree(Kind::Deleted, lower, shown);
			had = false;
		}
		if (!had) {
			whole_tree(Kind::Added, upper, shown);
			return;
		}
		Change c = make(Kind::Modified, false, shown, &ls, &us);
		if (S_ISLNK(us.st_mode) || S_ISLNK(ls.st_mode)) {
			std::string a = S_ISLNK(ls.st_mode) ? link_target(lower) : "", b = S_ISLNK(us.st_mode) ? link_target(upper) : "";
			if (S_ISLNK(us.st_mode) == S_ISLNK(ls.st_mode) && a == b)
				return;
			c.delta = bit_delta(a, b);
			c.note = "symlink";
		} else {
			c.delta = file_delta(lower, upper);
			std::string meta = meta_note(ls, us);
			if (c.delta == 0 && meta.empty())  // copied up without any change
				return;
			c.note = c.delta == 0 ? "metadata only: " + meta : meta;
		}
		out.push_back(c);
	}
};

}  // namespace

std::string file_digest(const std::string &path)
{
	int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return "";
	Sha256 h;
	static thread_local char buf[1 << 16];
	ssize_t n;
	while ((n = read(fd, buf, sizeof(buf))) > 0)
		h.update(buf, n);
	close(fd);
	return n < 0 ? "" : h.hex();
}

std::vector<Change> diff_overlay(const std::string &upper, const std::string &lower, const std::string &shown)
{
	Walker w;
	for (auto &n : list_dir(upper))
		w.entry(upper + "/" + n, lower + "/" + n, join(shown, n));
	if (is_opaque(upper))
		for (auto &n : list_dir(lower)) {
			struct stat st;
			if (!lstat_ok(upper + "/" + n, st))
				w.whole_tree(Kind::Deleted, lower + "/" + n, join(shown, n));
		}
	return w.out;
}

bool diff_file(const std::string &original, const std::string &copy, const std::string &shown, Change &out)
{
	struct stat a, b;
	if (!lstat_ok(original, a) || !lstat_ok(copy, b))
		return false;
	double d = file_delta(original, copy);
	std::string meta = meta_note(a, b);
	if (d == 0 && meta.empty())
		return false;
	out = Change{};
	out.kind = Kind::Modified;
	out.path = shown;
	out.old_size = a.st_size;
	out.new_size = b.st_size;
	out.delta = d;
	out.note = d == 0 ? "metadata only: " + meta : meta;
	return true;
}
