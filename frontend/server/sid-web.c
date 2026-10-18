// sid-web: the dashboard's web server.
//
// Serves the files in dist/ and streams sid's event log and ReviewQueue progress
// to the browser as server-sent events. One thread and one poll() loop. With no browser connected
// it sleeps in poll() and does no work.
//
// Local only. It binds to 127.0.0.1 unless SID_WEB_ADDR says otherwise (inside a
// container it must listen on 0.0.0.0, and the host publishes the port on its own
// loopback), and it answers only requests whose Host header names loopback, so a
// web page cannot reach it through DNS rebinding. It reads the event log and review socket, and writes
// exactly one thing: when a person clicks Allow or Block on a held command, POST /decide
// appends one line to the decision file, which sid-daemon reads. It never changes the
// event log.
//
//   SID_WEB_PORT      8080
//   SID_WEB_ADDR      127.0.0.1
//   SID_WEB_ROOT      dist
//   SID_EVENT_LOG     /var/log/sid/events.jsonl      (the variable sid-daemon uses)
//   SID_DECISION_LOG  /var/log/sid/decisions.jsonl   (must already exist and be writable)
//   SID_REVIEW_SOCK   /run/sid/review.sock           (decisions and simulation progress)
//   SID_PROC_DIR      /proc                          (for tests)
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#ifndef SOCK_CLOEXEC
#define SOCK_CLOEXEC 0
#endif

enum {
	MAXC = 32,               // simultaneous connections
	INMAX = 8192,            // largest request
	OUTMAX = 320 * 1024,     // output buffer per connection
	CHUNK = 256 * 1024,      // log bytes read per refill
	SCAN = 64 * 1024 * 1024, // how far back a new browser looks for blocked and held commands
	BACKLOG = 1000,          // most blocked, held and settled lines a new browser starts with
	BODYMAX = 512,           // largest POST body
	DECIDE_MAX = 8 * 1024 * 1024,  // stop adding to a decision file this big
	FILE_CHUNK = 64 * 1024,
	TICK_MS = 50,            // how often the log is checked while a browser is watching
	PING_MS = 15000,         // keeps idle streams alive through port forwarders
	STALL_MS = 30000,        // drop a browser that stops reading
	REQUEST_MS = 5000,       // drop a browser that never finishes its request
	REVIEW_MAX = 256 * 1024, // largest ReviewQueue snapshot sent to a browser
	REVIEW_MS = 500,         // refresh live simulation progress twice a second
};

static const char *const SEC =
	"X-Content-Type-Options: nosniff\r\n"
	"Referrer-Policy: no-referrer\r\n"
	"Cross-Origin-Resource-Policy: same-origin\r\n"
	"Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; "
	"font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
	"form-action 'none'; frame-ancestors 'none'\r\n";

typedef struct {
	int fd;  // -1 when the slot is free
	enum { READING, SENDING, STREAM } st;
	int64_t t0, stall, last;  // accepted; last progress while output waits; last write
	char in[INMAX];
	size_t inlen;
	char *body;   // READING: the request body inside `in`, once the header block is complete
	size_t blen;  // READING: how long the body must be
	char out[OUTMAX];
	size_t olen, opos;
	int ffd;  // file being sent, or -1
	off_t foff, fsize;
	off_t cur;  // STREAM: log offset already sent
	int skip;   // STREAM: discarding the rest of an oversized line
	int guard;  // STREAM: last daemon state sent
	unsigned review_gen; // STREAM: last ReviewQueue snapshot sent
	unsigned gen;  // STREAM: which incarnation of the log `cur` belongs to
} Client;

static Client cl[MAXC];
static char rbuf[CHUNK];

static const char *root, *log_path, *decision_path, *proc_dir, *review_sock;
static int log_fd = -1;
static ino_t log_ino;
static off_t log_size;
static unsigned log_gen;  // changes whenever the log is replaced or truncated
static int guard = -1;  // sid-daemon running: 1 yes, 0 no, -1 cannot tell
static int64_t guard_at;
static char review_snapshot[REVIEW_MAX], review_next[REVIEW_MAX];
static size_t review_len;
static unsigned review_gen;
static int review_known;
static int64_t review_at;

static int64_t now_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

// Milliseconds since 1970: what the page compares its own clock to, and a decision's time.
static int64_t wall_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

static const char *env(const char *k, const char *dflt)
{
	const char *v = getenv(k);
	return v && *v ? v : dflt;
}

static void drop(Client *c)
{
	if (c->ffd >= 0)
		close(c->ffd);
	close(c->fd);
	c->fd = -1;
	c->ffd = -1;
}

// ---- the event log ---------------------------------------------------------------

// The string value of `key` in a JSON line, wherever it sits and however it is spaced:
// the log holds both {"id":"x"} and {"id": "x"}. Quotes inside a string are escaped, so
// "key" followed by a colon can only be a real key.
static size_t json_str(const char *s, size_t n, const char *key, const char **val)
{
	size_t kl = strlen(key);
	const char *end = s + n;
	for (const char *p = s; (p = memchr(p, '"', (size_t)(end - p))); p++) {
		if ((size_t)(end - p) < kl + 2 || memcmp(p + 1, key, kl) != 0 || p[kl + 1] != '"')
			continue;
		const char *q = p + kl + 2;
		while (q < end && (*q == ' ' || *q == '\t'))
			q++;
		if (q >= end || *q != ':')
			continue;  // the same word as a value, not a key
		q++;
		while (q < end && (*q == ' ' || *q == '\t'))
			q++;
		if (q >= end || *q != '"')
			return 0;
		const char *v = ++q;
		while (q < end && *q != '"' && *q != '\\')
			q++;
		if (q >= end || *q != '"')
			return 0;
		*val = v;
		return (size_t)(q - v);
	}
	return 0;
}

// The dashboard keeps blocked and held commands. It does not keep allowed ones, except
// the allowed line that settles a held command (same id), which is how a person's
// approval shows up. So the server remembers which commands are held and how far each
// got. There are two tables: new ids go into the current one, and once it has taken
// TAB_GEN the older one is wiped and the two swap. The last 1024 to 2048 holds are
// therefore always known, and a server that runs for months cannot fill up. A slot is
// the id's hash with the state in its two low bits; 0 is an empty slot.
enum { HELD = 1, ENDED = 2, SETTLED = 3 };  // held; its quarantine reported; decided
enum { TAB_SLOTS = 4096, TAB_GEN = 1024 };
static uint64_t tab[2][TAB_SLOTS];
static int tab_cur;
static unsigned tab_n;  // ids added to tab[tab_cur]

static uint64_t fnv(const char *p, size_t n)
{
	uint64_t h = 1469598103934665603ull;
	while (n--)
		h = (h ^ (unsigned char)*p++) * 1099511628211ull;
	return h | 1;
}

static unsigned tab_first(uint64_t h)
{
	return (unsigned)(h >> 40) & (TAB_SLOTS - 1);
}

static uint64_t *tab_find(uint64_t h)
{
	for (int g = 0; g < 2; g++) {
		uint64_t *t = tab[tab_cur ^ g];
		for (unsigned i = tab_first(h); t[i]; i = (i + 1) & (TAB_SLOTS - 1))
			if (((t[i] ^ h) >> 2) == 0)
				return &t[i];
	}
	return NULL;
}

// 0 for an id that is not held (never was, or too long ago), else HELD, ENDED or SETTLED.
static unsigned tab_state(uint64_t h)
{
	uint64_t *e = tab_find(h);
	return e ? (unsigned)(*e & 3) : 0;
}

static void tab_set(uint64_t h, unsigned state)
{
	uint64_t *e = tab_find(h);
	if (!e) {
		if (tab_n == TAB_GEN) {
			tab_cur ^= 1;
			memset(tab[tab_cur], 0, sizeof(tab[0]));
			tab_n = 0;
		}
		uint64_t *t = tab[tab_cur];
		unsigned i = tab_first(h);
		while (t[i])
			i = (i + 1) & (TAB_SLOTS - 1);
		e = &t[i];
		tab_n++;
	}
	*e = (h & ~3ull) | state;
}

enum { DROP, PRIMARY, QUARANTINE };  // what show() says about a line
enum { PLAIN, HOLD, SETTLE, QEND };  // what a line does to the table

// Reads one log line. A quarantine line has a top-level "q" key and an allowed line is
// a settle; both pass only for an id that is held. Everything else passes as it always
// has. *what says how the line changes the table, and track_line() applies that: this
// only looks.
static int classify(const char *line, size_t len, uint64_t *h, int *what)
{
	const char *q, *v, *id;
	size_t il = json_str(line, len, "id", &id), ql = json_str(line, len, "q", &q);
	*h = il ? fnv(id, il) : 0;
	*what = PLAIN;
	int held = *h && tab_state(*h);
	if (ql) {
		if (ql == 3 && memcmp(q, "end", 3) == 0)
			*what = QEND;
		return held ? QUARANTINE : DROP;
	}
	size_t vl = json_str(line, len, "verdict", &v);
	if (vl == 5 && memcmp(v, "allow", 5) == 0) {
		*what = SETTLE;
		return held ? PRIMARY : DROP;
	}
	if (vl == 5 && memcmp(v, "block", 5) == 0)
		*what = SETTLE;
	else if (vl == 4 && memcmp(v, "hold", 4) == 0)
		*what = HOLD;
	return PRIMARY;
}

// Whether a browser gets this line: DROP, PRIMARY (a blocked, held or settled command) or
// QUARANTINE. It only reads the table, so it can be asked again for the same line.
static int show(const char *line, size_t len)
{
	uint64_t h;
	int what;
	return classify(line, len, &h, &what);
}

// The offsets of the last BACKLOG primary lines. Quarantine lines do not count: a hold
// and its report would otherwise push blocked commands out of a new browser's start.
static off_t ring[BACKLOG];
static unsigned ring_at, ring_n;  // next slot to fill; how many are filled

static off_t tpos;  // log bytes tracked: every complete line before this was seen once
static int tskip;   // tracking is inside an oversized line, discarding it

static void ring_push(off_t off)
{
	ring[ring_at] = off;
	ring_at = (ring_at + 1) % BACKLOG;
	if (ring_n < BACKLOG)
		ring_n++;
}

// A line, in log order and exactly once: holds are learned before their quarantine lines.
static void track_line(const char *line, size_t len, off_t off)
{
	uint64_t h;
	int what, k = classify(line, len, &h, &what);
	unsigned st = h ? tab_state(h) : 0;
	if (what == HOLD && h && !st)
		tab_set(h, HELD);
	else if (what == QEND && st == HELD)
		tab_set(h, ENDED);
	else if (what == SETTLE && (st == HELD || st == ENDED))
		tab_set(h, SETTLED);
	if (k == PRIMARY)
		ring_push(off);
}

// Reads the log's new complete lines into the table and the ring. All that the server
// knows about held commands comes from here, and each byte of the log is read once;
// pump() only looks things up. It follows pump()'s rule for a line bigger than a chunk
// (it is skipped), so the two always agree on where lines begin.
static void track(void)
{
	if (log_fd < 0)
		return;
	if (log_size - tpos > SCAN) {  // far behind, or a huge log: only the last SCAN bytes count
		tpos = log_size - SCAN;
		tskip = 1;  // landed mid-line
		ring_n = 0;
	}
	while (tpos < log_size) {
		size_t want = log_size - tpos < CHUNK ? (size_t)(log_size - tpos) : CHUNK;
		ssize_t n = pread(log_fd, rbuf, want, tpos);
		if (n <= 0)
			break;
		char *p = rbuf, *end = rbuf + n, *nl;
		if (tskip) {
			nl = memchr(p, '\n', (size_t)n);
			if (!nl) {
				tpos += n;
				continue;
			}
			p = nl + 1;
			tskip = 0;
		}
		for (; (nl = memchr(p, '\n', (size_t)(end - p))); p = nl + 1)
			if (nl > p)
				track_line(p, (size_t)(nl - p), tpos + (p - rbuf));
		if (p == rbuf) {
			if (n < CHUNK)
				break;  // the unfinished last line: wait for the rest
			tskip = 1;  // no line ends in a whole chunk: it is a huge one
			tpos += n;
			continue;
		}
		tpos += p - rbuf;  // the next read starts at the first unfinished line
	}
}

// Where a new browser starts: the oldest of the last BACKLOG primary lines, or the end of
// the log when there are none.
static off_t backlog_start(void)
{
	return ring_n ? ring[(ring_at + BACKLOG - ring_n) % BACKLOG] : tpos;
}

// Forget everything learned from the log: it was replaced or emptied. Browsers that were
// partway through start again from the top (their offsets mean nothing in the new file).
static void log_reset(void)
{
	memset(tab, 0, sizeof(tab));
	tab_cur = 0;
	tab_n = 0;
	ring_at = ring_n = 0;
	tpos = 0;
	tskip = 0;
	log_gen++;
}

static void log_refresh(void)
{
	struct stat st;
	if (stat(log_path, &st) != 0 || !S_ISREG(st.st_mode)) {
		if (log_fd >= 0) {
			close(log_fd);
			log_reset();
		}
		log_fd = -1;
		log_size = 0;
		return;
	}
	if (log_fd >= 0 && st.st_ino != log_ino) {  // rotated: start the new file from its top
		close(log_fd);
		log_fd = -1;
	}
	if (log_fd < 0) {
		static int warned;
		log_fd = open(log_path, O_RDONLY | O_CLOEXEC);
		if (log_fd < 0) {
			if (!warned)  // an unreadable log must not look like an empty one
				fprintf(stderr, "sid-web: cannot read %s: %s\n", log_path, strerror(errno));
			warned = 1;
			log_size = 0;
			return;
		}
		warned = 0;
		log_ino = st.st_ino;
		log_reset();
	} else if (st.st_size < tpos) {  // truncated in place
		log_reset();
	}
	log_size = st.st_size;
	track();
}

// ---- is sid-daemon running? -------------------------------------------------------

// Looks for a root-owned process named sid-daemon. A lookalike run by anyone else
// does not count. Where there is no /proc this cannot tell, and says nothing.
static void guard_refresh(int64_t now)
{
	if (now - guard_at < 2000)
		return;
	guard_at = now;
	DIR *d = opendir(proc_dir);
	if (!d) {
		guard = -1;
		return;
	}
	int up = 0;
	struct dirent *e;
	while (!up && (e = readdir(d))) {
		if (e->d_name[0] < '0' || e->d_name[0] > '9')
			continue;
		char p[512], buf[2048];
		snprintf(p, sizeof(p), "%s/%s/comm", proc_dir, e->d_name);
		int fd = open(p, O_RDONLY | O_CLOEXEC);
		if (fd < 0)
			continue;
		ssize_t n = read(fd, buf, 32);
		close(fd);
		if (n != 11 || memcmp(buf, "sid-daemon\n", 11) != 0)
			continue;
		snprintf(p, sizeof(p), "%s/%s/status", proc_dir, e->d_name);
		fd = open(p, O_RDONLY | O_CLOEXEC);
		if (fd < 0)
			continue;
		n = read(fd, buf, sizeof(buf) - 1);
		close(fd);
		if (n > 0) {
			buf[n] = 0;
			up = strstr(buf, "\nUid:\t0\t") != NULL;
		}
	}
	closedir(d);
	guard = up;
}

// ---- requests ---------------------------------------------------------------------

// Every answer except a file or a stream. `extra` is whole header lines, or "". Nothing
// the server says is worth keeping, and it never sends Access-Control-* headers: no other
// web page may read it or POST to it.
static void reply(Client *c, int code, const char *phrase, const char *type, const char *body, const char *extra)
{
	c->olen = snprintf(c->out, OUTMAX,
			   "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
			   "Cache-Control: no-store\r\nConnection: close\r\n%s%s\r\n%s",
			   code, phrase, type, strlen(body), extra, SEC, body);
	c->opos = 0;
	c->st = SENDING;
}

static void fail(Client *c, int code, const char *msg)
{
	reply(c, code, msg, "text/plain", msg, "");
}

// Value of header `name` (lower case, with its colon) in the request: 1 and the value in
// `val`, 0 when there is no such header, -1 when it is there but longer than `cap`. Only
// the header block is searched; request_ready() has cut the body off.
static int header(const char *req, const char *name, char *val, size_t cap)
{
	size_t nl = strlen(name);
	for (const char *p = strstr(req, "\r\n"); p; p = strstr(p, "\r\n")) {
		p += 2;
		if (strncasecmp(p, name, nl) != 0)
			continue;
		p += nl;
		while (*p == ' ' || *p == '\t')
			p++;
		size_t n = strcspn(p, "\r\n");
		while (n && (p[n - 1] == ' ' || p[n - 1] == '\t'))
			n--;
		if (n >= cap)
			return -1;
		memcpy(val, p, n);
		val[n] = 0;
		return 1;
	}
	return 0;
}

// localhost, 127.0.0.1 or [::1], each with an optional :port.
static int loopback_host(const char *h)
{
	size_t n;
	if (*h == '[') {
		const char *e = strchr(h, ']');
		if (!e)
			return 0;
		n = e - h + 1;
	} else
		n = strcspn(h, ":");
	int ok = (n == 9 && strncasecmp(h, "localhost", 9) == 0) || (n == 9 && strncmp(h, "127.0.0.1", 9) == 0) ||
		 (n == 5 && strncmp(h, "[::1]", 5) == 0);
	if (!ok)
		return 0;
	if (h[n] == 0)
		return 1;
	if (h[n] != ':' || h[n + 1] == 0)
		return 0;
	for (const char *p = h + n + 1; *p; p++)
		if (!isdigit((unsigned char)*p))
			return 0;
	return 1;
}

// Only plain names: letters, digits and . - _ /, no "..", no "//".
static int safe_path(const char *p)
{
	if (p[0] != '/')
		return 0;
	for (const char *s = p; *s; s++) {
		if (!isalnum((unsigned char)*s) && *s != '/' && *s != '.' && *s != '-' && *s != '_')
			return 0;
		if ((s[0] == '.' && s[1] == '.') || (s[0] == '/' && s[1] == '/'))
			return 0;
	}
	return 1;
}

static const char *ctype(const char *p)
{
	static const struct {
		const char *ext, *type;
	} T[] = {
		{".html", "text/html; charset=utf-8"}, {".css", "text/css; charset=utf-8"},
		{".js", "text/javascript; charset=utf-8"}, {".woff2", "font/woff2"},
		{".json", "application/json"}, {".svg", "image/svg+xml"}, {".txt", "text/plain; charset=utf-8"},
	};
	const char *e = strrchr(p, '.');
	for (size_t i = 0; e && i < sizeof(T) / sizeof(T[0]); i++)
		if (strcmp(e, T[i].ext) == 0)
			return T[i].type;
	return "application/octet-stream";
}

static void serve_file(Client *c, const char *path, int head)
{
	char fp[1024];
	size_t n = strlen(path);
	snprintf(fp, sizeof(fp), "%s%s%s", root, path, path[n - 1] == '/' ? "index.html" : "");
	int fd = open(fp, O_RDONLY | O_CLOEXEC);
	struct stat st;
	if (fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
		if (fd >= 0)
			close(fd);
		fail(c, 404, "Not found");
		return;
	}
	char etag[64], inm[96];
	snprintf(etag, sizeof(etag), "\"%llx-%llx\"", (unsigned long long)st.st_mtime, (unsigned long long)st.st_size);
	if (header(c->in, "if-none-match:", inm, sizeof(inm)) > 0 && strcmp(inm, etag) == 0) {
		close(fd);
		c->olen = snprintf(c->out, OUTMAX,
				   "HTTP/1.1 304 Not Modified\r\nETag: %s\r\nCache-Control: no-cache\r\n"
				   "Connection: close\r\n%s\r\n",
				   etag, SEC);
		c->opos = 0;
		c->st = SENDING;
		return;
	}
	c->olen = snprintf(c->out, OUTMAX,
			   "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %lld\r\nETag: %s\r\n"
			   "Cache-Control: no-cache\r\nConnection: close\r\n%s\r\n",
			   ctype(fp), (long long)st.st_size, etag, SEC);
	c->opos = 0;
	c->ffd = head ? -1 : fd;  // HEAD: the headers are the whole answer
	c->foff = 0;
	c->fsize = st.st_size;
	c->st = SENDING;
	if (head)
		close(fd);
}

// The page's clock and whether a decision can be written. It goes first on every stream
// and then every PING_MS in place of a bare ping, so the page can tell how far its own
// clock is off and whether to offer Allow and Block at all.
static size_t clock_frame(char *out, size_t cap)
{
	int ok = review_sock && access(review_sock, F_OK) == 0;  // can we reach the daemon's review socket?
	return (size_t)snprintf(out, cap, "event: clock\ndata: {\"now\":%lld,\"decide\":%s}\n\n", (long long)wall_ms(),
				ok ? "true" : "false");
}

// Read one LIST reply from ReviewQueue. It is local to the sandbox, and a
// short timeout keeps a stalled daemon from holding up the web event loop.
static int sid_review_list(char *out, size_t cap)
{
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0)
		return 0;
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	struct sockaddr_un sa = {0};
	sa.sun_family = AF_UNIX;
	snprintf(sa.sun_path, sizeof(sa.sun_path), "%s", review_sock ? review_sock : "");
	if (connect(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
		close(fd);
		return 0;
	}
	static const char req[] = "LIST\n";
	size_t sent = 0;
	while (sent < sizeof(req) - 1) {
		ssize_t n = write(fd, req + sent, sizeof(req) - 1 - sent);
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0) {
			close(fd);
			return 0;
		}
		sent += (size_t)n;
	}
	size_t used = 0;
	while (used + 1 < cap) {
		struct pollfd p = {.fd = fd, .events = POLLIN};
		int ready;
		do {
			ready = poll(&p, 1, 100);
		} while (ready < 0 && errno == EINTR);
		if (ready <= 0 || !(p.revents & (POLLIN | POLLHUP)))
			break;
		ssize_t n = read(fd, out + used, cap - used - 1);
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0)
			break;
		char *nl = memchr(out + used, '\n', (size_t)n);
		if (nl) {
			*nl = 0;
			close(fd);
			return 1;
		}
		used += (size_t)n;
	}
	close(fd);
	return 0;
}

static void review_refresh(int64_t now)
{
	if (now - review_at < REVIEW_MS)
		return;
	review_at = now;
	if (!sid_review_list(review_next, sizeof(review_next)))
		return;
	size_t n = strlen(review_next);
	if (review_known && n == review_len && memcmp(review_snapshot, review_next, n) == 0)
		return;
	memcpy(review_snapshot, review_next, n + 1);
	review_len = n;
	review_known = 1;
	review_gen++;
}

static void review_frame(Client *c)
{
	if (!review_known || c->review_gen == review_gen || c->olen + review_len + 32 > OUTMAX)
		return;
	c->olen += (size_t)snprintf(c->out + c->olen, OUTMAX - c->olen, "event: reviews\ndata: ");
	memcpy(c->out + c->olen, review_snapshot, review_len);
	c->olen += review_len;
	memcpy(c->out + c->olen, "\n\n", 2);
	c->olen += 2;
	c->review_gen = review_gen;
}

static void start_stream(Client *c)
{
	char id[32], prev;
	log_refresh();
	// A line ends at the offset the browser last saw, or it is not a place to resume from
	long long last = header(c->in, "last-event-id:", id, sizeof(id)) > 0 ? atoll(id) : -1;
	int resume = last == 0 || (last > 0 && last <= tpos && log_fd >= 0 && pread(log_fd, &prev, 1, last - 1) == 1 &&
				   prev == '\n');
	c->cur = resume ? last : backlog_start();
	c->gen = log_gen;
	c->skip = 0;
	c->review_gen = 0;
	c->guard = -2;
	c->olen = snprintf(c->out, OUTMAX,
			   "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n"
			   "Connection: keep-alive\r\n%s\r\nretry: 1000\r\n\r\n",
			   SEC);
	c->olen += clock_frame(c->out + c->olen, OUTMAX - c->olen);
	review_frame(c);
	c->opos = 0;
	c->st = STREAM;
}

// ---- POST /decide -----------------------------------------------------------------

// A person's answer for a held command, appended to the decision file for sid-daemon to
// act on. The last answers are remembered so that a double click is not written twice.
static struct {
	uint64_t h;  // 0 is an empty slot
	int allow;
} done[256];
static unsigned done_at;

static void jerr(Client *c, int code, const char *phrase, const char *msg)
{
	char b[96];
	snprintf(b, sizeof(b), "{\"error\":\"%s\"}", msg);
	reply(c, code, phrase, "application/json", b, "");
}

static int is_json_type(const char *t)
{
	return strcasecmp(t, "application/json") == 0 || strcasecmp(t, "application/json; charset=utf-8") == 0 ||
	       strcasecmp(t, "application/json;charset=utf-8") == 0;
}

// Send "VERB id\n" to the daemon's review socket and return 1 if it replied ok.
// The id the page sends is the event id, which the daemon also uses as the review
// id, so APPROVE/DENY address the right held command. A short, blocking round trip;
// APPROVE/DENY answer immediately, and decisions are rare.
static int sid_review(const char *verb, const char *id, char *err, size_t errlen)
{
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0) {
		snprintf(err, errlen, "socket: %s", strerror(errno));
		return 0;
	}
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	struct sockaddr_un sa = {0};
	sa.sun_family = AF_UNIX;
	snprintf(sa.sun_path, sizeof(sa.sun_path), "%s", review_sock ? review_sock : "");
	int ok = 0;
	if (connect(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
		snprintf(err, errlen, "connect: %s", strerror(errno));
	} else {
		char req[64];
		int rl = snprintf(req, sizeof(req), "%s %s\n", verb, id);
		char buf[512];
		ssize_t n;
		if (write(fd, req, (size_t)rl) != rl)
			snprintf(err, errlen, "write: %s", strerror(errno));
		else if ((n = read(fd, buf, sizeof(buf) - 1)) <= 0)
			snprintf(err, errlen, "no reply");
		else {
			buf[n] = 0;
			ok = strstr(buf, "\"ok\":true") != NULL;
			if (!ok)
				snprintf(err, errlen, "%.120s", buf);
		}
	}
	close(fd);
	return ok;
}

// Checks in the order CONTRACT.md lists them. A browser always sends a Content-Type and
// X-Sid-Request that another web page cannot send without a CORS preflight, which is never
// granted (no OPTIONS, no Access-Control-*). The Origin and Sec-Fetch-Site tests are a
// second wall; a client that sends neither (curl) is a local program, and passes.
static void decide(Client *c)
{
	char ct[64], xs[8], host[128], org[192], site[32], idv[33], want[160];
	if (header(c->in, "content-type:", ct, sizeof(ct)) <= 0 || !is_json_type(ct)) {
		jerr(c, 415, "Unsupported Media Type", "content type must be application/json");
		return;
	}
	if (header(c->in, "x-sid-request:", xs, sizeof(xs)) <= 0 || strcmp(xs, "1") != 0) {
		jerr(c, 403, "Forbidden", "missing X-Sid-Request");
		return;
	}
	int o = header(c->in, "origin:", org, sizeof(org)), s = header(c->in, "sec-fetch-site:", site, sizeof(site));
	header(c->in, "host:", host, sizeof(host));  // request_ready() has checked it
	snprintf(want, sizeof(want), "http://%s", host);
	if (o < 0 || (o > 0 && strcasecmp(org, want) != 0) || s < 0 || (s > 0 && strcmp(site, "same-origin") != 0)) {
		jerr(c, 403, "Forbidden", "cross-origin request");
		return;
	}

	const char *b = c->body, *idp, *vp;
	size_t n = c->blen;
	while (n && isspace((unsigned char)*b))
		b++, n--;
	while (n && isspace((unsigned char)b[n - 1]))
		n--;
	size_t il = n >= 2 && b[0] == '{' && b[n - 1] == '}' ? json_str(b, n, "id", &idp) : 0;
	size_t vl = il ? json_str(b, n, "verdict", &vp) : 0;
	int allow = vl == 5 && memcmp(vp, "allow", 5) == 0;
	if (il < 1 || il > 32 || !(allow || (vl == 5 && memcmp(vp, "block", 5) == 0))) {
		jerr(c, 400, "Bad Request", "body must be {\"id\":\"...\",\"verdict\":\"allow|block\"}");
		return;
	}
	for (size_t i = 0; i < il; i++)
		if (!isalnum((unsigned char)idp[i]) && idp[i] != '_' && idp[i] != '-') {
			jerr(c, 400, "Bad Request", "bad id");
			return;
		}
	memcpy(idv, idp, il);
	idv[il] = 0;

	log_refresh();  // a hold written a moment ago must count
	uint64_t h = fnv(idv, il);
	unsigned st = tab_state(h);
	if (!st) {
		jerr(c, 404, "Not Found", "no such held command");
		return;
	}
	if (st == SETTLED) {
		jerr(c, 409, "Conflict", "already decided");
		return;
	}
	int dup = 0;
	for (int i = 0; i < 256; i++)
		if (done[i].h == h) {
			if (done[i].allow != allow) {
				jerr(c, 409, "Conflict", "a different decision was already sent");
				return;
			}
			dup = 1;
		}

	if (!dup) {
		char err[160] = "";
		if (!sid_review(allow ? "APPROVE" : "DENY", idv, err, sizeof(err))) {
			fprintf(stderr, "sid-web: cannot send a decision to %s: %s\n", review_sock ? review_sock : "(unset)", err);
			jerr(c, 503, "Service Unavailable", "decisions unavailable");
			return;
		}
		unsigned k = done_at++ % 256;
		done[k].h = h;
		done[k].allow = allow;
	}
	char out[160];
	snprintf(out, sizeof(out), "{\"ok\":true,\"queued\":true,%s\"id\":\"%s\",\"verdict\":\"%s\"}",
		 dup ? "\"duplicate\":true," : "", idv, allow ? "allow" : "block");
	reply(c, 202, "Accepted", "application/json", out, "");
}

// ---- reading a request ------------------------------------------------------------

// Is the whole request here? The header block ends at the first blank line: it is cut off
// there, so header() cannot be fooled by a "Host:" smuggled into a body. The Host check
// comes before anything else, for every method. A POST needs a Content-Length, and the
// request is not ready until that many body bytes have arrived (REQUEST_MS covers a body
// that dribbles in). Returns 1 when the request can be answered, or already has been.
static int request_ready(Client *c)
{
	if (!c->body) {
		char *e = memmem(c->in, c->inlen, "\r\n\r\n", 4), host[128], len[16];
		if (!e) {
			if (c->inlen < INMAX - 1)
				return 0;
			fail(c, 431, "Request too large");
			return 1;
		}
		*e = 0;
		c->body = e + 4;
		if (strlen(c->in) != (size_t)(e - c->in)) {  // a NUL hides the headers after it
			fail(c, 400, "Bad request");
			return 1;
		}
		if (header(c->in, "host:", host, sizeof(host)) <= 0 || !loopback_host(host)) {
			fail(c, 403, "Forbidden");
			return 1;
		}
		if (strncmp(c->in, "POST ", 5) == 0) {
			int has = header(c->in, "content-length:", len, sizeof(len));
			if (header(c->in, "transfer-encoding:", host, sizeof(host)) != 0) {
				fail(c, 400, "Bad request");  // chunked bodies are not read
				return 1;
			}
			if (has == 0) {
				fail(c, 411, "Length required");
				return 1;
			}
			char *end = len;
			unsigned long n = has > 0 ? strtoul(len, &end, 10) : 0;
			if (has > 0 && (!isdigit((unsigned char)len[0]) || *end)) {
				fail(c, 400, "Bad request");
				return 1;
			}
			if (has < 0 || n > BODYMAX || (size_t)(c->body - c->in) + n > INMAX - 1) {
				fail(c, 413, "Payload too large");
				return 1;
			}
			c->blen = n;
		}
	}
	return c->inlen - (size_t)(c->body - c->in) >= c->blen;
}

static void request(Client *c)
{
	char path[512];
	char *line = c->in, *sp = strchr(line, ' '), *eol = line + strcspn(line, "\r\n");
	if (!sp || sp >= eol) {
		fail(c, 400, "Bad request");
		return;
	}
	size_t ml = (size_t)(sp - line);
	int get = ml == 3 && strncmp(line, "GET", 3) == 0, head = ml == 4 && strncmp(line, "HEAD", 4) == 0,
	    post = ml == 4 && strncmp(line, "POST", 4) == 0;
	char *te = memchr(sp + 1, ' ', (size_t)(eol - (sp + 1)));
	size_t tl = te ? (size_t)(te - (sp + 1)) : 0;
	if (tl == 0 || tl >= sizeof(path)) {
		fail(c, 400, "Bad request");
		return;
	}
	memcpy(path, sp + 1, tl);
	path[tl] = 0;
	char *q = strchr(path, '?');
	if (q)
		*q = 0;
	if (strcmp(path, "/decide") == 0) {
		if (post)
			decide(c);
		else  // OPTIONS too: nothing is ever allowed across origins
			reply(c, 405, "Method Not Allowed", "application/json", "{\"error\":\"POST only\"}", "Allow: POST\r\n");
	} else if (!get && !head) {
		reply(c, 405, "Method Not Allowed", "text/plain", "Method not allowed", "Allow: GET, HEAD\r\n");
	} else if (strcmp(path, "/events") == 0 && !head) {
		start_stream(c);
	} else if (!safe_path(path)) {
		fail(c, 404, "Not found");
	} else {
		serve_file(c, path, head);
	}
}

// ---- output -----------------------------------------------------------------------

// Frames the next batch of log lines (and daemon state changes) into the output buffer.
// Only lines track() has already seen are sent, so show() knows every hold before its
// quarantine lines; it never changes the table.
static void pump(Client *c, int64_t now)
{
	if (c->opos < c->olen)
		return;  // still sending the last batch
	c->opos = c->olen = 0;
	if (guard >= 0 && guard != c->guard) {
		c->olen += snprintf(c->out, OUTMAX, "event: status\ndata: %s\n\n", guard ? "up" : "down");
		c->guard = guard;
	}
	review_frame(c);
	if (c->gen != log_gen || c->cur > tpos)  // the log was replaced or truncated: from the top
		c->cur = 0, c->skip = 0, c->gen = log_gen;
	if (c->cur < tpos && log_fd >= 0) {
		size_t want = tpos - c->cur < CHUNK ? (size_t)(tpos - c->cur) : CHUNK;
		ssize_t n = pread(log_fd, rbuf, want, c->cur);
		if (n > 0) {
			char *p = rbuf, *end = rbuf + n, *nl;
			if (c->skip) {
				nl = memchr(p, '\n', n);
				if (!nl) {
					c->cur += n;
					goto sent;
				}
				p = nl + 1;
				c->skip = 0;
			}
			while ((nl = memchr(p, '\n', end - p))) {
				size_t len = nl - p;
				int send = len && show(p, len) != DROP;
				if (send && c->olen + len + 48 > OUTMAX)
					break;  // full: the rest goes next time
				if (send) {
					c->olen += snprintf(c->out + c->olen, OUTMAX - c->olen, "id: %lld\ndata: ",
							    (long long)(c->cur + (nl + 1 - rbuf)));
					memcpy(c->out + c->olen, p, len);
					c->olen += len;
					memcpy(c->out + c->olen, "\n\n", 2);
					c->olen += 2;
				}
				p = nl + 1;
			}
			if (p == rbuf && n == CHUNK)  // one line bigger than a chunk: skip it
				c->cur += n, c->skip = 1;
			else
				c->cur += p - rbuf;  // a partial last line waits for the rest
		}
	}
sent:
	if (c->olen == 0 && now - c->last > PING_MS)
		c->olen = clock_frame(c->out, OUTMAX);
	if (c->olen)
		c->stall = now;
}

static void flush(Client *c, int64_t now)
{
	for (;;) {
		while (c->opos < c->olen) {
			ssize_t n = send(c->fd, c->out + c->opos, c->olen - c->opos, 0);
			if (n > 0) {
				c->opos += n;
				c->stall = c->last = now;
			} else if (n < 0 && errno == EINTR) {
				continue;
			} else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
				return;
			} else {
				drop(c);
				return;
			}
		}
		if (c->st != SENDING)
			return;
		ssize_t n = c->ffd < 0 || c->foff >= c->fsize ? 0 : pread(c->ffd, c->out, FILE_CHUNK, c->foff);
		if (n <= 0) {  // response complete (or the file shrank under us)
			drop(c);
			return;
		}
		c->foff += n;
		c->olen = n;
		c->opos = 0;
	}
}

// ---- main loop --------------------------------------------------------------------

static int listener(const char *addr, int port)
{
	int fd = socket(AF_INET, SOCK_STREAM, 0), on = 1;
	struct sockaddr_in sa = {0};
	sa.sin_family = AF_INET;
	sa.sin_port = htons(port);
	if (fd < 0 || inet_pton(AF_INET, addr, &sa.sin_addr) != 1) {
		fprintf(stderr, "sid-web: %s is not an IPv4 address\n", addr);
		exit(1);
	}
	setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
	if (bind(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0 || listen(fd, 16) != 0) {
		fprintf(stderr, "sid-web: cannot listen on %s:%d: %s\n", addr, port, strerror(errno));
		exit(1);
	}
	fcntl(fd, F_SETFL, O_NONBLOCK);
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	return fd;
}

static void accept_all(int lfd, int64_t now)
{
	for (;;) {
		int fd = accept(lfd, NULL, NULL);
		if (fd < 0)
			return;
		Client *c = NULL;
		for (int i = 0; i < MAXC && !c; i++)
			if (cl[i].fd < 0)
				c = &cl[i];
		if (!c) {
			close(fd);
			continue;
		}
		fcntl(fd, F_SETFL, O_NONBLOCK);
		fcntl(fd, F_SETFD, FD_CLOEXEC);
		c->fd = fd;
		c->st = READING;
		c->t0 = c->stall = c->last = now;
		c->inlen = c->olen = c->opos = c->blen = 0;
		c->body = NULL;
		c->ffd = -1;
	}
}

int main(void)
{
	signal(SIGPIPE, SIG_IGN);
	const char *addr = env("SID_WEB_ADDR", "127.0.0.1");
	int port = atoi(env("SID_WEB_PORT", "8080"));
	root = env("SID_WEB_ROOT", "dist");
	log_path = env("SID_EVENT_LOG", "/var/log/sid/events.jsonl");
	decision_path = env("SID_DECISION_LOG", "/var/log/sid/decisions.jsonl");
	review_sock = env("SID_REVIEW_SOCK", "/run/sid/review.sock");  // decisions go here, to sid-daemon
	proc_dir = env("SID_PROC_DIR", "/proc");
	for (int i = 0; i < MAXC; i++)
		cl[i].fd = -1;

	int lfd = listener(addr, port);
	fprintf(stderr, "sid-web: http://%s:%d  (files %s, events %s, decisions %s)\n", addr, port, root, log_path,
		decision_path);
	if (strncmp(addr, "127.", 4) != 0)
		fprintf(stderr, "sid-web: listening beyond this machine's loopback; only do that inside a container\n");

	struct pollfd pf[MAXC + 1];
	Client *who[MAXC + 1];
	for (;;) {
		int np = 0, streams = 0, busy = 0, open = 0;
		pf[np].fd = lfd, pf[np].events = POLLIN, who[np++] = NULL;
		for (int i = 0; i < MAXC; i++) {
			Client *c = &cl[i];
			if (c->fd < 0)
				continue;
			open++;
			short ev = c->st == SENDING ? 0 : POLLIN;
			if (c->opos < c->olen)
				ev |= POLLOUT;
			else if (c->st == STREAM && (c->cur < tpos || c->gen != log_gen))
				busy = 1;
			if (c->st == STREAM)
				streams++;
			pf[np].fd = c->fd, pf[np].events = ev, who[np++] = c;
		}
		int timeout = busy ? 0 : streams ? TICK_MS : open ? 1000 : -1;
		if (poll(pf, np, timeout) < 0)
			continue;
		int64_t now = now_ms();

		if (pf[0].revents & POLLIN)
			accept_all(lfd, now);
		for (int i = 1; i < np; i++) {
			Client *c = who[i];
			if (c->fd < 0 || !pf[i].revents)
				continue;
			if (pf[i].revents & POLLOUT)
				flush(c, now);
			if (c->fd >= 0 && (pf[i].revents & (POLLIN | POLLHUP | POLLERR)) && c->st != SENDING) {
				char junk[64];
				ssize_t n = c->st == READING ? recv(c->fd, c->in + c->inlen, INMAX - 1 - c->inlen, 0)
							     : recv(c->fd, junk, sizeof(junk), 0);
				if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
					drop(c);
				} else if (n > 0 && c->st == READING) {
					c->inlen += n;
					c->in[c->inlen] = 0;
					if (request_ready(c)) {
						if (c->st == READING)  // not already answered with an error
							request(c);
						flush(c, now);
					}
				}
			} else if (c->fd >= 0 && (pf[i].revents & (POLLHUP | POLLERR))) {
				drop(c);
			}
		}

		if (streams) {
			log_refresh();
			guard_refresh(now);
			review_refresh(now);
		}
		for (int i = 0; i < MAXC; i++) {
			Client *c = &cl[i];
			if (c->fd < 0)
				continue;
			if (c->st == STREAM) {
				pump(c, now);
				flush(c, now);
			}
			if (c->fd >= 0 && c->st == READING && now - c->t0 > REQUEST_MS)
				drop(c);
			else if (c->fd >= 0 && c->opos < c->olen && now - c->stall > STALL_MS)
				drop(c);
		}
	}
}
