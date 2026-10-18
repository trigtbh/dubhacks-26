// Search over the retained records. No DOM, no state, built to stay under a few milliseconds for
// a thousand records: one compiled query, one substring test per term over a text blob each record
// carries from the moment it is created (rec.hay, lowercase).
//
// A query is words separated by spaces, all of which must match. A word of the form scope:text
// narrows where it must match:
//   user:    name, uid and account type          origin:  agent, ssh, service, local, and its detail
//   cwd:     working directory                   path:    program path, inferred files, quarantine files
//   sudo:    none, some, all, nopasswd, ...      status:  block, hold (held), allow (a held command that was allowed)
import { parts } from './context.js';

const SCOPES = new Set(['user', 'origin', 'cwd', 'path', 'sudo', 'status']);
const STATUS_WORDS = { block: ['block', 'blocked'], hold: ['hold', 'held'], allow: ['allow', 'allowed'] };

// Lowercase fields of a record. Records made by the store carry them (rec.hp); for any other
// record they are built once and remembered.
const made = new WeakMap();
function fields(rec) {
  if (rec.hp) return rec.hp;
  let p = made.get(rec);
  if (!p) { p = parts(rec.ctx, rec.ev); made.set(rec, p); }
  return p;
}
const hayOf = (rec) => (typeof rec.hay === 'string' ? rec.hay : fields(rec).hay);

function statusHit(rec, v) {
  const words = STATUS_WORDS[rec.verdict];
  if (!words) return false;
  for (const w of words) if (w.startsWith(v)) return true;
  return rec.from === 'hold' && 'held'.startsWith(v);   // a held command stays "held" after it was decided
}

// One scoped word against one record.
function scoped(rec, k, v) {
  if (k === 'status') return statusHit(rec, v);
  const f = fields(rec);
  if (k === 'path') {
    if (f.path.includes(v)) return true;
    const files = rec.q && rec.q.files;
    if (files) for (const e of files.values()) if (e.lp.includes(v)) return true;
    return false;
  }
  return f[k].includes(v);
}

// q -> {terms, scopes, test(rec), hl}
//   terms   plain words, lowercase
//   scopes  {user: [..], origin: [..], ...} the values of scoped words, lowercase
//   hl      the strings to highlight in what is shown: plain words and the values of user/origin/cwd/path words
export function compile(q) {
  const terms = [];
  const scopes = {};
  const hl = [];
  const words = typeof q === 'string' ? q.toLowerCase().split(/\s+/) : [];
  for (const w of words) {
    if (!w) continue;
    const i = w.indexOf(':');
    const k = i > 0 ? w.slice(0, i) : '';
    if (SCOPES.has(k)) {
      const v = w.slice(i + 1);
      if (!v) continue;                              // "user:" while it is still being typed
      (scopes[k] || (scopes[k] = [])).push(v);
      if (k !== 'status' && k !== 'sudo') hl.push(v);
    } else {
      terms.push(w);
      hl.push(w);
    }
  }
  const sk = Object.keys(scopes);
  const empty = !terms.length && !sk.length;
  const test = (rec) => {
    if (empty) return true;
    if (terms.length) {
      const h = hayOf(rec);
      for (let i = 0; i < terms.length; i++) if (!h.includes(terms[i])) return false;
    }
    for (let a = 0; a < sk.length; a++) {
      const vs = scopes[sk[a]];
      for (let i = 0; i < vs.length; i++) if (!scoped(rec, sk[a], vs[i])) return false;
    }
    return true;
  };
  return { terms, scopes, test, hl };
}

// Where the highlight strings occur in `text`: merged, sorted [start, end) pairs, case-insensitive.
export function ranges(text, hl) {
  const out = [];
  if (!hl || !hl.length || typeof text !== 'string' || !text) return out;
  const low = text.toLowerCase();
  if (low.length !== text.length) return out;      // case folding moved the offsets: skip rather than point at the wrong place
  for (const h of hl) {
    for (let at = low.indexOf(h); at >= 0 && h; at = low.indexOf(h, at + h.length)) out.push([at, at + h.length]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

let lastQ = null, lastC = null;

// Records newest first (an array as store.list() returns, or a Map such as store.recs, which is
// walked from its end), a query, and the status flags {block, hold, allow}.
//   ids       up to `limit` ids of the records that match the query and whose status flag is on, newest first
//   total     how many match the query with the flags applied
//   byStatus  how many match the query per verdict, before the flags
export function run(recs, q, flags, limit = 200) {
  let c = lastC;
  if (q !== lastQ || !c) { c = lastC = compile(q); lastQ = q; }
  const list = recs instanceof Map ? Array.from(recs.values()).reverse() : recs;
  const byStatus = { block: 0, hold: 0, allow: 0 };
  const ids = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || !c.test(r)) continue;
    const v = r.verdict;
    if (byStatus[v] !== undefined) byStatus[v]++;
    if (flags && flags[v] === false) continue;
    total++;
    if (ids.length < limit) ids.push(r.id);
  }
  return { ids, total, byStatus };
}
