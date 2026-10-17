// sid-web: the dashboard's web server.
//
// Serves the files in dist/ and streams sid's event log to the browser as
// server-sent events. One thread and one poll() loop. With no browser connected
// it sleeps in poll() and does no work.
//
// Local only. It binds to 127.0.0.1 unless SID_WEB_ADDR says otherwise (inside a
// container it must listen on 0.0.0.0, and the host publishes the port on its own
// loopback), and it answers only requests whose Host header names loopback, so a
// web page cannot reach it through DNS rebinding. It is read-only: nothing to POST.
//
//   SID_WEB_PORT   8080
//   SID_WEB_ADDR   127.0.0.1
//   SID_WEB_ROOT   dist
//   SID_EVENT_LOG  /var/log/sid/events.jsonl    (the variable sid-daemon uses)
//   SID_PROC_DIR   /proc                        (for tests)
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
#include <time.h>
#include <unistd.h>

enum {
	MAXC = 32,               // simultaneous connections
	INMAX = 8192,            // largest request
	OUTMAX = 320 * 1024,     // output buffer per connection
	CHUNK = 256 * 1024,      // log bytes read per refill, and how far back a new browser looks
	BACKLOG = 100,           // most events a new browser starts with
	FILE_CHUNK = 64 * 1024,
	TICK_MS = 50,            // how often the log is checked while a browser is watching
	PING_MS = 15000,         // keeps idle streams alive through port forwarders
	STALL_MS = 30000,        // drop a browser that stops reading
	REQUEST_MS = 5000,       // drop a browser that never finishes its request
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
	char out[OUTMAX];
	size_t olen, opos;
	int ffd;  // file being sent, or -1
	off_t foff, fsize;
	off_t cur;  // STREAM: log offset already sent
	int skip;   // STREAM: discarding the rest of an oversized line
	int guard;  // STREAM: last daemon state sent
} Client;

static Client cl[MAXC];
static char rbuf[CHUNK];

static const char *root, *log_path, *proc_dir;
static int log_fd = -1;
static ino_t log_ino;
static off_t log_size;
static int guard = -1;  // sid-daemon running: 1 yes, 0 no, -1 cannot tell
static int64_t guard_at;

static int64_t now_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
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

static void log_refresh(void)
{
	struct stat st;
	if (stat(log_path, &st) != 0 || !S_ISREG(st.st_mode)) {
		if (log_fd >= 0)
			close(log_fd);
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
		for (int i = 0; i < MAXC; i++)
			if (cl[i].fd >= 0 && cl[i].st == STREAM)
				cl[i].cur = 0, cl[i].skip = 0;
	}
	log_size = st.st_size;
}

// Where the last BACKLOG lines of the log begin.
static off_t backlog_start(void)
{
	if (log_fd < 0 || log_size == 0)
		return 0;
	size_t want = log_size > CHUNK ? CHUNK : (size_t)log_size;
	off_t from = log_size - want;
	ssize_t n = pread(log_fd, rbuf, want, from);
	if (n <= 0)
		return log_size;
	int seen = 0;
	// the newline that ends the log is not a line start; count back from the one before it
	for (ssize_t i = n - 2; i >= 0; i--)
		if (rbuf[i] == '\n' && ++seen == BACKLOG)
			return from + i + 1;
	if (from == 0)
		return 0;
	char *nl = memchr(rbuf, '\n', n);  // started mid-line: begin at the next line
	return nl ? from + (nl - rbuf) + 1 : log_size;
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

static void fail(Client *c, int code, const char *msg)
{
	c->olen = snprintf(c->out, OUTMAX,
			   "HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nContent-Length: %zu\r\n"
			   "Connection: close\r\n%s\r\n%s",
			   code, msg, strlen(msg), SEC, msg);
	c->opos = 0;
	c->st = SENDING;
}

// Value of header `name` (lower case, with its colon) in the request, or 0.
static int header(const char *req, const char *name, char *val, size_t cap)
{
	size_t nl = strlen(name);
	for (const char *p = strstr(req, "\r\n"); p; p = strstr(p + 2, "\r\n")) {
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
			return 0;
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
	if (header(c->in, "if-none-match:", inm, sizeof(inm)) && strcmp(inm, etag) == 0) {
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

static void start_stream(Client *c)
{
	char id[32];
	log_refresh();
	long long last = header(c->in, "last-event-id:", id, sizeof(id)) ? atoll(id) : -1;
	c->cur = last >= 0 && last <= log_size ? last : backlog_start();
	c->skip = 0;
	c->guard = -2;
	c->olen = snprintf(c->out, OUTMAX,
			   "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n"
			   "Connection: keep-alive\r\n%s\r\nretry: 1000\r\n\r\n",
			   SEC);
	c->opos = 0;
	c->st = STREAM;
}

static void request(Client *c)
{
	char *eol = strstr(c->in, "\r\n");
	char host[128], path[512];
	int head = strncmp(c->in, "HEAD ", 5) == 0;
	size_t mlen = head ? 5 : 4;
	if (!eol || (!head && strncmp(c->in, "GET ", 4) != 0)) {
		fail(c, 405, "Method not allowed");
		return;
	}
	char *te = memchr(c->in + mlen, ' ', eol - (c->in + mlen));
	size_t tl = te ? (size_t)(te - (c->in + mlen)) : 0;
	if (tl == 0 || tl >= sizeof(path)) {
		fail(c, 400, "Bad request");
		return;
	}
	memcpy(path, c->in + mlen, tl);
	path[tl] = 0;
	char *q = strchr(path, '?');
	if (q)
		*q = 0;
	if (!header(c->in, "host:", host, sizeof(host)) || !loopback_host(host))
		fail(c, 403, "Forbidden");
	else if (strcmp(path, "/events") == 0 && !head)
		start_stream(c);
	else if (!safe_path(path))
		fail(c, 404, "Not found");
	else
		serve_file(c, path, head);
}

// ---- output -----------------------------------------------------------------------

// Frames the next batch of log lines (and daemon state changes) into the output buffer.
static void pump(Client *c, int64_t now)
{
	if (c->opos < c->olen)
		return;  // still sending the last batch
	c->opos = c->olen = 0;
	if (guard >= 0 && guard != c->guard) {
		c->olen += snprintf(c->out, OUTMAX, "event: status\ndata: %s\n\n", guard ? "up" : "down");
		c->guard = guard;
	}
	if (c->cur > log_size)  // truncated
		c->cur = 0, c->skip = 0;
	if (c->cur < log_size && log_fd >= 0) {
		ssize_t n = pread(log_fd, rbuf, CHUNK, c->cur);
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
				if (len && c->olen + len + 48 > OUTMAX)
					break;  // full: the rest goes next time
				if (len) {
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
	if (c->olen == 0 && now - c->last > PING_MS) {
		memcpy(c->out, ": ping\n\n", 8);
		c->olen = 8;
	}
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
		c->inlen = c->olen = c->opos = 0;
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
	proc_dir = env("SID_PROC_DIR", "/proc");
	for (int i = 0; i < MAXC; i++)
		cl[i].fd = -1;

	int lfd = listener(addr, port);
	fprintf(stderr, "sid-web: http://%s:%d  (files %s, events %s)\n", addr, port, root, log_path);
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
			else if (c->st == STREAM && c->cur < log_size)
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
					if (strstr(c->in, "\r\n\r\n"))
						request(c), flush(c, now);
					else if (c->inlen >= INMAX - 1)
						fail(c, 431, "Request too large"), flush(c, now);
				}
			} else if (c->fd >= 0 && (pf[i].revents & (POLLHUP | POLLERR))) {
				drop(c);
			}
		}

		if (streams) {
			log_refresh();
			guard_refresh(now);
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
