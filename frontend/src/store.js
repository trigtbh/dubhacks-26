// The page's data: what sid-web streams, folded into one record per command.
//
// The reducer (ingest and everything under it) is plain synchronous code with no browser API, so
// Node can drive it with lines of text. The wiring around it (EventSource, the rAF-drained queue,
// the connection state) takes every global from `env`, which tests replace with fakes.
//
// Event text stays data here. Nothing in this file touches the DOM.
import { ui, onUI } from './ui.js';
import { ctxOf, parts } from './context.js';

export const LIMITS = {
  records: 1000,          // newest records kept; an undecided hold is never dropped
  outLines: 500,          // output lines kept per quarantine
  outBytes: 64 * 1024,    // and characters
  files: 200,             // distinct path|op entries kept per quarantine
  active: 5,              // undecided holds whose output is kept besides the selected one
  grace: 5000,            // ms past the countdown before "no report"
  replay: 300,            // ms of quiet after the last line before the backlog counts as replayed
  lost: 1500,             // ms of connection errors before "lost"
  retry: 3000,            // ms before a connection the browser gave up on is reopened
  line: 300000,           // longer lines are ignored (sid-web already drops anything over 256 KiB)
  slice: { lines: 500, ms: 4 },
};

const OPS = new Set(['create', 'modify', 'delete', 'move', 'chmod']);
// What a settle line may change of the hold it settles. Who ran what stays as the hold said it.
const SETTLE_KEYS = ['verdict', 'decided_by', 'reason', 'score', 'score_after', 'effects', 'attack_id', 'latency_ms', 'explored', 'note'];

const isNum = (x) => typeof x === 'number' && isFinite(x);
const num = (x) => (isNum(x) ? x : null);
const cut = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) : s) : null);

// ISO string or epoch ms -> epoch ms, or null.
export function toMs(t) {
  if (typeof t === 'number') return isFinite(t) ? t : null;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    return isNaN(n) ? null : n;
  }
  return null;
}

// {choice, probabilities} with the three probabilities scaled to sum to 1, or null when absent or
// malformed. The page never invents numbers.
export function parseModel(m) {
  if (!m || typeof m !== 'object') return null;
  const c = m.choice, p = m.probabilities;
  if (c !== 'allow' && c !== 'hold' && c !== 'block') return null;
  if (!p || typeof p !== 'object') return null;
  const a = p.allow, h = p.hold, b = p.block;
  for (const x of [a, h, b]) if (!isNum(x) || x < 0 || x > 1 + 1e-9) return null;
  const sum = a + h + b;
  if (!(sum > 0)) return null;
  return { choice: c, probabilities: { allow: a / sum, hold: h / sum, block: b / sum } };
}

const newQ = () => ({
  start: null,          // {duration_ms, ends_at, t, limits}
  endsAt: null,         // epoch ms of the countdown's end, in the daemon's time
  endMono: 0,           // the same instant on this page's performance.now() clock
  out: [],              // [{stream, text, open}] oldest first; open = no line feed seen yet
  outBytes: 0,          // characters held in out
  outTotal: 0,          // characters received, kept or not
  outLines: 0,          // complete lines received, kept or not
  files: new Map(),     // path|op -> {op, path, lp, to, bytes, mode, n, t}, newest last
  fileCount: 0,         // file lines received (the sum of every n, plus any that were pushed out)
  filesPushed: 0,       // entries pushed out of `files` by the cap
  end: null,            // {how, code, signal, elapsed_ms, counts, touched, summary, t}
  lastSeq: 0,
  incomplete: false,    // a seq jump was applied: some lines never arrived
  dropped: false,       // output payload was let go (counts remain)
  trunc: false,         // the daemon marked some output as cut
  rev: 0,               // bumps on every applied line
  _open: { stdout: null, stderr: null },
});

export function createStore(opts = {}) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  // Everything environmental, looked up at call time so a test can swap it with configure().
  const env = {
    mono: () => (g.performance ? g.performance.now() : Date.now()),
    wall: () => Date.now(),
    raf: null,           // null: g.requestAnimationFrame when it exists
    caf: null,
    setTimeout: (f, ms) => g.setTimeout(f, ms),
    clearTimeout: (h) => g.clearTimeout(h),
    EventSource: null,   // null: g.EventSource
    hidden: () => !!(g.document && g.document.hidden),
    ...opts,
  };

  const recs = new Map();
  const order = [];                 // ids, newest first
  const subs = { rec: new Set(), q: new Set(), conn: new Set() };
  const activeQ = [];               // ids of undecided holds, least recently updated first
  let anchor = { mono: env.mono(), wall: env.wall() };
  let lastSel = null;
  let unsubUI = null;

  const s = {
    recs, order,
    conn: 'connecting',    // connecting | live | lost
    everLive: false,       // a connection has been open at some point (so connecting means reconnecting)
    daemon: 'up',          // up | down, from the status frames
    replaying: false,
    skew: 0,               // daemon clock minus this page's clock, ms
    canDecide: false,      // the daemon can take a decision: from the clock frames, 503 turns it off
  };

  // ---- listeners ----

  function emit(type, a, b) {
    const set = subs[type];
    if (!set || !set.size) return;
    for (const fn of Array.from(set)) {
      try { fn(a, b); } catch (e) { /* a broken listener must not stop the stream */ }
    }
  }
  s.on = (type, fn) => {
    const set = subs[type] || (subs[type] = new Set());
    set.add(fn);
    return () => set.delete(fn);
  };

  // ---- time ----

  s.now = () => anchor.wall + (env.mono() - anchor.mono);   // the daemon's clock, ms since epoch

  function setAnchor(serverNow) {
    s.skew = serverNow - env.wall();
    anchor = { mono: env.mono(), wall: serverNow };
    for (const r of recs.values()) {                         // deadlines move with the new anchor
      const q = r.q;
      if (q && q.endsAt !== null && !q.end) q.endMono = env.mono() + (q.endsAt - s.now());
    }
  }

  s.remaining = (rec) => {
    const q = rec && rec.q;
    if (!q || !q.start || q.end) return 0;
    return Math.max(0, q.endMono - env.mono());
  };

  // ---- the truth table ----

  // blocked  a command the daemon blocked outright
  // queued   held, no quarantine started yet
  // investigating  quarantine running (or finishing: its countdown ended less than the grace ago)
  // report   the quarantine ended and its report is in
  // deciding a decision was sent and not yet settled
  // noreport the countdown ended over the grace ago with no end line, or the daemon is down
  // settled  a person (or a timeout) decided
  s.state = (rec) => {
    if (!rec) return 'queued';
    if (rec.decision || rec.verdict === 'allow') return 'settled';
    if (rec.verdict === 'block') return 'blocked';
    if (rec.pending) return 'deciding';
    const q = rec.q;
    if (q && q.end) return 'report';
    if (!q || !q.start) return 'queued';
    if (s.daemon === 'down') return 'noreport';
    return env.mono() - q.endMono > LIMITS.grace ? 'noreport' : 'investigating';
  };

  s.counts = () => {
    let block = 0, hold = 0, allow = 0, needs = 0;
    for (const r of recs.values()) {
      if (r.verdict === 'block') block++;
      else if (r.verdict === 'allow') allow++;
      else {
        hold++;
        if (!r.pending && !r.decision) needs++;
      }
    }
    return { block, hold, allow, needs };
  };

  s.list = () => order.map((id) => recs.get(id));   // records, newest first

  // ---- records ----

  const undecided = (r) => r.verdict === 'hold' && !r.decision;

  function mkRec(o) {
    const ctx = ctxOf(o);
    const hp = parts(ctx, o);
    return {
      id: o.id,
      time: toMs(o.time) ?? s.now(),
      verdict: o.verdict,
      ev: o,
      model: parseModel(o.model),
      ctx,
      hay: hp.hay,
      hp,
      decision: null,
      from: null,
      pending: null,
      failed: null,
      q: null,
    };
  }

  function evict() {
    while (recs.size > LIMITS.records) {
      let i = order.length - 1;
      while (i >= 0 && undecided(recs.get(order[i]))) i--;
      if (i < 0) return;                                      // only undecided holds are left: keep them all
      const id = order[i];
      order.splice(i, 1);
      recs.delete(id);
      const a = activeQ.indexOf(id);
      if (a >= 0) activeQ.splice(a, 1);
    }
  }

  function settle(rec, o) {
    const ev = Object.assign({}, rec.ev);
    for (const k of SETTLE_KEYS) if (o[k] !== undefined) ev[k] = o[k];
    rec.ev = ev;
    rec.decision = {
      verdict: o.verdict,
      by: typeof o.decided_by === 'string' ? o.decided_by : '',
      at: toMs(o.time) ?? s.now(),
    };
    rec.verdict = o.verdict;
    rec.from = 'hold';
    rec.pending = null;
    rec.failed = null;
    rec.hp = parts(rec.ctx, ev);
    rec.hay = rec.hp.hay;
    const a = activeQ.indexOf(rec.id);
    if (a >= 0) activeQ.splice(a, 1);
    if (ui.sel !== rec.id) dropPayload(rec);
    emit('rec', rec.id, 'dec');
    return true;
  }

  function onEvent(o) {
    const rec = recs.get(o.id);
    const v = o.verdict;
    if (!rec) {
      if (v === 'allow') return false;                         // an allowed command that was never held: nothing to show
      const r = mkRec(o);
      recs.set(r.id, r);
      order.unshift(r.id);
      evict();
      emit('rec', r.id, 'new');
      return true;
    }
    if (undecided(rec) && (v === 'allow' || v === 'block')) return settle(rec, o);
    return false;                                              // a replayed line, or a settle that came too late
  }

  // ---- quarantines ----

  // Output is kept for the selected record and the last few undecided holds that were heard from.
  // Anything else keeps its counts only.
  function dropPayload(rec) {
    const q = rec.q;
    if (!q) return;
    if (q.out.length || q.outBytes || q.outTotal) q.dropped = true;
    q.out = [];
    q.outBytes = 0;
    q._open.stdout = q._open.stderr = null;
  }

  function touch(rec) {
    if (!undecided(rec)) return;
    const i = activeQ.indexOf(rec.id);
    if (i >= 0) activeQ.splice(i, 1);
    activeQ.push(rec.id);
    while (activeQ.length > LIMITS.active) {
      const old = recs.get(activeQ.shift());
      if (old && ui.sel !== old.id) dropPayload(old);
    }
  }

  function syncSel() {
    const cur = ui.sel;
    if (cur === lastSel) return;
    const prev = lastSel;
    lastSel = cur;
    const r = prev && recs.get(prev);
    if (r && r.q && activeQ.indexOf(prev) < 0) dropPayload(r);
  }

  function addOut(q, stream, data, keep) {
    const segs = data.split('\n');
    if (!keep) {
      q.outLines += segs.length - 1;
      if (data) q.dropped = true;
      return;
    }
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const nl = i < segs.length - 1;                          // a line feed follows this piece
      if (!nl && seg === '') continue;
      let e = q._open[stream];
      if (e) e.text += seg;
      else { e = { stream, text: seg, open: true }; q.out.push(e); }
      q.outBytes += seg.length;
      if (nl) { e.open = false; q._open[stream] = null; q.outLines++; }
      else q._open[stream] = e;
    }
    const lose = (e) => { q.outBytes -= e.text.length; if (e.open) q._open[e.stream] = null; };
    if (q.out.length > LIMITS.outLines) q.out.splice(0, q.out.length - LIMITS.outLines).forEach(lose);
    while (q.outBytes > LIMITS.outBytes && q.out.length > 1) lose(q.out.shift());
    if (q.outBytes > LIMITS.outBytes && q.out.length === 1) {
      const e = q.out[0];
      e.text = e.text.slice(-LIMITS.outBytes);
      q.outBytes = e.text.length;
    }
  }

  function addFile(q, o) {
    const op = o.op, path = cut(o.path, 4096);
    if (!OPS.has(op) || !path) return;
    q.fileCount++;
    const key = path + '|' + op;
    let e = q.files.get(key);
    if (e) {
      q.files.delete(key);                                     // re-inserted below: newest last
      e.n++;
    } else {
      e = { op, path, lp: path.toLowerCase(), to: null, bytes: null, mode: null, n: 1, t: null };
    }
    if (typeof o.to === 'string') e.to = cut(o.to, 4096);
    if (isNum(o.bytes)) e.bytes = o.bytes;
    if (typeof o.mode === 'string') e.mode = cut(o.mode, 16);
    e.t = num(o.t);
    q.files.set(key, e);
    if (q.files.size > LIMITS.files) {
      q.files.delete(q.files.keys().next().value);
      q.filesPushed++;
    }
  }

  function onQ(o) {
    const rec = recs.get(o.id);
    if (!rec || (rec.verdict !== 'hold' && rec.from !== 'hold')) return false;   // unknown id, or never held
    const kind = o.q;
    if (kind !== 'start' && kind !== 'out' && kind !== 'file' && kind !== 'end') return false;
    const seq = o.seq;
    if (!Number.isInteger(seq) || seq < 1) return false;
    const q = rec.q || (rec.q = newQ());
    if (q.end || seq <= q.lastSeq) return false;                 // a duplicate, or a line after the end
    if (seq > q.lastSeq + 1) q.incomplete = true;                // a gap: apply, and say so
    q.lastSeq = seq;
    touch(rec);

    if (kind === 'start') {
      const dur = num(o.duration_ms), t = num(o.t);
      let ends = num(o.ends_at);
      if (ends === null && dur !== null && t !== null) ends = t + dur;
      q.start = {
        duration_ms: dur, ends_at: ends, t,
        limits: o.limits && typeof o.limits === 'object' ? o.limits : null,
      };
      q.endsAt = ends;
      q.endMono = env.mono() + (ends !== null ? ends - s.now() : 0);   // no deadline given: already over
    } else if (kind === 'out') {
      const data = typeof o.data === 'string' ? o.data : '';
      const stream = o.stream === 'stderr' ? 'stderr' : 'stdout';
      q.outTotal += data.length;
      if (o.trunc) q.trunc = true;
      addOut(q, stream, data, ui.sel === rec.id || (!q.dropped && activeQ.indexOf(rec.id) >= 0));
    } else if (kind === 'file') {
      addFile(q, o);
    } else {
      const c = o.counts && typeof o.counts === 'object' ? o.counts : {};
      const counts = {};
      for (const k of Object.keys(c).slice(0, 32)) if (isNum(c[k])) counts[k] = c[k];
      q.end = {
        how: cut(o.how, 16) || '',
        code: num(o.code),
        signal: typeof o.signal === 'string' ? cut(o.signal, 16) : num(o.signal),
        elapsed_ms: num(o.elapsed_ms),
        counts,
        touched: Array.isArray(o.touched) ? o.touched.filter((p) => typeof p === 'string').slice(0, 8).map((p) => cut(p, 4096)) : [],
        summary: cut(o.summary, 4096) || '',
        t: num(o.t),
      };
    }
    q.rev++;
    emit('q', rec.id, kind);
    return true;
  }

  // One line of text (or an already parsed object) in. True if it changed anything.
  s.ingest = (line) => {
    syncSel();
    let o = line;
    if (typeof line === 'string') {
      if (line.length > LIMITS.line) return false;
      try { o = JSON.parse(line); } catch (e) { return false; }
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const id = o.id;
    if (typeof id !== 'string' || id === '' || id.length > 128) return false;
    if (o.q !== undefined) return typeof o.q === 'string' ? onQ(o) : false;
    const v = o.verdict;
    if (v !== 'allow' && v !== 'hold' && v !== 'block') return false;
    return onEvent(o);
  };

  s.setPending = (id, verdict, err) => {
    const rec = recs.get(id);
    if (!rec || rec.decision) return;
    if (verdict) { rec.pending = verdict; rec.failed = null; }
    else { rec.pending = null; rec.failed = err || null; }
    emit('rec', id, 'upd');
  };

  s.setCanDecide = (b) => {
    b = !!b;
    if (s.canDecide === b) return;
    s.canDecide = b;
    emit('conn', s.conn, s.daemon);
  };

  // ---- the queue: messages wait here and are folded in a few per frame ----

  let queue = [], head = 0;
  let lastIn = 0;
  let rafId = 0, fbId = 0, replayId = 0;

  const pending = () => queue.length - head;

  // Fold in queued lines until a line or time budget is spent. Returns how many are still waiting.
  s.drain = (budget) => {
    const lines = (budget && budget.lines) || LIMITS.slice.lines;
    const ms = (budget && budget.ms) || LIMITS.slice.ms;
    const t0 = env.mono();
    let n = 0;
    while (head < queue.length && n < lines) {
      s.ingest(queue[head++]);
      n++;
      if ((n & 7) === 0 && env.mono() - t0 > ms) break;
    }
    if (head >= queue.length) { queue = []; head = 0; }
    else if (head > 4096) { queue = queue.slice(head); head = 0; }
    return pending();
  };

  function setReplaying(b) {
    if (s.replaying === b) return;
    s.replaying = b;
    emit('conn', s.conn, s.daemon);
  }

  // The backlog is over once nothing has arrived for a while and the queue is empty.
  function checkReplay() {
    if (replayId) { env.clearTimeout(replayId); replayId = 0; }
    if (!s.replaying || pending()) return;                     // the drain will look again when it empties
    const left = LIMITS.replay - (env.mono() - lastIn);
    if (left <= 0) setReplaying(false);
    else replayId = env.setTimeout(checkReplay, left);
  }

  function armReplay() {
    if (replayId) env.clearTimeout(replayId);
    replayId = env.setTimeout(checkReplay, LIMITS.replay);
  }

  function tick() {
    if (rafId && env.caf) env.caf(rafId);
    if (fbId) env.clearTimeout(fbId);
    rafId = fbId = 0;
    const big = env.hidden();                                   // no frames in a background tab: take more per turn
    if (s.drain(big ? { lines: 20000, ms: 50 } : null)) schedule();
    else if (s.replaying) checkReplay();
  }

  function schedule() {
    if (rafId || fbId) return;
    const raf = env.raf || (g.requestAnimationFrame ? (f) => g.requestAnimationFrame(f) : null);
    if (raf) rafId = raf(tick);
    fbId = env.setTimeout(tick, raf ? 250 : 16);                // rAF never fires in a hidden tab
  }

  s.enqueue = (data) => {
    if (typeof data !== 'string') return;
    queue.push(data);
    lastIn = env.mono();
    schedule();
  };

  // ---- the connection ----

  let es = null, url = 'events', lostId = 0, retryId = 0;

  function setConn(c) {
    if (s.conn === c) return;
    s.conn = c;
    emit('conn', s.conn, s.daemon);
  }

  function connect(u) {
    const ES = env.EventSource || g.EventSource;
    if (!ES) { setConn('lost'); return; }
    const cur = new ES(u);                                      // the first thing: SSE opens before anything else
    url = u;
    es = cur;
    cur.onopen = () => {
      if (es !== cur) return;
      if (lostId) { env.clearTimeout(lostId); lostId = 0; }
      s.everLive = true;
      s.replaying = true;                                       // the browser is about to be sent the recent past
      lastIn = env.mono();
      armReplay();
      setConn('live');
    };
    cur.onmessage = (m) => { if (es === cur) s.enqueue(m && m.data); };
    cur.addEventListener('clock', (m) => {
      if (es !== cur) return;
      let d;
      try { d = JSON.parse(m.data); } catch (e) { return; }
      if (!d || typeof d !== 'object') return;
      if (isNum(d.now)) setAnchor(d.now);
      if (typeof d.decide === 'boolean') s.setCanDecide(d.decide);
    });
    cur.addEventListener('status', (m) => {
      if (es !== cur) return;
      const v = String(m && m.data).trim();
      if ((v === 'up' || v === 'down') && v !== s.daemon) {
        s.daemon = v;
        emit('conn', s.conn, s.daemon);
      }
    });
    cur.onerror = () => {
      if (es !== cur) return;
      if (s.conn === 'live') setConn('connecting');             // the browser is reconnecting by itself
      if (!lostId && s.conn !== 'lost') {
        lostId = env.setTimeout(() => { lostId = 0; setConn('lost'); }, LIMITS.lost);
      }
      if (cur.readyState === 2) {                               // the browser gave up (the server refused): try again
        cur.close();
        es = null;
        retryId = env.setTimeout(() => { retryId = 0; if (!es) connect(url); }, LIMITS.retry);
      }
    };
  }

  s.start = (u = 'events') => {
    if (es || retryId) return;
    connect(u);
    s.replaying = true;
    if (!unsubUI) unsubUI = onUI(syncSel);
  };

  s.stop = () => {
    if (es) { es.onopen = es.onmessage = es.onerror = null; es.close(); es = null; }
    for (const id of [lostId, retryId, replayId, fbId]) if (id) env.clearTimeout(id);
    if (rafId && env.caf) env.caf(rafId);
    lostId = retryId = replayId = fbId = rafId = 0;
    if (unsubUI) { unsubUI(); unsubUI = null; }
  };

  // Tests swap the clock, the timers, the frame scheduler and the EventSource class here.
  s.configure = (patch) => {
    Object.assign(env, patch);
    if (patch.mono || patch.wall) anchor = { mono: env.mono(), wall: env.wall() + s.skew };
  };

  return s;
}

export const store = createStore();
