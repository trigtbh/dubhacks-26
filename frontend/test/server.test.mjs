// Tests for server/sid-web.c, run with `node --test test/` (or `make test`). No dependencies.
//
// Each test starts its own sid-web on a free port, with its own temp folder (event log,
// decision file, page, fake /proc), and talks to it over raw sockets, so the exact bytes it
// sends are what is checked. The folders live in build/test-run (override with
// SID_TEST_TMP) and are removed afterwards. SID_WEB_BIN runs the suite against another
// binary, such as the ASan build (`make test-asan`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uname = (f) => execFileSync('uname', [f]).toString().trim();
const BIN = process.env.SID_WEB_BIN || path.join(FRONT, 'build', `${uname('-s')}-${uname('-m')}`, 'sid-web');
const TMP = process.env.SID_TEST_TMP || path.join(FRONT, 'build', 'test-run');
if (!process.env.SID_WEB_BIN) execFileSync('make', ['-C', FRONT, 'server'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRoot = process.getuid && process.getuid() === 0;

// ---- a running server ---------------------------------------------------------------

async function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

// Starts sid-web; the returned object has port, paths and stop(). Stopped when `t` ends.
async function serve(t, o = {}) {
	fs.mkdirSync(TMP, { recursive: true });
	const dir = fs.mkdtempSync(path.join(TMP, 'srv-'));
	const log = path.join(dir, 'events.jsonl');
	const dec = o.decisions ?? path.join(dir, 'decisions.jsonl');
	const web = path.join(dir, 'web');
	const proc = path.join(dir, 'proc');
	fs.mkdirSync(web);
	fs.mkdirSync(proc);
	fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>t</title>ok');
	fs.writeFileSync(log, '');
	if (o.decisions === undefined) fs.writeFileSync(dec, '');
	if (o.daemon) {
		fs.mkdirSync(path.join(proc, '123'));
		fs.writeFileSync(path.join(proc, '123', 'comm'), 'sid-daemon\n');
		fs.writeFileSync(path.join(proc, '123', 'status'), 'Name:\tsid-daemon\nUid:\t0\t0\t0\t0\n');
	}
	let child, port, err = '';
	for (let attempt = 0; attempt < 5; attempt++) {
		port = await freePort();
		child = spawn(BIN, [], {
			env: {
				PATH: process.env.PATH,
				SID_WEB_PORT: String(port),
				SID_WEB_ADDR: '127.0.0.1',
				SID_EVENT_LOG: log,
				SID_DECISION_LOG: dec,
				SID_WEB_ROOT: web,
				SID_PROC_DIR: proc,
				ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=0',
				UBSAN_OPTIONS: 'print_stacktrace=1',
			},
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		err = '';
		child.stderr.setEncoding('utf8');
		const up = new Promise((resolve) => {
			child.stderr.on('data', (d) => {
				err += d;
				if (err.includes('sid-web: http://')) resolve(true);
			});
			child.on('exit', () => resolve(false));
		});
		if (await up) break;
	}
	const s = {
		dir, log, dec, port, proc,
		get stderr() { return err; },
		async stop() {
			if (child.exitCode === null && child.signalCode === null) {
				const gone = new Promise((r) => child.on('exit', r));
				child.kill('SIGTERM');
				await gone;
			}
			if (!process.env.SID_TEST_KEEP) fs.rmSync(dir, { recursive: true, force: true });
			assert.doesNotMatch(err, /Sanitizer|runtime error/, 'the sanitizers reported a problem:\n' + err);
		},
	};
	t.after(() => s.stop());
	assert.match(err, /sid-web: http:\/\/127\.0\.0\.1:\d+/, 'the server did not start');
	return s;
}

// ---- writing the log ----------------------------------------------------------------

// The daemon's own layout is compact, but the log may hold either spacing, and `verdict`
// may come before `id`; fmt() writes whichever a test asks for.
function fmt(o, spacing = 'compact') {
	if (typeof o === 'string') return o;
	if (spacing === 'compact') return JSON.stringify(o);
	return '{' + Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + '}';
}
const append = (file, ...lines) => fs.appendFileSync(file, lines.map((l) => fmt(l) + '\n').join(''));
// Fixed times: a test builds the same line twice and compares them
const ev = (id, verdict, extra = {}) => ({ id, time: '2026-01-01T00:00:00.000+00:00', uid: 1000, user: 'u', path: '/bin/x', argv: ['x'], verdict, decided_by: 'model', ...extra });
const q = (id, seq, kind, extra = {}) => ({ q: kind, id, seq, t: 1767225600000 + seq, ...extra });
const hex = (n) => n.toString(16).padStart(12, '0');
const dataOf = (s) => s.frames.filter((f) => f.event === undefined && f.data !== undefined);

// ---- HTTP over a raw socket ---------------------------------------------------------

function parseResponse(buf) {
	const i = buf.indexOf('\r\n\r\n');
	assert.ok(i > 0, 'no response header: ' + JSON.stringify(buf.toString('latin1').slice(0, 200)));
	const head = buf.subarray(0, i).toString('latin1').split('\r\n');
	const m = /^HTTP\/1\.1 (\d+) (.*)$/.exec(head[0]);
	assert.ok(m, 'bad status line ' + head[0]);
	const headers = {};
	for (const l of head.slice(1)) headers[l.slice(0, l.indexOf(':')).toLowerCase()] = l.slice(l.indexOf(':') + 1).trim();
	const body = buf.subarray(i + 4).toString('utf8');
	return { status: +m[1], phrase: m[2], headers, rawHeaders: head.slice(1), body, json: () => JSON.parse(body) };
}

// Sends `data` and returns the parsed answer once the server closes the connection.
function raw(port, data, { timeout = 4000 } = {}) {
	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1');
		const chunks = [];
		let done = false, localPort;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (!chunks.length) return reject(new Error('connection closed with no answer'));
			const res = parseResponse(Buffer.concat(chunks));
			res.localPort = localPort;
			resolve(res);
		};
		const timer = setTimeout(() => {
			sock.destroy();
			if (!done) {
				done = true;
				reject(new Error('no answer in time'));
			}
		}, timeout);
		sock.on('connect', () => {
			localPort = sock.localPort;
			sock.write(data);
		});
		sock.on('data', (d) => chunks.push(d));
		sock.on('error', finish);
		sock.on('close', finish);
	});
}

function http(port, o = {}) {
	const method = o.method ?? 'GET';
	const headers = { Host: `127.0.0.1:${port}`, ...o.headers };
	let body = o.body ?? '';
	if (typeof body !== 'string' && !Buffer.isBuffer(body)) body = JSON.stringify(body);
	if (method === 'POST' && o.length !== false && !('Content-Length' in headers)) headers['Content-Length'] = Buffer.byteLength(body);
	let head = `${method} ${o.path ?? '/'} HTTP/1.1\r\n`;
	for (const [k, v] of Object.entries(headers)) if (v !== undefined) head += `${k}: ${v}\r\n`;
	return raw(port, Buffer.concat([Buffer.from(head + '\r\n', 'latin1'), Buffer.from(body)]));
}

const J = { 'Content-Type': 'application/json', 'X-Sid-Request': '1' };
const post = (port, body, headers, o) => http(port, { method: 'POST', path: '/decide', body, headers: { ...J, ...headers }, ...o });
const decisions = (s) => fs.readFileSync(s.dec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function noCors(res, what) {
	for (const k of Object.keys(res.headers)) assert.ok(!k.startsWith('access-control-'), `${what}: sent ${k}`);
}

// ---- an event-stream client ---------------------------------------------------------

class Sse {
	constructor(sock) {
		this.sock = sock;
		this.buf = '';
		this.head = null;
		this.frames = [];
		this.closed = false;
		this.waiters = [];
	}

	static open(port, { headers = {} } = {}) {
		return new Promise((resolve, reject) => {
			const sock = net.connect(port, '127.0.0.1');
			const s = new Sse(sock);
			s.resolve = resolve;
			sock.setEncoding('utf8');
			sock.on('data', (d) => s.feed(d));
			sock.on('error', () => {});
			sock.on('close', () => {
				s.closed = true;
				s.poke();
				if (!s.head) reject(new Error('closed before the stream began'));
			});
			const h = { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream', ...headers };
			sock.write('GET /events HTTP/1.1\r\n' + Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
		});
	}

	feed(d) {
		this.buf += d;
		if (!this.head) {
			const i = this.buf.indexOf('\r\n\r\n');
			if (i < 0) return;
			this.head = parseResponse(Buffer.from(this.buf.slice(0, i + 4)));
			this.buf = this.buf.slice(i + 4);
			this.resolve(this);
		}
		this.buf = this.buf.replace(/\r\n/g, '\n');  // the server ends `retry` with CRLF, which SSE allows
		for (let i; (i = this.buf.indexOf('\n\n')) >= 0;) {
			const frame = { at: performance.now() };
			for (const line of this.buf.slice(0, i).split('\n')) {
				if (line.startsWith(':')) {
					frame.comment = line.slice(1).trim();
					continue;
				}
				const c = line.indexOf(':');
				const name = c < 0 ? line : line.slice(0, c);
				const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
				frame[name] = name === 'data' && frame.data !== undefined ? frame.data + '\n' + value : value;
			}
			this.buf = this.buf.slice(i + 2);
			this.frames.push(frame);
		}
		this.poke();
	}

	poke() {
		this.waiters = this.waiters.filter((w) => !w());
	}

	waitFor(pred, ms = 3000) {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (!pred(this)) return false;
				clearTimeout(timer);
				resolve();
				return true;
			};
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== check);
				reject(new Error(`timed out; frames so far: ${this.frames.length}, data frames: ${dataOf(this).length}`));
			}, ms);
			if (!check()) this.waiters.push(check);
		});
	}

	get lines() {
		return dataOf(this).map((f) => f.data);
	}
	get objs() {
		return this.lines.map((l) => JSON.parse(l));
	}
	get clocks() {
		return this.frames.filter((f) => f.event === 'clock');
	}
	// Wait until `n` log lines have arrived.
	async lines_(n, ms) {
		await this.waitFor((s) => s.lines.length >= n, ms);
		return this.lines;
	}
	close() {
		this.sock.destroy();
	}
}

// Opens a stream that is closed when the test ends and waits for its first clock frame.
async function watch(t, s, headers) {
	const sse = await Sse.open(s.port, { headers });
	t.after(() => sse.close());
	await sse.waitFor((x) => x.clocks.length > 0);
	return sse;
}

// What a fresh browser is sent: wait for its first clock frame, then give the backlog time
// to arrive and return the data frames.
async function backlog(t, s, headers) {
	const sse = await watch(t, s, headers);
	await sleep(350);
	return sse;
}

// ---- the stream ---------------------------------------------------------------------

test('a stream starts with retry, then a clock frame, then the rest', async (t) => {
	const s = await serve(t);
	const sse = await watch(t, s);
	assert.equal(sse.head.status, 200);
	assert.equal(sse.head.headers['content-type'], 'text/event-stream');
	assert.equal(sse.head.headers['cache-control'], 'no-cache');
	assert.match(sse.head.headers['content-security-policy'], /default-src 'none'/);
	assert.equal(sse.frames[0].retry, '1000');
	assert.equal(sse.frames[1].event, 'clock');
	const clock = JSON.parse(sse.frames[1].data);
	assert.deepEqual(Object.keys(clock), ['now', 'decide']);
	assert.ok(Math.abs(clock.now - Date.now()) < 5000, 'now is epoch milliseconds');
	assert.equal(clock.decide, true);
	assert.deepEqual(dataOf(sse), []);
});

test('the daemon state follows the clock frame', async (t) => {
	const up = await serve(t, { daemon: true });
	const a = await watch(t, up);
	await a.waitFor((x) => x.frames.some((f) => f.event === 'status'));
	assert.equal(a.frames.findIndex((f) => f.event === 'status'), a.frames.findIndex((f) => f.event === 'clock') + 1);
	assert.equal(a.frames.find((f) => f.event === 'status').data, 'up');

	const down = await serve(t);
	const b = await watch(t, down);
	await b.waitFor((x) => x.frames.some((f) => f.event === 'status'));
	assert.equal(b.frames.find((f) => f.event === 'status').data, 'down');
});

test('a new line arrives within about 150 ms', async (t) => {
	const s = await serve(t);
	const sse = await watch(t, s);
	const took = [];
	for (let i = 0; i < 4; i++) {
		const t0 = performance.now();
		append(s.log, ev(hex(i), 'block'));
		await sse.waitFor((x) => x.lines.length === i + 1);
		took.push(sse.frames.filter((f) => f.id !== undefined).at(-1).at - t0);
		await sleep(80);
	}
	assert.ok(Math.min(...took) < 150, `best of four took ${Math.min(...took).toFixed(0)} ms (${took.map((x) => x.toFixed(0))})`);
});

test('a frame carries the line verbatim and the offset after it', async (t) => {
	const s = await serve(t);
	const lines = [fmt(ev(hex(1), 'block')), fmt(ev(hex(2), 'block'), 'spaced')];
	append(s.log, ...lines);
	const sse = await backlog(t, s);
	assert.deepEqual(sse.lines, lines);
	const ids = dataOf(sse).map((f) => +f.id);
	assert.equal(ids[0], Buffer.byteLength(lines[0]) + 1);
	assert.equal(ids[1], fs.statSync(s.log).size);
});

test('allowed lines are dropped unless they settle a held command', async (t) => {
	const s = await serve(t);
	const [a1, b1, h1, a2, h2, a3] = [1, 2, 3, 4, 5, 6].map(hex);
	const settle1 = ev(h1, 'allow', { decided_by: 'person', reason: 'approved' });
	const settle2 = ev(h2, 'block', { decided_by: 'timeout' });
	const keep = [ev(b1, 'block'), ev(h1, 'hold'), settle1, ev(h2, 'hold'), settle2].map((o) => fmt(o));
	append(s.log, ev(a1, 'allow'), ev(b1, 'block'), ev(h1, 'hold'), ev(a2, 'allow'), settle1, ev(h2, 'hold'), settle2, ev(a3, 'allow'), '{"verdict":"allow"}');

	const fresh = await backlog(t, s);
	assert.deepEqual(fresh.lines, keep, 'fresh connect');

	const live = await watch(t, s);
	const [a4, b2, h3, a5] = [7, 8, 9, 10].map(hex);
	append(s.log, ev(a4, 'allow'), ev(b2, 'block'), ev(h3, 'hold'), ev(a5, 'allow'), ev(h3, 'allow', { decided_by: 'person' }));
	await live.lines_(keep.length + 3);
	await sleep(200);
	assert.deepEqual(live.objs.slice(keep.length).map((o) => [o.id, o.verdict]), [[b2, 'block'], [h3, 'hold'], [h3, 'allow']]);
	assert.equal(live.lines.length, keep.length + 3);
});

test('lines with neither a verdict nor a q still pass', async (t) => {
	const s = await serve(t);
	append(s.log, '{"note":"hello"}', 'not json at all', ev(hex(1), 'block'));
	const sse = await backlog(t, s);
	assert.deepEqual(sse.lines, ['{"note":"hello"}', 'not json at all', fmt(ev(hex(1), 'block'))]);
});

test('quarantine lines pass only for held commands', async (t) => {
	const s = await serve(t);
	const [h, other, blocked] = [1, 2, 3].map(hex);
	const kept = [
		ev(h, 'hold'),
		q(h, 1, 'start', { duration_ms: 3000, ends_at: Date.now() + 3000 }),
		q(h, 2, 'out', { stream: 'stdout', data: 'hi\n' }),
		q(h, 3, 'file', { op: 'create', path: '/tmp/x' }),
		q(h, 4, 'end', { how: 'exit', code: 0 }),
	].map((o) => fmt(o));
	append(s.log, q(other, 1, 'start'), ev(blocked, 'block'), q(blocked, 1, 'start'), kept[0], q(other, 1, 'out'), kept[1], q(blocked, 2, 'out'), kept[2], kept[3], q(other, 2, 'end'), kept[4]);
	const fresh = await backlog(t, s);
	assert.deepEqual(fresh.lines, [fmt(ev(blocked, 'block')), ...kept]);

	const live = await watch(t, s);
	await live.lines_(fresh.lines.length);
	const h2 = hex(9), n0 = live.lines.length;
	append(s.log, ev(h2, 'hold'), q(h2, 1, 'start'), q(hex(10), 1, 'out'), q(h2, 2, 'end'));
	await live.lines_(n0 + 3);
	await sleep(200);
	const added = live.objs.slice(n0);
	assert.deepEqual(added.map((o) => o.q ?? o.verdict), ['hold', 'start', 'end']);
	assert.ok(added.every((o) => o.id === h2));
});

test('both JSON layouts work, and `verdict` may come before `id`', async (t) => {
	const s = await serve(t);
	const lines = [
		'{"verdict": "block", "id": "sp0000000001", "argv": ["x"]}',
		'{"id": "hp0000000001", "verdict": "hold"}',
		'{"q": "start", "id": "hp0000000001", "seq": 1}',
		'{"verdict":"allow","id":"hp0000000001"}',
		'{"verdict":"hold","id":"hv0000000001"}',
		'{"q":"start","verdict":"x","id":"hv0000000001"}',
		'{"verdict": "allow", "id": "hv0000000001"}',
	];
	const dropped = ['{"verdict": "allow", "id": "xx0000000001"}', '{"verdict":"allow","id": "xx0000000002"}', '{"q": "out", "id": "xx0000000003"}', '{"id": "xx0000000004", "q": "end"}'];
	append(s.log, lines[0], dropped[0], lines[1], dropped[2], lines[2], lines[3], dropped[1], lines[4], lines[5], dropped[3], lines[6]);
	assert.deepEqual((await backlog(t, s)).lines, lines, 'fresh connect');

	const live = await watch(t, s);
	await live.lines_(lines.length);
	const more = lines.map((l) => l.replaceAll('0000000001', '0000000009'));
	append(s.log, ...more.slice(0, 1), dropped[0], ...more.slice(1));
	await live.lines_(lines.length * 2);
	await sleep(150);
	assert.deepEqual(live.lines.slice(lines.length), more, 'live');
});

test('quotes inside a value cannot forge a key', async (t) => {
	const s = await serve(t);
	const a = JSON.stringify({ id: hex(1), argv: ['echo', '"verdict":"allow"', '"q":"start"'], verdict: 'block' });
	const b = JSON.stringify({ id: hex(2), reason: '"id":"' + hex(3) + '","verdict":"allow"', verdict: 'block' });
	const c = JSON.stringify({ id: hex(4), context: 'x\n"q": "end"', verdict: 'hold' });
	append(s.log, a, b, c);
	assert.deepEqual((await backlog(t, s)).lines, [a, b, c]);
});

test('2500 blocked commands: a new browser gets exactly the last 1000', async (t) => {
	const s = await serve(t);
	const lines = Array.from({ length: 2500 }, (_, i) => fmt(ev(hex(i), 'block')));
	fs.appendFileSync(s.log, lines.join('\n') + '\n');
	const sse = await watch(t, s);
	await sse.lines_(1000, 5000);
	await sleep(400);
	assert.equal(sse.lines.length, 1000);
	assert.deepEqual(sse.lines, lines.slice(1500));
	const ids = dataOf(sse).map((f) => +f.id);
	assert.ok(ids.every((n, i) => i === 0 || n > ids[i - 1]), 'offsets increase');
});

test('quarantine lines do not count toward the 1000', async (t) => {
	const s = await serve(t);
	const h = hex(0xabc);
	const lines = Array.from({ length: 1500 }, (_, i) => fmt(ev(hex(i), 'block')));
	const hold = fmt(ev(h, 'hold'));
	lines.push(hold, fmt(q(h, 1, 'start')));
	for (let i = 0; i < 100; i++) lines.push(fmt(q(h, i + 2, 'out', { stream: 'stdout', data: 'x' })), fmt(ev(hex(5000 + i), 'block')));
	lines.push(fmt(q(h, 102, 'end')));
	fs.appendFileSync(s.log, lines.join('\n') + '\n');
	const sse = await backlog(t, s);
	// 100 blocks + the hold + 899 earlier blocks are the last 1000 primary lines; every
	// quarantine line after them comes along
	const first = lines.indexOf(fmt(ev(hex(601), 'block')));
	assert.deepEqual(sse.lines, lines.slice(first));
	assert.equal(sse.objs.filter((o) => o.q === undefined).length, 1000);
	assert.equal(sse.objs.filter((o) => o.q !== undefined).length, 102);
});

test('resuming with Last-Event-ID loses nothing and repeats nothing', async (t) => {
	const s = await serve(t);
	const lines = Array.from({ length: 10 }, (_, i) => fmt(ev(hex(i), 'block')));
	append(s.log, ...lines);
	const first = await backlog(t, s);
	assert.deepEqual(first.lines, lines);
	const lastId = dataOf(first).at(-1).id;
	const midId = dataOf(first)[4].id;
	first.close();

	const more = Array.from({ length: 5 }, (_, i) => fmt(ev(hex(100 + i), 'block')));
	append(s.log, ...more);
	const again = await backlog(t, s, { 'Last-Event-ID': lastId });
	assert.deepEqual(again.lines, more);
	const mid = await backlog(t, s, { 'Last-Event-ID': midId });
	assert.deepEqual(mid.lines, [...lines.slice(5), ...more]);

	// still in step afterwards
	append(s.log, ev(hex(200), 'block'));
	await again.lines_(6);
	assert.equal(again.lines.length, 6);
	assert.equal(JSON.parse(again.lines[5]).id, hex(200));
	assert.equal(dataOf(again).at(-1).id, String(fs.statSync(s.log).size));

	// an offset in the middle of a line, or past the end, is not a place to resume from
	for (const bad of ['7', String(fs.statSync(s.log).size + 500), 'x', '-3']) {
		const sse = await backlog(t, s, { 'Last-Event-ID': bad });
		assert.deepEqual(sse.lines.slice(0, 3), lines.slice(0, 3), `Last-Event-ID ${bad} starts from the backlog`);
		for (const l of sse.lines) JSON.parse(l);
	}
});

test('a line of 300 KB is skipped and the stream goes on', async (t) => {
	const s = await serve(t);
	const big = (n, id) => fmt(ev(id, 'block', { argv: ['x'.repeat(n)] }));
	const [a, b, c, d] = [fmt(ev(hex(1), 'block')), fmt(ev(hex(2), 'block')), fmt(ev(hex(3), 'hold')), fmt(ev(hex(3), 'allow', { decided_by: 'person' }))];
	append(s.log, a, big(300000, hex(9)), b);
	const fresh = await backlog(t, s);
	assert.deepEqual(fresh.lines, [a, b]);

	const live = await watch(t, s);
	await live.lines_(2);
	append(s.log, big(300000, hex(10)));
	await sleep(300);
	append(s.log, c, big(1000000, hex(11)), d, a);
	await live.lines_(5);
	await sleep(300);
	assert.deepEqual(live.lines, [a, b, c, d, a], 'the table still works after a huge line');
	assert.ok(live.lines.every((l) => l.length < 1000));
});

test('lines just under 256 KiB pass and just over do not', async (t) => {
	const s = await serve(t);
	const under = (n) => {
		const base = fmt(ev(hex(n), 'block', { argv: [''] }));
		return fmt(ev(hex(n), 'block', { argv: ['x'.repeat(n === 1 ? 200000 : 256 * 1024 - 1 - base.length)] }));
	};
	const l1 = under(1), l2 = under(2);
	assert.equal(l2.length, 256 * 1024 - 1);
	const over = fmt(ev(hex(3), 'block', { argv: ['x'.repeat(256 * 1024 + 10)] }));
	append(s.log, l1, over, l2, ev(hex(4), 'block'));
	const sse = await backlog(t, s);
	assert.deepEqual(sse.lines, [l1, l2, fmt(ev(hex(4), 'block'))]);
});

test('rotating the log forgets the old holds and restarts browsers at the top', async (t) => {
	const s = await serve(t);
	const h = hex(1);
	append(s.log, ev(h, 'hold'), ...Array.from({ length: 20 }, (_, i) => ev(hex(100 + i), 'block')));
	const sse = await watch(t, s);
	await sse.lines_(21);

	fs.renameSync(s.log, s.log + '.1');
	append(s.log, ev(hex(300), 'block'));
	await sse.lines_(22);
	assert.equal(JSON.parse(sse.lines[21]).id, hex(300));

	const h2 = hex(2);
	append(s.log, ev(h, 'allow', { decided_by: 'person' }), ev(h2, 'hold'), ev(h2, 'allow', { decided_by: 'person' }));
	await sse.lines_(24);
	await sleep(200);
	assert.deepEqual(sse.objs.slice(22).map((o) => [o.id, o.verdict]), [[h2, 'hold'], [h2, 'allow']], 'the old hold is no longer known');

	const fresh = await backlog(t, s);
	assert.deepEqual(fresh.objs.map((o) => o.id), [hex(300), h2, h2]);
	assert.equal((await post(s.port, { id: h, verdict: 'allow' })).status, 404, 'nor can it be decided');
	assert.equal((await post(s.port, { id: h2, verdict: 'allow' })).status, 409);
});

test('truncating the log in place forgets the old holds too', async (t) => {
	const s = await serve(t);
	const h = hex(1);
	append(s.log, ev(h, 'hold'), ...Array.from({ length: 30 }, (_, i) => ev(hex(100 + i), 'block')));
	const sse = await watch(t, s);
	await sse.lines_(31);

	fs.truncateSync(s.log, 0);
	append(s.log, ev(hex(300), 'block'));
	await sse.lines_(32);
	assert.equal(JSON.parse(sse.lines[31]).id, hex(300));

	const h2 = hex(2);
	append(s.log, ev(h, 'allow', { decided_by: 'person' }), ev(h2, 'hold'), q(h2, 1, 'start'), ev(h2, 'allow', { decided_by: 'person' }));
	await sse.lines_(35);
	await sleep(200);
	assert.deepEqual(sse.objs.slice(32).map((o) => o.q ?? o.verdict), ['hold', 'start', 'allow']);

	const fresh = await backlog(t, s);
	assert.deepEqual(fresh.objs.map((o) => o.q ?? o.verdict), ['block', 'hold', 'start', 'allow']);
	assert.equal((await post(s.port, { id: h, verdict: 'allow' })).status, 404);
});

test('a browser that connects mid-quarantine gets the hold and every q line so far', async (t) => {
	const s = await serve(t);
	const h = hex(0x77);
	const first = await watch(t, s);
	append(s.log, ev(hex(1), 'block'), ev(h, 'hold'), q(h, 1, 'start', { duration_ms: 30000, ends_at: Date.now() + 30000 }));
	for (let i = 2; i <= 6; i++) append(s.log, q(h, i, i % 2 ? 'file' : 'out', i % 2 ? { op: 'create', path: '/tmp/f' + i } : { stream: 'stdout', data: 'line ' + i }));
	await first.lines_(8);

	const late = await backlog(t, s);
	const mine = late.objs.filter((o) => o.id === h);
	assert.equal(mine[0].verdict, 'hold');
	assert.deepEqual(mine.slice(1).map((o) => o.seq), [1, 2, 3, 4, 5, 6]);
	assert.equal(mine[1].q, 'start');

	append(s.log, q(h, 7, 'out', { stream: 'stderr', data: 'more' }), q(h, 8, 'end', { how: 'exit', code: 0 }));
	await late.lines_(late.lines.length + 2);
	await first.lines_(10);
	for (const c of [first, late]) {
		const seqs = c.objs.filter((o) => o.id === h && o.q).map((o) => o.seq);
		assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8]);
	}
});

test('the table keeps recent holds, forgets old ones, and never fills up', async (t) => {
	const s = await serve(t);
	const holds = Array.from({ length: 5000 }, (_, i) => fmt(ev(hex(i), 'hold')));
	fs.appendFileSync(s.log, holds.join('\n') + '\n');
	const sse = await watch(t, s);
	await sse.lines_(1000, 5000);
	assert.deepEqual(sse.lines, holds.slice(4000));
	append(s.log, ev(hex(10), 'allow', { decided_by: 'person' }), ev(hex(3500), 'allow', { decided_by: 'person' }), ev(hex(4999), 'allow', { decided_by: 'person' }));
	await sse.lines_(1002);
	await sleep(200);
	assert.deepEqual(sse.objs.slice(1000).map((o) => o.id), [hex(3500), hex(4999)]);
	assert.equal((await post(s.port, { id: hex(10), verdict: 'allow' })).status, 404);
	assert.equal((await post(s.port, { id: hex(4000), verdict: 'block' })).status, 202);

	// fewer holds than one generation: all of them are kept
	const small = await serve(t);
	fs.appendFileSync(small.log, Array.from({ length: 1100 }, (_, i) => fmt(ev(hex(i), 'hold'))).join('\n') + '\n');
	assert.equal((await post(small.port, { id: hex(0), verdict: 'allow' })).status, 202);
	assert.equal((await post(small.port, { id: hex(1099), verdict: 'allow' })).status, 202);
});

// ---- POST /decide -------------------------------------------------------------------

test('POST /decide appends one line and answers 202', async (t) => {
	const s = await serve(t);
	const [h1, h2, h3, h4, h5] = [1, 2, 3, 4, 5].map(hex);
	append(s.log, ev(h1, 'hold'), ev(h2, 'hold'), ev(h3, 'hold'), q(h3, 1, 'start'), q(h3, 2, 'end', { how: 'exit' }), '{"verdict": "hold", "id": "' + h4 + '"}', ev(h5, 'hold'));
	const before = Date.now();
	const res = await post(s.port, { id: h1, verdict: 'allow' });
	assert.equal(res.status, 202);
	assert.equal(res.phrase, 'Accepted');
	assert.deepEqual(res.json(), { ok: true, queued: true, id: h1, verdict: 'allow' });
	assert.equal(res.headers['content-type'], 'application/json');
	assert.equal(res.headers['cache-control'], 'no-store');
	assert.match(res.headers['content-security-policy'], /default-src 'none'/);
	assert.equal(res.headers['connection'], 'close');
	noCors(res, '202');

	const [d] = decisions(s);
	assert.deepEqual(Object.keys(d), ['v', 'id', 'verdict', 't', 'peer']);
	assert.equal(d.v, 1);
	assert.equal(d.id, h1);
	assert.equal(d.verdict, 'allow');
	assert.ok(d.t >= before && d.t <= Date.now() + 1, 't is epoch milliseconds');
	assert.equal(d.peer, `127.0.0.1:${res.localPort}`);
	assert.ok(fs.readFileSync(s.dec, 'utf8').endsWith('}\n'));

	// block; a charset; both origin signals a browser sends; a mixed-case Origin; a hold whose quarantine ended;
	// a hold written with spaces and `verdict` first; none of the browser signals (curl)
	const same = { Origin: `http://127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin' };
	const ok = [
		[{ id: h2, verdict: 'block' }, { 'Content-Type': 'application/json; charset=utf-8' }],
		[{ id: h3, verdict: 'allow' }, same],
		[{ id: h4, verdict: 'block' }, { Origin: `HTTP://127.0.0.1:${s.port}`, Host: `127.0.0.1:${s.port}` }],
		[{ id: h5, verdict: 'allow' }, { 'Content-Type': 'Application/JSON' }],
	];
	for (const [body, headers] of ok) {
		const r = await post(s.port, body, headers);
		assert.equal(r.status, 202, JSON.stringify([body, headers, r.body]));
		noCors(r, 'ok');
	}
	assert.deepEqual(decisions(s).map((x) => [x.id, x.verdict]), [[h1, 'allow'], [h2, 'block'], [h3, 'allow'], [h4, 'block'], [h5, 'allow']]);

	// localhost and [::1] as the Host, with the matching Origin
	const h6 = hex(6);
	append(s.log, ev(h6, 'hold'));
	const r6 = await post(s.port, { id: h6, verdict: 'allow' }, { Host: `LocalHost:${s.port}`, Origin: `http://localhost:${s.port}` });
	assert.equal(r6.status, 202);
});

test('a decision for a hold written a moment ago is accepted, and the body may arrive in pieces', async (t) => {
	const s = await serve(t);
	const h = hex(1);
	append(s.log, ev(h, 'hold'));
	const body = JSON.stringify({ id: h, verdict: 'block' });
	const head = `POST /decide HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nX-Sid-Request: 1\r\nContent-Length: ${body.length}\r\n\r\n`;
	const res = await new Promise((resolve, reject) => {
		const sock = net.connect(s.port, '127.0.0.1');
		const chunks = [];
		sock.on('data', (d) => chunks.push(d));
		sock.on('close', () => resolve(parseResponse(Buffer.concat(chunks))));
		sock.on('error', reject);
		sock.write(head.slice(0, 40));
		setTimeout(() => sock.write(head.slice(40) + body.slice(0, 7)), 100);
		setTimeout(() => sock.write(body.slice(7)), 250);
	});
	assert.equal(res.status, 202);
	assert.deepEqual(decisions(s).map((x) => [x.id, x.verdict]), [[h, 'block']]);
});

test('a body of exactly 512 bytes is accepted', async (t) => {
	const s = await serve(t);
	const h = hex(1);
	append(s.log, ev(h, 'hold'));
	const base = JSON.stringify({ id: h, verdict: 'allow' });
	const body = base + ' '.repeat(512 - base.length);
	assert.equal(Buffer.byteLength(body), 512);
	assert.equal((await post(s.port, body)).status, 202);
});

test('POST /decide refuses everything that is not exactly right', async (t) => {
	const s = await serve(t);
	const [held, settled, blockSettled, other] = [1, 2, 3, 4].map(hex);
	append(s.log, ev(held, 'hold'), ev(settled, 'hold'), ev(settled, 'allow', { decided_by: 'person' }), ev(blockSettled, 'hold'), ev(blockSettled, 'block', { decided_by: 'timeout' }), ev(other, 'hold'));
	const good = { id: held, verdict: 'allow' };
	const port = s.port;
	const origin = `http://127.0.0.1:${port}`;
	const cases = [];
	const expect = (status, name, headers, body = good, o = {}) => cases.push({ status, name, headers, body, o });

	// the Host is checked first, for every method, and before anything about the body
	for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1.evil.example', 'localhost.evil.com', 'localhost:abc', '[::1', '127.0.0.1:', ' ', '0.0.0.0', undefined])
		expect(403, `Host ${host}`, { Host: host });
	expect(403, 'bad Host and bad type', { Host: 'evil.example', 'Content-Type': 'text/plain' });

	for (const ct of ['text/plain', 'application/jsonx', 'application/json5', 'text/plain; application/json', 'application/json; charset=latin1', 'application/json; boundary=x', 'multipart/form-data', 'application/x-www-form-urlencoded', '', undefined])
		expect(415, `Content-Type ${ct}`, { 'Content-Type': ct });
	for (const v of ['0', 'true', 'yes', '11', ' ', undefined]) expect(403, `X-Sid-Request ${v}`, { 'X-Sid-Request': v });
	expect(415, 'type is checked before the custom header', { 'Content-Type': 'text/plain', 'X-Sid-Request': undefined });

	for (const o of ['http://evil.example', 'null', 'http://127.0.0.1:1', `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}.evil.example`, `http://localhost:${port}`, origin + '/', '', 'x'.repeat(300)])
		expect(403, `Origin ${o.slice(0, 40)}`, { Origin: o });
	for (const v of ['cross-site', 'same-site', 'none', 'Same-Origin', '', 'x'.repeat(100)]) expect(403, `Sec-Fetch-Site ${v.slice(0, 20)}`, { 'Sec-Fetch-Site': v });
	expect(403, 'right Origin, wrong Sec-Fetch-Site', { Origin: origin, 'Sec-Fetch-Site': 'cross-site' });
	expect(403, 'wrong Origin, right Sec-Fetch-Site', { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'same-origin' });

	for (const b of ['', 'not json', '{', '[]', 'null', '"x"', '{}', '{"id":"abc"}', '{"verdict":"allow"}', `{"id":1,"verdict":"allow"}`, `{"id":"${held}","verdict":true}`, `{"id":"${held}","verdict":"allow"`, `{"id":"${held}","verdict":"allow"}x`])
		expect(400, `body ${b.slice(0, 40)}`, {}, b);
	for (const v of ['hold', 'ALLOW', 'Block', '', 'allow ', 'allowed', 'deny', 'allow\\n', 'al\\u006cow', 'all', 'blocked'])
		expect(400, `verdict ${v}`, {}, `{"id":"${held}","verdict":"${v}"}`);
	for (const i of ['', 'a'.repeat(33), 'a b', '../x', 'a\\"b', 'é', 'a/b', 'a.b', 'a:b', 'a\\u0041', 'a\\\\b', 'a\nb'.replace('\n', '\\n'), 'a%41'])
		expect(400, `id ${i}`, {}, `{"id":"${i}","verdict":"allow"}`);
	expect(400, 'a NUL in the id', {}, `{"id":"a\u0000b","verdict":"allow"}`);

	expect(404, 'unknown id', {}, { id: hex(999), verdict: 'allow' });
	expect(404, 'longest id', {}, { id: 'a'.repeat(32), verdict: 'block' });
	expect(404, 'underscore and hyphen are fine', {}, { id: 'a_b-C9', verdict: 'block' });
	expect(409, 'settled by allow, same verdict', {}, { id: settled, verdict: 'allow' });
	expect(409, 'settled by allow, other verdict', {}, { id: settled, verdict: 'block' });
	expect(409, 'settled by block', {}, { id: blockSettled, verdict: 'allow' });

	for (const c of cases) {
		const res = await post(port, c.body, c.headers, c.o);
		assert.equal(res.status, c.status, `${c.name}: ${res.status} ${res.body}`);
		noCors(res, c.name);
		assert.equal(res.headers['cache-control'], 'no-store', c.name);
		assert.match(res.headers['content-security-policy'], /default-src 'none'/, c.name);
		if (c.status !== 403 || !('Host' in c.headers)) assert.equal(res.headers['content-type'], 'application/json', c.name);
	}
	assert.deepEqual(decisions(s), [], 'none of them was recorded');

	// framing
	const framing = [
		[413, '513 bytes', { body: JSON.stringify({ id: held, verdict: 'allow' }) + ' '.repeat(513) }],
		[413, 'huge Content-Length, no body', { body: '', headers: { 'Content-Length': '99999999' } }],
		[413, 'a Content-Length of 20 digits', { body: '', headers: { 'Content-Length': '1'.repeat(20) } }],
		[413, 'headers plus body do not fit', { body: ' '.repeat(500), headers: { 'X-Pad': 'p'.repeat(7800) } }],
		[411, 'no Content-Length', { body: '', length: false }],
		[400, 'chunked', { body: '1b\r\n{"id":"x","verdict":"allow"}\r\n0\r\n\r\n', length: false, headers: { 'Transfer-Encoding': 'chunked' } }],
		[400, 'chunked and a length', { body: '{}', headers: { 'Transfer-Encoding': 'chunked' } }],
		[400, 'Transfer-Encoding: identity', { body: '{}', headers: { 'Transfer-Encoding': 'identity' } }],
		[400, 'Content-Length: abc', { body: '{}', headers: { 'Content-Length': 'abc' } }],
		[400, 'Content-Length: -1', { body: '{}', headers: { 'Content-Length': '-1' } }],
		[400, 'Content-Length: 12abc', { body: '{}', headers: { 'Content-Length': '12abc' } }],
		[400, 'Content-Length: 1.5', { body: '{}', headers: { 'Content-Length': '1.5' } }],
		[400, 'Content-Length: empty', { body: '{}', headers: { 'Content-Length': '' } }],
	];
	for (const [status, name, o] of framing) {
		const res = await post(port, o.body, o.headers, { length: o.length });
		assert.equal(res.status, status, `${name}: ${res.status} ${res.body}`);
		noCors(res, name);
	}

	// methods
	for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH', 'TRACE', 'CONNECT']) {
		const res = await http(port, { method, path: '/decide', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-sid-request' } });
		assert.equal(res.status, 405, method);
		assert.equal(res.headers.allow, 'POST', method);
		noCors(res, method);
		assert.equal(res.headers['cache-control'], 'no-store', method);
	}
	for (const path of ['/decide?x=1', '/decide?']) assert.equal((await http(port, { path })).status, 405, path);
	for (const [method, path] of [['POST', '/'], ['POST', '/events'], ['POST', '/decide/'], ['POST', '/Decide'], ['OPTIONS', '/'], ['PUT', '/index.html']]) {
		const res = await http(port, { method, path, body: '{}', headers: J });
		assert.equal(res.status, 405, method + ' ' + path);
		assert.equal(res.headers.allow, 'GET, HEAD');
		noCors(res, path);
	}
	assert.equal((await http(port, { method: 'OPTIONS', path: '/decide', headers: { Host: 'evil.example' } })).status, 403, 'Host before method');
	assert.equal((await http(port, { method: 'GET', path: '/decide', headers: { Host: 'evil.example' } })).status, 403);
	assert.equal((await http(port, { method: 'POST', path: '/other', headers: { Host: 'evil.example' }, body: '{}' })).status, 403);
	assert.deepEqual(decisions(s), []);

	// a decision made twice: once on disk, and only the first verdict stands
	const first = await post(port, { id: other, verdict: 'allow' });
	assert.equal(first.status, 202);
	assert.equal(first.json().duplicate, undefined);
	const again = await post(port, { id: other, verdict: 'allow' });
	assert.equal(again.status, 202);
	assert.deepEqual(again.json(), { ok: true, queued: true, duplicate: true, id: other, verdict: 'allow' });
	const conflict = await post(port, { id: other, verdict: 'block' });
	assert.equal(conflict.status, 409);
	assert.equal(conflict.headers['cache-control'], 'no-store');
	assert.deepEqual(decisions(s).map((x) => [x.id, x.verdict]), [[other, 'allow']]);
	assert.equal((await post(port, { id: other, verdict: 'allow' })).json().duplicate, true);

	// once the daemon's settle line is in the log, it is settled
	append(s.log, ev(other, 'allow', { decided_by: 'person' }));
	assert.equal((await post(port, { id: other, verdict: 'allow' })).status, 409);
	assert.equal(decisions(s).length, 1);
});

test('a Host or Origin hidden in the body is never read as a header', async (t) => {
	const s = await serve(t);
	const h = hex(1);
	append(s.log, ev(h, 'hold'));
	const body = JSON.stringify({ id: h, verdict: 'allow' });
	const forged = `${body}\r\nHost: localhost\r\n`;
	const noHost = (b, extra = '') => `POST /decide HTTP/1.1\r\nContent-Type: application/json\r\nX-Sid-Request: 1\r\n${extra}Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`;
	let res = await raw(s.port, noHost(forged));
	assert.equal(res.status, 403, 'body with a forged Host, no real Host');
	res = await raw(s.port, noHost(`{"x":"\r\n\r\nHost: 127.0.0.1\r\n\r\n"}`));
	assert.equal(res.status, 403);
	res = await raw(s.port, 'GET /events HTTP/1.1\r\nAccept: */*\r\n\r\nHost: localhost\r\n\r\n');
	assert.equal(res.status, 403, 'GET with a Host after the blank line');
	res = await raw(s.port, 'GET / HTTP/1.1\r\n\r\nHost: localhost\r\n\r\n');
	assert.equal(res.status, 403, 'GET with no headers at all');
	res = await raw(s.port, `GET / HTTP/1.1\r\nHost: evil.example\r\n\r\nHost: localhost\r\n\r\n`);
	assert.equal(res.status, 403, 'a bad Host, then a good one in the body');
	assert.deepEqual(decisions(s), []);

	// the real header wins over text in the body, in both directions
	const sneaky = `{"id":"${h}","verdict":"allow"\r\nOrigin: http://evil.example\r\n}`;  // loose JSON, but still accepted
	const withHost = `POST /decide HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nX-Sid-Request: 1\r\nContent-Length: ${Buffer.byteLength(sneaky)}\r\n\r\n${sneaky}`;
	assert.equal((await raw(s.port, withHost)).status, 202, 'an Origin in the body does not count');
	assert.equal(decisions(s).length, 1);

	// a one-character line before the Host used to hide it from the header scan
	res = await raw(s.port, `GET / HTTP/1.1\r\nX\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
	assert.equal(res.status, 200);
	const h2 = hex(2);
	append(s.log, ev(h2, 'hold'));
	res = await raw(s.port, `POST /decide HTTP/1.1\r\nY\r\nHost: 127.0.0.1:${s.port}\r\nZ\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\nX-Sid-Request: 1\r\nContent-Length: ${body.length}\r\n\r\n${JSON.stringify({ id: h2, verdict: 'allow' })}`);
	assert.equal(res.status, 403, 'short lines do not hide an Origin');
});

test('malformed requests', async (t) => {
	const s = await serve(t);
	const host = `Host: 127.0.0.1:${s.port}\r\n`;
	assert.equal((await raw(s.port, `GET / HTTP/1.1\r\nX: a\u0000b\r\n${host}\r\n`.replace('\u0000', '\u0000'))).status, 400, 'NUL in the headers');
	assert.equal((await raw(s.port, `GET / HTTP/1.1\r\n${host}X: a\u0000b\r\nOrigin: evil\r\n\r\n`)).status, 400);
	assert.equal((await raw(s.port, `GET\r\n${host}\r\n`)).status, 400, 'no target');
	assert.equal((await raw(s.port, `GET /\r\n${host}\r\n`)).status, 400, 'no version');
	assert.equal((await raw(s.port, `\r\n${host}\r\n`)).status, 400, 'no request line');
	assert.equal((await raw(s.port, `GET /${'a'.repeat(600)} HTTP/1.1\r\n${host}\r\n`)).status, 400, 'target too long');
	assert.equal((await raw(s.port, `GET / HTTP/1.1\r\n${host}X-Pad: ${'p'.repeat(9000)}\r\n\r\n`)).status, 431, 'headers too large');
	assert.equal((await raw(s.port, `GET / HTTP/1.1\r\nHost: ${'a'.repeat(200)}\r\n\r\n`)).status, 403, 'Host too long');
	assert.equal((await raw(s.port, `GET / HTTP/1.1\r\nX: y\r\n\r\n`)).status, 403, 'no Host');
	// the server is fine afterwards
	assert.equal((await http(s.port, { path: '/' })).status, 200);
});

test('files: the page, caching, and what is not served', async (t) => {
	const s = await serve(t);
	const res = await http(s.port, { path: '/' });
	assert.equal(res.status, 200);
	assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
	assert.equal(res.headers['cache-control'], 'no-cache');
	assert.equal(res.headers['x-content-type-options'], 'nosniff');
	assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
	assert.equal(res.headers['referrer-policy'], 'no-referrer');
	assert.match(res.headers['content-security-policy'], /form-action 'none'; frame-ancestors 'none'/);
	assert.match(res.body, /ok$/);
	noCors(res, 'index');
	assert.equal((await http(s.port, { path: '/index.html' })).body, res.body);
	const cached = await http(s.port, { path: '/', headers: { 'If-None-Match': res.headers.etag } });
	assert.equal(cached.status, 304);
	assert.equal(cached.body, '');
	assert.equal((await http(s.port, { path: '/', headers: { 'If-None-Match': 'x'.repeat(300) } })).status, 200, 'a long ETag is not a match');
	const head = await http(s.port, { method: 'HEAD', path: '/' });
	assert.equal(head.status, 200);
	assert.equal(head.body, '');
	assert.equal(head.headers['content-length'], String(Buffer.byteLength(res.body)));
	const missing = await http(s.port, { path: '/nope.js' });
	assert.equal(missing.status, 404);
	assert.equal(missing.headers['cache-control'], 'no-store');
	for (const p of ['/../x', '/a/../x', '/a//b', '/%2e%2e/x', '/a b', '/.%2e/x', '/events.json']) assert.equal((await http(s.port, { path: p })).status, 404, p);
	assert.equal((await http(s.port, { path: '/', headers: { Host: 'evil.example' } })).status, 403);
	assert.equal((await http(s.port, { path: '/events', headers: { Host: 'evil.example' } })).status, 403);
	assert.equal((await http(s.port, { method: 'HEAD', path: '/events' })).status, 404, 'HEAD /events is not a stream');
});

test('when decisions cannot be written: 503, and the clock says decide:false', async (t) => {
	fs.mkdirSync(TMP, { recursive: true });
	const extra = fs.mkdtempSync(path.join(TMP, 'extra-'));  // paths of our own for the decision file
	t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
	const missingDir = (await serve(t, { decisions: path.join(extra, 'no-such-dir', 'decisions.jsonl') }));
	const cases = [{ name: 'a folder that does not exist', s: missingDir, decide: false }];

	const dirAsFile = await serve(t, { decisions: path.join(extra, 'a-directory') });
	fs.mkdirSync(path.join(extra, 'a-directory'), { recursive: true });
	cases.push({ name: 'a directory', s: dirAsFile, decide: true });

	const full = await serve(t);
	fs.truncateSync(full.dec, 8 * 1024 * 1024 + 1);
	cases.push({ name: 'a file over 8 MiB', s: full, decide: true });

	if (!isRoot) {
		const ro = await serve(t);
		fs.chmodSync(ro.dec, 0o444);
		cases.push({ name: 'a read-only file', s: ro, decide: false });
	}

	for (const { name, s, decide } of cases) {
		const h = hex(1);
		append(s.log, ev(h, 'hold'));
		const sse = await watch(t, s);
		assert.equal(JSON.parse(sse.clocks[0].data).decide, decide, name + ': clock');
		const res = await post(s.port, { id: h, verdict: 'allow' });
		assert.equal(res.status, 503, name);
		assert.deepEqual(res.json(), { error: 'decisions unavailable' }, name);
		assert.equal(res.headers['cache-control'], 'no-store');
		noCors(res, name);
		assert.match(s.stderr, /sid-web: cannot record a decision in .*: /, name + ': logged');
		// refusals that come before the file is touched are unchanged
		assert.equal((await post(s.port, { id: hex(2), verdict: 'allow' })).status, 404, name);
		assert.equal((await post(s.port, { id: h, verdict: 'allow' }, { 'X-Sid-Request': undefined })).status, 403, name);
	}
	assert.equal(fs.statSync(full.dec).size, 8 * 1024 * 1024 + 1, 'nothing was added to the full file');
	// a decision file that appears later is picked up without a restart
	const later = await serve(t, { decisions: path.join(extra, 'later.jsonl') });
	const h = hex(5);
	append(later.log, ev(h, 'hold'));
	assert.equal((await post(later.port, { id: h, verdict: 'allow' })).status, 503);
	fs.writeFileSync(path.join(extra, 'later.jsonl'), '');
	assert.equal((await post(later.port, { id: h, verdict: 'allow' })).status, 202);
	assert.equal(fs.readFileSync(path.join(extra, 'later.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
});

test('slow clients are dropped after about 5 s, the idle clock replaces the ping, and the server stays responsive', { timeout: 60000 }, async (t) => {
	const s = await serve(t);
	const h = hex(1);
	append(s.log, ev(h, 'hold'));
	const stream = await watch(t, s);
	const t0 = performance.now();

	const watchSocket = (data) => new Promise((resolve) => {
		const sock = net.connect(s.port, '127.0.0.1');
		const got = [];
		sock.on('connect', () => sock.write(data));
		sock.on('data', (d) => got.push(d));
		sock.on('error', () => {});
		sock.on('close', () => resolve({ ms: performance.now() - t0, got: Buffer.concat(got).toString() }));
		t.after(() => sock.destroy());
	});
	const body = JSON.stringify({ id: h, verdict: 'allow' });
	const slowBody = watchSocket(`POST /decide HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nX-Sid-Request: 1\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 10)}`);
	const slowHead = watchSocket(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nX-Slow: `);
	const silent = watchSocket('');

	// while they hang, everything else is served promptly
	for (let i = 0; i < 5; i++) {
		await sleep(400);
		const t1 = performance.now();
		assert.equal((await http(s.port, { path: '/' })).status, 200);
		assert.equal((await post(s.port, { id: hex(50 + i), verdict: 'allow' })).status, 404);
		assert.ok(performance.now() - t1 < 300, 'answered promptly');
	}
	for (const [name, p] of [['partial body', slowBody], ['partial headers', slowHead], ['silent', silent]]) {
		const r = await p;
		assert.ok(r.ms >= 4500 && r.ms < 8000, `${name} dropped after ${r.ms.toFixed(0)} ms`);
		assert.equal(r.got, '', `${name}: nothing was said to it`);
	}
	assert.deepEqual(decisions(s), [], 'the half-sent decision was not recorded');
	assert.equal((await post(s.port, { id: h, verdict: 'allow' })).status, 202, 'and the server still takes decisions');

	// the idle stream: a clock frame about 15 s after the last thing sent, never a bare ping
	await stream.waitFor((x) => x.clocks.length >= 2, 20000);
	const gap = stream.clocks[1].at - stream.clocks[0].at;
	assert.ok(gap > 14000 && gap < 17000, `second clock frame after ${gap.toFixed(0)} ms`);
	const [c1, c2] = stream.clocks.map((f) => JSON.parse(f.data));
	assert.ok(Math.abs(c2.now - c1.now - gap) < 1500, 'now advances with the clock');
	assert.equal(c2.decide, true);
	assert.ok(!stream.frames.some((f) => f.comment !== undefined), 'no comment pings');
});

test('thirty-two clients at once do not hurt, and a 33rd is turned away', async (t) => {
	const s = await serve(t);
	append(s.log, ev(hex(1), 'block'));
	const streams = [];
	for (let i = 0; i < 32; i++) streams.push(await Sse.open(s.port));
	streams.forEach((x) => t.after(() => x.close()));
	await Promise.all(streams.map((x) => x.lines_(1)));
	const extra = await new Promise((resolve) => {
		const sock = net.connect(s.port, '127.0.0.1');
		sock.on('connect', () => sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`));
		sock.on('data', () => resolve('answered'));
		sock.on('close', () => resolve('closed'));
		sock.on('error', () => resolve('closed'));
	});
	assert.equal(extra, 'closed');
	append(s.log, ev(hex(2), 'block'));
	await Promise.all(streams.map((x) => x.lines_(2)));
	streams[0].close();
	await sleep(200);
	assert.equal((await http(s.port, { path: '/' })).status, 200, 'a slot frees up when a stream closes');
});
