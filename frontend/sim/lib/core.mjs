// Core of the sid simulator: JSON writer, event and context builders, quarantine player, fake daemon.
// DEV ONLY. Everything written here is fake and tagged "sim":true.
import fs from 'node:fs';
import path from 'node:path';

// ---- random -------------------------------------------------------------------------
export function createRng(seed = Date.now()) {
  let a = Number(seed) >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    exp: (mean) => -Math.log(1 - next()) * mean,
    hex: (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join(''),
    shuffle: (arr) => {
      const o = arr.slice();
      for (let i = o.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [o[i], o[j]] = [o[j], o[i]];
      }
      return o;
    },
  };
  return r;
}

// ---- JSON writer ----------------------------------------------------------------------
// compact: how the C++ daemon writes (raw UTF-8, control characters and DEL as \u00xx).
// spaced:  how Python's json.dumps writes (": " and ", ", everything non-ASCII escaped, surrogate pairs).
const u4 = (c) => '\\u' + c.toString(16).padStart(4, '0');
function jstr(s, ascii) {
  let o = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) o += '\\"';
    else if (c === 92) o += '\\\\';
    else if (c === 10) o += '\\n';
    else if (c === 13) o += '\\r';
    else if (c === 9) o += '\\t';
    else if (c < 32 || c === 127) o += u4(c);
    else if (c >= 0xd800 && c <= 0xdfff) {
      const d = s.charCodeAt(i + 1);
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        o += ascii ? u4(c) + u4(d) : s[i] + s[i + 1];
        i++;
      } else o += u4(c); // a lone surrogate cannot be UTF-8; JSON can say it with an escape
    } else if (ascii && c > 126) o += u4(c);
    else o += s[i];
  }
  return o + '"';
}
export function toJson(v, spaced = false) {
  const ser = (x) => {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'string') return jstr(x, spaced);
    if (typeof x === 'number') return Number.isFinite(x) ? String(x) : 'null';
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    if (Array.isArray(x)) return '[' + x.map(ser).join(spaced ? ', ' : ',') + ']';
    const parts = [];
    for (const [k, y] of Object.entries(x)) if (y !== undefined) parts.push(jstr(k, spaced) + (spaced ? ': ' : ':') + ser(y));
    return '{' + parts.join(spaced ? ', ' : ',') + '}';
  };
  return ser(v);
}

export function guardPath(p, really) {
  const abs = path.resolve(p);
  let real = abs;
  try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* not created yet */ }
  for (const q of [abs, real])
    if (/^(\/private)?\/var\/log\/sid(\/|$)/.test(q) && !really)
      throw new Error(`refusing to write ${q}: that is the real sid log directory (use --really-write-real-log to override)`);
  return abs;
}

export const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
export const sleep = (ms) => new Promise((res) => setTimeout(res, Math.max(0, ms)));

// ---- context string -------------------------------------------------------------------
const cesc = (s) =>
  String(s).replace(/[\x00-\x1f\x7f]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function buildContext(c, { unsafeRaw = false } = {}) {
  const e = unsafeRaw ? String : cesc;
  const files = c.files.slice(0, 16).map((f) => `${f[0] === 'write' || f[0] === 'read' || f[0] === 'delete' || f[0] === 'perms' ? f[0] : 'write'} ${e(f[1])}`);
  if (c.files.length > 16) files.push(`(+${c.files.length - 16} more)`);
  const caps = c.caps === 'all' ? 'all' : c.caps.length ? c.caps.join(', ') : 'none';
  const lines = [
    `command: ${e(cut(c.command, 2048))}`,
    `program: ${e(c.program)}`,
    `origin: ${c.origin.type}${c.origin.detail ? ` (${e(c.origin.detail)})` : ''}`,
    `user: ${e(c.user.name)} (uid ${c.user.uid}${c.user.type ? `, ${c.user.type} account` : ''})`,
    `groups: ${c.groups.length ? c.groups.map((g) => e(g.name)).join(', ') : 'none'}`,
    `sudo rights: ${c.sudo}`,
    `capabilities: ${caps}`,
    `cwd: ${e(c.cwd)}`,
    `files (inferred): ${files.length ? files.join('; ') : 'none'}`,
    'history (oldest first):',
    ...c.history.slice(-5).map((h) => `  ${e(cut(h, 200))}`),
  ];
  let text = lines.join('\n');
  if (Buffer.byteLength(text) > 8192) { // never exceed 8 KiB: clip the command and drop the history lines
    lines[0] = `command: ${e(cut(c.command, 256))}`;
    lines.length = 10;
    text = lines.join('\n');
  }
  return text;
}

// ---- summary --------------------------------------------------------------------------
const SENSITIVE = [
  /^\/etc\//, /^\/boot\//, /^\/root\//, /^\/proc\/sys/, /^\/sys\//, /^\/(usr\/(local\/)?)?(s?bin|lib|lib64)\//, /^\/var\/spool\/cron\//, /^\/var\/log\//,
  /^\/home\/[^/]+\/\.(ssh|gnupg|aws|kube)\//, /^\/home\/[^/]+\/\.(bashrc|bash_profile|profile|zshrc|zprofile)$/, /\/authorized_keys$/, /^\/dev\/(sd|nvme|vd)/,
];
export const isSensitive = (p) => typeof p === 'string' && SENSITIVE.some((re) => re.test(p));

const joinAnd = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const files = (n) => `${n} file${n === 1 ? '' : 's'}`;
const clean = (p) => {
  const s = Array.from(String(p).replace(/[\x00-\x1f\x7f]/g, '?'));
  return s.length > 120 ? s.slice(0, 120).join('') + '…' : s.join('');
};

export function summarize({ counts, touched, how, code, signal, duration_ms }) {
  const ph = [];
  if (counts.create) ph.push(`created ${files(counts.create)}`);
  if (counts.modify) ph.push(`modified ${files(counts.modify)}`);
  if (counts.delete) ph.push(`deleted ${files(counts.delete)}`);
  if (counts.move) ph.push(`moved ${files(counts.move)}`);
  if (counts.chmod) ph.push(`changed permissions on ${files(counts.chmod)}`);
  const s1 = ph.length ? `In the quarantine it ${joinAnd(ph)}.` : 'In the quarantine it changed no files.';
  const s2 = touched.length
    ? `Sensitive paths touched: ${touched.slice(0, 3).map(clean).join(', ')}${touched.length > 3 ? ` and ${touched.length - 3} more` : ''}.`
    : '';
  const secs = Math.round(duration_ms / 1000);
  const s3 =
    how === 'exit' ? (code === 0 ? 'It exited normally.' : `It exited with code ${code}.`)
    : how === 'signal' ? `It was stopped by signal ${signal}.`
    : how === 'timeout' ? `It was still running after ${secs} second${secs === 1 ? '' : 's'} and was stopped.`
    : how === 'aborted' ? 'It was stopped early because a decision was made.'
    : how === 'error' ? 'The quarantine failed to run it.' : '';
  return [s1, s2, s3].filter(Boolean).join(' ');
}

// ---- model ----------------------------------------------------------------------------
// The choice is the most likely outcome (a held command is mostly "hold", a blocked one mostly "block").
// Integer arithmetic so ties are exact; a tie goes to the more cautious side.
export function choiceFor(p) {
  const a = Math.round(p.allow * 10000), h = Math.round(p.hold * 10000), b = Math.round(p.block * 10000);
  return b >= h && b >= a ? 'block' : h >= a ? 'hold' : 'allow';
}
export function makeModel(r, choice) {
  const top = r.range(0.62, 0.995), rest = 1 - top, u = r.range(0.15, 0.85);
  const others = choice === 'allow' ? ['hold', 'block'] : choice === 'hold' ? ['allow', 'block'] : ['allow', 'hold'];
  const q = { allow: 0, hold: 0, block: 0 };
  q[choice] = top; q[others[0]] = rest * u; q[others[1]] = rest * (1 - u);
  const v = ['allow', 'hold', 'block'].map((k) => Math.round(q[k] * 10000));
  v[v.indexOf(Math.max(...v))] += 10000 - v.reduce((t, x) => t + x, 0);
  const probabilities = { allow: v[0] / 10000, hold: v[1] / 10000, block: v[2] / 10000 };
  if (choiceFor(probabilities) !== choice) throw new Error(`model generator broke its own rule: ${JSON.stringify(probabilities)} is not ${choice}`);
  return { choice, probabilities };
}

// ---- event ----------------------------------------------------------------------------
function normalize(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === ' ' || text[i] === '\t') { out += text[i++]; continue; }
    let j = i;
    while (j < text.length && text[j] !== ' ' && text[j] !== '\t') j++;
    const tok = text.slice(i, j);
    i = j;
    const slashes = tok.split('/').length - 1;
    if (slashes >= 2 || (slashes === 1 && tok[0] === '/')) out += '<path>';
    else if (tok.split('.').length - 1 === 3 && /^[0-9.]+$/.test(tok)) out += '<ip>';
    else if (tok.length >= 8 && /^[0-9a-f]+$/.test(tok)) out += '<hex>';
    else out += tok.replace(/[0-9]+/g, '<n>');
  }
  return out;
}

const stable = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h; };
const sha = (s) => { let o = ''; let h = stable(s); for (let i = 0; i < 8; i++) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; o += h.toString(16).padStart(8, '0'); } return o; };

const DECIDERS = {
  block: [['model', 55], ['rule', 25], ['classifier', 12], ['exploration', 8]],
  hold: [['model', 70], ['classifier', 20], ['rule', 10]],
  allow: [['model', 60], ['rule', 25], ['stub', 15]],
};
function pickDecider(r, verdict, choice) {
  if (verdict !== choice) return 'rule';
  const pairs = DECIDERS[verdict];
  let x = r.next() * pairs.reduce((s, p) => s + p[1], 0);
  for (const [v, n] of pairs) if ((x -= n) < 0) return v;
  return pairs[0][0];
}

const SANDBOX_REASONS = ['In a sandbox run it opened a network connection to an unknown host and was stopped.', 'In a sandbox run it changed files outside the project and was stopped.'];

// One line exactly as the daemon would write it today, plus model, context and sim.
export function buildEvent({ r, now, p, cmd, verdict, choice = verdict, probabilities, legacy = false, decided_by, reason, id }) {
  id = id || r.hex(12);
  const argv = cmd.argv;
  const text = argv.length ? argv.join(' ') : cmd.path;
  const model = legacy ? null : probabilities ? { choice, probabilities } : makeModel(r, choice);
  if (model && choiceFor(model.probabilities) !== choice) throw new Error('provided probabilities do not match the model choice');
  decided_by = decided_by || (legacy ? r.pick(['model', 'rule', 'classifier']) : pickDecider(r, verdict, choice));
  if (reason === undefined) {
    reason = verdict === 'hold' ? '' :
      decided_by === 'rule' && cmd.rule ? cmd.rule :
      decided_by === 'rule' ? `Rule: ${cmd.reason.charAt(0).toLowerCase()}${cmd.reason.slice(1)}` :
      decided_by === 'exploration' ? r.pick(SANDBOX_REASONS) :
      verdict === 'allow' ? 'Matches normal activity for this user.' : cmd.reason;
  }
  const hasScore = decided_by === 'model' || decided_by === 'classifier' || decided_by === 'exploration';
  const score = hasScore ? (model ? Math.round((1 - model.probabilities.allow) * 1e4) / 1e4 : Math.round(r.range(verdict === 'block' ? 0.82 : 0.35, verdict === 'block' ? 0.999 : 0.78) * 1e3) / 1e3) : null;
  const sshd = p.origin.type === 'ssh' ? Number(/\d+/.exec(p.origin.detail)[0]) : r.int(900, 9000);
  const shell = { pid: r.int(2000, 60000), exe: '/usr/bin/bash' };
  const chain = [shell];
  if (p.origin.type === 'agent') chain.push({ pid: r.int(2000, 60000), exe: p.origin.detail === 'claude' ? `${p.home}/.local/bin/claude` : `/usr/local/bin/${p.origin.detail}` });
  if (p.via_ssh) chain.push({ pid: sshd, exe: '/usr/sbin/sshd' });
  if (p.origin.type === 'service') chain[0] = { pid: shell.pid, exe: '/usr/bin/' + p.service.replace(/\.service$/, '').replace(/^cron$/, 'cron') };
  chain.push({ pid: 1, exe: '/usr/lib/systemd/systemd' });
  const piped = !!cmd.feeder;
  const file = cmd.file || cmd.path;
  const pid = r.int(20000, 4000000);
  const ev = {
    id, time: iso(now), syscall: r.chance(0.08) ? 'execveat' : 'execve', role: 'program', tid: pid, pid, ppid: chain[0].pid,
    uid: p.user.uid, gid: p.user.gid, groups: p.groups.map((g) => g.gid), user: p.user.name, cwd: cmd.cwd || p.cwd,
    path: cmd.path, file, argv, truncated: false,
    inode: 1000000 + (stable(file) % 9000000), size: 20000 + (stable(file + 'size') % 3000000), mtime: 1735689600 + (stable(file + 'm') % 30000000) + 0.123456,
    sha256: sha(file), is_new: /^(\/tmp\/|\/home\/|\/root\/|\/var\/tmp\/)/.test(file),
    origin: p.origin.detail ? { type: p.origin.type, detail: p.origin.detail } : { type: p.origin.type },
    via_ssh: p.via_ssh,
    ...(p.service ? { service: p.service } : {}),
    sessionid: p.sessionid, parent_chain: chain,
    stdin: piped ? `pipe:[${r.int(10000, 99999)}]` : p.origin.type === 'service' ? '/dev/null' : `/dev/pts/${r.int(0, 9)}`,
    ...(piped ? { stdin_feeder: { pid: r.int(20000, 4000000), exe: cmd.feeder.exe, cmdline: cmd.feeder.cmdline } } : {}),
    recent: cmd.history.map((h) => h.slice(0, 200)),
    normalized: `${p.user.name} ${p.origin.type} ${normalize(text)}`,
    verdict, decided_by, reason, score,
    explored: decided_by === 'exploration', effects: [], score_after: null,
    ...(cmd.attack && verdict !== 'allow' ? { attack_id: cmd.attack } : {}),
    latency_ms: Math.round(r.range(decided_by === 'exploration' ? 180 : 0.1, decided_by === 'exploration' ? 1500 : 6) * 1000) / 1000,
  };
  if (!legacy) {
    ev.model = model;
    ev.context = buildContext({
      command: text, program: file, origin: p.origin, user: { ...p.user, type: r.chance(0.9) ? p.user.type : '' }, groups: p.groups, sudo: p.sudo,
      caps: p.caps, cwd: ev.cwd, files: cmd.files, history: cmd.history,
    });
  }
  ev.sim = true;
  return ev;
}

// ---- quarantine -----------------------------------------------------------------------
// Plan: what the held program does, as timed raw operations (before the producer's caps).
export function planQuarantine(r, q, duration_ms = 12000) {
  q = q || { out: [], err: [], files: [], exit: ['exit', 0] };
  const [how, code, signal] = q.exit || ['exit', 0];
  const elapsed_ms = how === 'timeout' ? duration_ms + r.int(20, 120) : Math.round(duration_ms * r.range(0.55, 0.85));
  const lists = [
    q.out.map((l) => ({ k: 'out', stream: 'stdout', data: l + '\n' })),
    q.err.map((l) => ({ k: 'out', stream: 'stderr', data: l + '\n' })),
    (q.files || []).map(([op, p, x]) => (op === 'move' ? { k: 'file', op, path: p, to: x } : op === 'chmod' ? { k: 'file', op, path: p, mode: x } : op === 'delete' ? { k: 'file', op, path: p } : { k: 'file', op, path: p, bytes: x })),
  ];
  const seq = [];
  const left = lists.map((l) => l.length);
  const idx = [0, 0, 0];
  for (let n = left.reduce((a, b) => a + b, 0); n > 0; n--) {
    let x = r.next() * left.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < 2 && (x -= left[i]) >= 0) i++;
    if (!left[i]) i = left.findIndex((v) => v > 0);
    seq.push(lists[i][idx[i]++]);
    left[i]--;
  }
  const span = Math.max(500, elapsed_ms * 0.9 - 300);
  const gaps = seq.map(() => r.exp(1) + 0.05);
  const total = gaps.reduce((a, b) => a + b, 0) || 1;
  let t = 300;
  const ops = [];
  seq.forEach((it, i) => {
    t += (gaps[i] / total) * span;
    const at = Math.round(t);
    if (it.k === 'out' && it.data.length > 12 && r.chance(0.25)) { // sometimes a line arrives in two pieces
      const cutAt = r.int(4, it.data.length - 3);
      ops.push({ ...it, data: it.data.slice(0, cutAt), at }, { ...it, data: it.data.slice(cutAt), at: at + r.int(20, 80) });
    } else ops.push({ ...it, at });
  });
  ops.sort((a, b) => a.at - b.at);
  return { duration_ms, how, code: how === 'exit' ? code : null, signal: how === 'timeout' ? 'SIGKILL' : signal || null, elapsed_ms, ops };
}

const bytesOf = (s) => Buffer.byteLength(s);
function cutBytes(s, n) {
  let o = '';
  for (const ch of s) { if (bytesOf(o + ch) > n) break; o += ch; }
  return o;
}

// The producer applies the contract's caps: <=200 q:out and 32 KiB, <=200 q:file (+50 for sensitive paths), 100 ms coalescing.
class Producer {
  constructor() {
    this.c = { create: 0, modify: 0, delete: 0, move: 0, chmod: 0, stdout_bytes: 0, stderr_bytes: 0, dropped_out: 0, dropped_files: 0 };
    this.outN = 0; this.outB = 0; this.fileN = 0; this.extra = 0;
    this.touched = new Set(); this.buf = { stdout: [], stderr: [] }; this.files = [];
  }
  add(op) {
    if (op.k === 'out') { this.buf[op.stream].push(op.data); this.c[op.stream + '_bytes'] += bytesOf(op.data); return; }
    this.c[op.op]++;
    for (const x of [op.path, op.to]) if (isSensitive(x)) this.touched.add(x);
    this.files.push(op);
  }
  flush() {
    const lines = [];
    for (const stream of ['stdout', 'stderr']) {
      const chunks = this.buf[stream];
      if (!chunks.length) continue;
      this.buf[stream] = [];
      if (this.outN >= 200 || this.outB >= 32768) { this.c.dropped_out += chunks.length; continue; }
      let data = chunks.join('');
      let trunc = false;
      if (bytesOf(data) > 2048) { data = cutBytes(data, 2048); trunc = true; }
      if (bytesOf(data) > 32768 - this.outB) { data = cutBytes(data, 32768 - this.outB); trunc = true; }
      this.outN++; this.outB += bytesOf(data);
      lines.push({ q: 'out', stream, data, ...(trunc ? { trunc: true } : {}) });
    }
    for (const f of this.files) {
      const sens = isSensitive(f.path) || isSensitive(f.to);
      if (this.fileN < 200) this.fileN++;
      else if (sens && this.extra < 50) this.extra++;
      else { this.c.dropped_files++; continue; }
      const { k, ...rest } = f; // eslint-disable-line no-unused-vars
      const { at, ...body } = rest; // eslint-disable-line no-unused-vars
      lines.push({ q: 'file', ...body });
    }
    this.files = [];
    return lines;
  }
  end(how, code, signal, elapsed_ms, duration_ms) {
    const touched = [...this.touched].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).slice(0, 8);
    return { q: 'end', how, code, signal, elapsed_ms, counts: this.c, touched, summary: summarize({ counts: this.c, touched, how, code, signal, duration_ms }) };
  }
}

// Plays a plan in real time, writing q lines through write(). abort() ends it early with how "aborted".
export function playQuarantine({ id, plan, write, startMs = Date.now() }) {
  const t0 = startMs;
  let seq = 0, aborted = false, wake = null, running = true;
  const emit = (t, body) => write({ q: body.q, id, seq: ++seq, t, ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'q')) });
  const wait = (until) => new Promise((res) => {
    const ms = until - Date.now();
    if (ms <= 0) return res();
    const tm = setTimeout(() => { wake = null; res(); }, ms);
    wake = () => { clearTimeout(tm); wake = null; res(); };
  });
  const prod = new Producer();
  let resolveEnded;
  const ended = new Promise((res) => (resolveEnded = res));
  const done = (async () => {
    emit(t0, { q: 'start', duration_ms: plan.duration_ms, ends_at: t0 + plan.duration_ms, limits: { out_events: 200, out_bytes: 32768, file_events: 200 } });
    let i = 0;
    let lastT = t0;
    while (i < plan.ops.length && !aborted) {
      const win = Math.floor(plan.ops[i].at / 100);
      const wEnd = (win + 1) * 100;
      await wait(t0 + wEnd);
      if (aborted) break;
      while (i < plan.ops.length && plan.ops[i].at < wEnd) prod.add(plan.ops[i++]);
      for (const l of prod.flush()) emit((lastT = t0 + wEnd), l);
    }
    if (!aborted) await wait(t0 + plan.elapsed_ms);
    let how = plan.how, code = plan.code, signal = plan.signal, elapsed = plan.elapsed_ms;
    if (aborted) {
      elapsed = Math.max(0, Date.now() - t0);
      while (i < plan.ops.length && plan.ops[i].at <= elapsed) prod.add(plan.ops[i++]);
      for (const l of prod.flush()) emit((lastT = Date.now()), l);
      how = 'aborted'; code = null; signal = 'SIGKILL';
    }
    emit(Math.max(t0 + elapsed, lastT), prod.end(how, code, signal, elapsed, plan.duration_ms));
    running = false;
    resolveEnded();
  })();
  return {
    done, ends_at: t0 + plan.duration_ms, isRunning: () => running,
    abort() { if (!running) return ended; aborted = true; if (wake) wake(); return ended; },
  };
}

// ---- fake daemon ----------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export function createDaemon({ r, write, decisionsPath, graceMs, say }) {
  const pending = new Map();
  let offset = 0, tail = '', timer = null;
  const stats = { accepted: 0, ignored: 0 };
  try { offset = fs.statSync(decisionsPath).size; } catch { offset = 0; }

  const settle = (e, verdict, decided_by, reason) => {
    if (!pending.delete(e.id)) return;
    clearTimeout(e.timeout);
    write({ id: e.id, time: iso(Date.now()), verdict, decided_by, reason });
    say('settle', `${e.id} ${verdict === 'allow' ? 'allowed' : 'blocked'} (${decided_by})`);
    e.resolve();
  };
  const arm = (e, deadline) => {
    clearTimeout(e.timeout);
    e.timeout = setTimeout(() => {
      if (e.q && e.q.isRunning()) return arm(e, Date.now() + 1000);
      settle(e, 'block', 'timeout', 'Nobody decided in time, so the command stays blocked.');
    }, Math.max(0, deadline - Date.now()));
  };

  async function decide(e, verdict) {
    if (e.decided) return;
    e.decided = verdict;
    if (e.q && e.q.isRunning()) await e.q.abort(); // an early decision ends the quarantine first
    await sleep(r.int(150, 400));
    settle(e, verdict, 'person', verdict === 'allow' ? `Approved by a person${e.q ? ' after the quarantine run' : ''}.` : `Blocked by a person${e.q ? ' after the quarantine run' : ''}.`);
  }

  // The decisions file is untrusted: only whole, small, well-formed lines for held ids count.
  function poll() {
    let size;
    try { size = fs.statSync(decisionsPath).size; } catch { return; }
    if (size < offset) { offset = 0; tail = ''; } // truncated in place
    if (size === offset) return;
    const fd = fs.openSync(decisionsPath, 'r');
    const buf = Buffer.alloc(Math.min(size - offset, 1 << 20));
    const n = fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset += n;
    const parts = (tail + buf.subarray(0, n).toString('utf8')).split('\n');
    tail = parts.pop();
    if (tail.length > 4096) tail = '';
    for (const line of parts) {
      let d;
      try { d = line.length <= 4096 ? JSON.parse(line) : null; } catch { d = null; }
      const e = d && typeof d === 'object' && d.v === 1 && typeof d.id === 'string' && ID_RE.test(d.id) && (d.verdict === 'allow' || d.verdict === 'block') ? pending.get(d.id) : null;
      if (!e || e.decided) { stats.ignored++; continue; }
      stats.accepted++;
      decide(e, d.verdict);
    }
  }

  const autoLine = (id, verdict) => fs.appendFileSync(decisionsPath, toJson({ v: 1, id, verdict, t: Date.now(), peer: '127.0.0.1:50321' }) + '\n');

  return {
    pending, stats,
    start() { timer = setInterval(poll, 100); },
    stop() { clearInterval(timer); for (const e of pending.values()) clearTimeout(e.timeout); },
    poll,
    // A hold: write the hold line, run the quarantine, then wait for a decision.
    // spec.auto = 'allow'|'block'|null; spec.autoAt = ms after q:start, or undefined for "after the report".
    hold(event, plan, spec = {}) {
      write(event);
      const e = { id: event.id, q: null, decided: null, timeout: null };
      e.done = new Promise((res) => (e.resolve = res));
      pending.set(e.id, e);
      arm(e, Date.now() + plan.duration_ms + graceMs + 5000);
      (async () => {
        await sleep(r.int(20, 80));
        if (e.decided) return;
        const t0 = Date.now();
        e.q = playQuarantine({ id: e.id, plan, write, startMs: t0 });
        arm(e, e.q.ends_at + graceMs);
        if (spec.auto && spec.autoAt !== undefined) setTimeout(() => pending.has(e.id) && autoLine(e.id, spec.auto), spec.autoAt);
        await e.q.done;
        if (spec.auto && spec.autoAt === undefined) setTimeout(() => pending.has(e.id) && autoLine(e.id, spec.auto), r.int(1500, 4000));
      })();
      return e;
    },
    async drain() { while (pending.size) await sleep(200); },
  };
}
