// The execution context of a command: who ran it, where, with what rights, what it touches.
//
// A daemon that knows the answers writes them into the event as a `context` string with a fixed
// layout (CONTRACT.md). Today's daemon writes none, so the page also builds the same facts from
// the plain event fields. No DOM and no globals in here, so Node can unit-test it.
//
// Everything in an event is text an attacker may have chosen. The parser therefore reads the
// context strictly by position, refuses the whole string on any deviation, and never turns the
// writer's escapes (\n \r \t \xNN) back into control characters: they stay visible as text.

export const MAX_CONTEXT = 8192;

const ORIGINS = new Set(['agent', 'ssh', 'service', 'local']);
const OPS = new Set(['read', 'write', 'delete', 'perms']);
const SUDO = {
  'none': 'none', 'some': 'some', 'all (password)': 'all-pw', 'all (nopasswd)': 'all-nopw', 'unknown': 'unknown',
};
const SUDO_WORDS = {
  'none': 'none', 'some': 'some', 'all-pw': 'all-pw all password', 'all-nopw': 'all-nopw all nopasswd nopw', 'unknown': 'unknown',
};

// C0, DEL and C1 controls, plus the characters that make text read in a different order or vanish:
// zero-width and bidi marks, line and paragraph separators, byte-order mark.
const BAD_SRC = '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]';
const BAD = new RegExp(BAD_SRC);
const BAD_G = new RegExp(BAD_SRC, 'g');
const hex = (n, w) => n.toString(16).padStart(w, '0');
const escChar = (c) => {
  const n = c.charCodeAt(0);
  if (n === 10) return '\\n';
  if (n === 13) return '\\r';
  if (n === 9) return '\\t';
  return n < 0x100 ? '\\x' + hex(n, 2) : '\\u' + hex(n, 4);
};

// Display text: controls become visible escapes. Idempotent, because a backslash is left alone.
export function esc(s) {
  s = String(s);
  return BAD.test(s) ? s.replace(BAD_G, escChar) : s;
}

const str = (x) => (typeof x === 'string' ? x : typeof x === 'number' && isFinite(x) ? String(x) : '');
const toInt = (x) => {
  if (typeof x === 'number') return Number.isInteger(x) && x >= 0 ? x : null;
  if (typeof x === 'string' && /^\d{1,10}$/.test(x)) return +x;
  return null;
};

// ---- the strict parser --------------------------------------------------------------

// Raw control characters other than the line feed that ends a line can only come from a forger
// (the writer escapes them), so their presence alone invalidates the context.
const RAW_CTRL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const KEYS = ['command:', 'program:', 'origin:', 'user:', 'groups:', 'sudo rights:', 'capabilities:', 'cwd:', 'files (inferred):'];
const ORIGIN_RE = /^(agent|ssh|service|local)(?: \((.*)\))?$/;
const USER_RE = /^(.*) \(uid (\d{1,10})(?:, (human|service|root) account)?\)$/;
const CAP_RE = /^cap_[a-z0-9_]+$/i;
const FILE_RE = /^(read|write|delete|perms) (.+)$/;
const MORE_RE = /;?\s*\(\+(\d+) more\)$/;

// The value after "key:", or null if the line is not that key. "key:" alone is an empty value.
function value(line, key) {
  if (line === key) return '';
  return line.startsWith(key + ' ') ? line.slice(key.length + 1) : null;
}

// text -> Ctx, or null for anything that is not exactly the documented layout. One trailing line
// feed is tolerated; nothing else is.
export function parse(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CONTEXT) return null;
  if (RAW_CTRL.test(text)) return null;
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  if (lines.length < 10 || lines[9] !== 'history (oldest first):') return null;
  const v = [];
  for (let i = 0; i < KEYS.length; i++) {
    const x = value(lines[i], KEYS[i]);
    if (x === null) return null;
    v.push(x);
  }

  const mo = ORIGIN_RE.exec(v[2]);
  if (!mo) return null;
  const mu = USER_RE.exec(v[3]);
  const uid = mu ? +mu[2] : NaN;
  if (!mu || !(uid <= 4294967295)) return null;

  let groups = [];
  if (v[4] === '') return null;
  if (v[4] !== 'none') {
    groups = v[4].split(', ');
    if (groups.some((g) => g === '')) return null;
    groups = groups.slice(0, 256).map(esc);
  }

  const sudo = Object.prototype.hasOwnProperty.call(SUDO, v[5]) ? SUDO[v[5]] : null;
  if (sudo === null) return null;

  const caps = { all: false, list: [], unknown: false };
  if (v[6] === 'all') caps.all = true;
  else if (v[6] !== 'none') {
    const list = v[6].split(', ');
    if (!list.every((c) => CAP_RE.test(c))) return null;
    caps.list = list;
  }

  let f = v[8], more = 0;
  const mm = MORE_RE.exec(f);
  if (mm) { more = +mm[1]; f = f.slice(0, mm.index); }
  const files = [];
  if (f === 'none') {
    if (more) return null;
  } else {
    for (const part of f.split('; ')) {
      const m = FILE_RE.exec(part);
      if (!m || !OPS.has(m[1])) return null;
      files.push({ op: m[1], path: esc(m[2]) });
    }
  }

  const history = [];
  for (let i = 10; i < lines.length; i++) {
    if (!lines[i].startsWith('  ')) return null;
    history.push(esc(lines[i].slice(2)));
  }

  const ctx = {
    command: esc(v[0]),
    program: esc(v[1]),
    origin: { kind: mo[1], detail: esc(mo[2] || '') },
    user: { name: esc(mu[1]), uid, type: mu[3] || 'unknown' },
    groups,
    sudo,
    caps,
    cwd: esc(v[7]),
    files,
    history,
    raw: text,
    suspect: false,
  };
  if (more) ctx.filesMore = more;
  return ctx;
}

// ---- synthesis from the structured fields ---------------------------------------------

function structCommand(ev) {
  if (Array.isArray(ev.argv) && ev.argv.length) return esc(ev.argv.map(String).join(' '));
  const p = str(ev.path) || str(ev.file);
  return p ? esc(p) : null;
}

// origin.type and origin.detail; local with via_ssh counts as ssh. null when the event says nothing.
function structOrigin(ev, service) {
  const o = ev.origin && typeof ev.origin === 'object' ? ev.origin : null;
  const via = ev.via_ssh === true;
  if (!o && !via) return null;
  const t = o && typeof o.type === 'string' ? o.type : via ? 'local' : '';
  let kind = ORIGINS.has(t) ? t : 'unknown';
  if (kind === 'local' && via) kind = 'ssh';
  let detail = o ? str(o.detail) : '';
  if (!detail && service && kind === 'service') detail = str(ev.service);
  return { kind, detail: esc(detail) };
}

// The context an event has without a `context` string: what the structured fields give, and
// "unknown" for what only the daemon's own inspection could tell.
export function synth(ev) {
  if (!ev || typeof ev !== 'object') ev = {};
  const uid = toInt(ev.uid);
  let name = str(ev.user);
  if (!name && uid !== null) name = 'uid ' + uid;
  // The event writer uses the decimal UID as a fallback when it cannot resolve a login name.
  if (uid !== null && name === String(uid)) name = 'uid ' + uid;
  return {
    command: structCommand(ev) || '',
    // `file` and argv[0] are not necessarily the executable path; leave it unknown when `path` is absent.
    program: esc(str(ev.path)),
    origin: structOrigin(ev, true) || { kind: 'unknown', detail: '' },
    // Classify the account by the standard UID ranges: 0 is root, 1..999 are
    // system/service accounts, 1000+ are human logins; unknown without a UID.
    user: { name: esc(name), uid, type: uid === null ? 'unknown' : uid === 0 ? 'root' : uid < 1000 ? 'service' : 'human' },
    groups: (Array.isArray(ev.groups) ? ev.groups : []).slice(0, 256).map((g) => esc(str(g))).filter(Boolean),
    sudo: 'unknown',
    caps: { all: false, list: [], unknown: true },
    cwd: esc(str(ev.cwd)),
    files: [],
    history: (Array.isArray(ev.recent) ? ev.recent : []).slice(-5).map((s) => esc(str(s))),
    raw: null,
    suspect: false,
  };
}

// If inspected context conflicts with the event's user, origin, or command, treat the whole
// context as untrusted. Keeping its other fields could attach one process's facts to another.
function reconcile(ctx, ev) {
  let bad = false;

  const name = typeof ev.user === 'string' ? esc(ev.user) : null;
  const uid = toInt(ev.uid);
  if ((name !== null && name !== ctx.user.name) || (uid !== null && uid !== ctx.user.uid)) {
    bad = true;
    const u = uid !== null ? uid : ctx.user.uid;
    ctx.user = {
      name: name !== null ? name : ctx.user.name,
      uid: u,
      type: 'unknown',
    };
  }

  const o = structOrigin(ev, false);
  if (o && (o.kind !== ctx.origin.kind || (o.detail && o.detail !== ctx.origin.detail))) {
    bad = true;
    ctx.origin = { kind: o.kind, detail: o.detail || (o.kind === ctx.origin.kind ? ctx.origin.detail : '') };
  }

  const cmd = structCommand(ev);
  if (cmd !== null && cmd !== ctx.command) {
    bad = true;
    ctx.command = cmd;
  }

  if (bad) ctx.suspect = true;
  return ctx;
}

// The context of an event: parsed only when it is valid and agrees with the structured identity.
export function ctxOf(ev) {
  if (!ev || typeof ev !== 'object') return synth(null);
  if (ev.context === undefined || ev.context === null) return synth(ev);
  const ctx = parse(ev.context);
  if (!ctx) {
    const s = synth(ev);
    s.suspect = true;
    s.contextInvalid = true;
    return s;
  }
  const checked = reconcile(ctx, ev);
  if (!checked.suspect) return checked;
  const s = synth(ev);
  s.suspect = true;
  s.contextMismatch = true;
  return s;
}

// ---- search text ---------------------------------------------------------------------

// Lowercase text to search, by field, and all of it as one blob (`hay`) for plain terms. Fields are
// joined by line feeds, which a value can never contain (they are escaped), and a search term never
// contains whitespace, so a term cannot match across two fields.
export function parts(ctx, ev) {
  const lc = (s) => String(s).toLowerCase();
  const o = ctx.origin, u = ctx.user;
  const reason = ev && typeof ev.reason === 'string' ? esc(ev.reason) : '';
  const p = {
    cmd: lc(ctx.command),
    prog: lc(ctx.program),
    origin: lc(o.kind + (o.detail ? ' ' + o.detail : '')),
    user: lc(u.name + ' uid ' + (u.uid === null ? '' : u.uid) + ' ' + u.type),
    groups: lc(ctx.groups.join(' ')),
    cwd: lc(ctx.cwd),
    path: lc([ctx.program, ...ctx.files.map((f) => f.path)].join('\n')),
    sudo: SUDO_WORDS[ctx.sudo] || ctx.sudo,
    hist: lc(ctx.history.join('\n')),
    reason: lc(reason),
  };
  // The plain-term haystack is the visible identity only: command, program, origin, user,
  // groups, cwd and touched paths. It deliberately excludes the recent-command history and
  // the model's reason JSON -- those would make a term match a command it isn't part of (e.g.
  // "vim" matching "rm public.txt" because vim was a prior command), and the reason JSON
  // contains every verdict word, so it would make "allow"/"hold"/"block" match everything.
  p.hay = [p.cmd, p.prog, p.origin, p.user, p.groups, p.cwd, lc(ctx.files.map((f) => f.op + ' ' + f.path).join('\n'))].join('\n');
  return p;
}

export function hay(ctx, ev) {
  return parts(ctx, ev).hay;
}
