// Sending a person's decision about a held command to sid-web, and waiting for the daemon to say so.
//
// POST /decide only queues the decision (202). The record changes when the settle line arrives
// over the event stream, never because the POST succeeded, so a 202 starts a clock: if no settle
// comes within CONFIRM_MS the record says the daemon has not confirmed, and retrying is safe
// (the server treats a repeated identical decision as a duplicate).
import { store as defaultStore } from './store.js';

export const CONFIRM_MS = 8000;

// What a failure is called on the record (rec.failed) and what the page may say about it.
export const MESSAGES = {
  unconfirmed: 'sid-daemon has not confirmed; retry is safe',
  forbidden: 'sid-web refused the request; reload the page',
  'bad-request': 'sid-web did not accept the request',
  'not-held': 'sid-web does not know this command as held',
  unavailable: 'Decisions are switched off: sid-web cannot write the decisions file',
  network: 'Could not reach sid-web',
  error: 'sid-web answered with an unexpected error',
};

// HTTP status -> failure code. 409 is not a failure: someone already decided.
function codeFor(status) {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-held';
  if (status === 503) return 'unavailable';
  if (status === 400 || status === 405 || status === 411 || status === 413 || status === 415) return 'bad-request';
  return 'error';
}

// The pieces a test replaces.
const env = {
  fetch: null,
  store: defaultStore,
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h),
  confirmMs: CONFIRM_MS,
};
const waits = new Map();   // id -> timer of the confirmation clock

export function configure(patch) {
  Object.assign(env, patch);
}

export function setFetch(fn) {
  env.fetch = fn;
}

function stopWait(id) {
  const h = waits.get(id);
  if (h !== undefined) { env.clearTimeout(h); waits.delete(id); }
}

// 'ok'        accepted; the record changes when the settle line arrives
// 'conflict'  already decided (a different decision, or a first one still being written): wait for the settle line
// 'failed'    nothing was queued; rec.failed says why
export async function decide(id, verdict) {
  const S = env.store;
  if (typeof id !== 'string' || id === '' || (verdict !== 'allow' && verdict !== 'block')) return 'failed';
  stopWait(id);
  S.setPending(id, verdict);

  const f = env.fetch || (typeof fetch === 'function' ? fetch : null);
  let res;
  try {
    if (!f) throw new Error('no fetch');
    res = await f('decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sid-Request': '1' },
      body: JSON.stringify({ id, verdict }),
    });
  } catch (e) {
    S.setPending(id, null, 'network');
    return 'failed';
  }

  const status = res && res.status;
  if (status >= 200 && status < 300) {
    const h = env.setTimeout(() => {
      waits.delete(id);
      const r = S.recs.get(id);
      if (r && !r.decision && r.pending === verdict) S.setPending(id, null, 'unconfirmed');
    }, env.confirmMs);
    waits.set(id, h);
    return 'ok';
  }
  if (status === 409) {
    S.setPending(id, null);
    return 'conflict';
  }

  let off = status === 503;
  try {
    const body = res && typeof res.json === 'function' ? await res.json() : null;
    if (body && body.decide === false) off = true;
  } catch (e) { /* an error page, not JSON: the status is enough */ }
  if (off) S.setCanDecide(false);
  S.setPending(id, null, codeFor(status));
  return 'failed';
}

decide.setFetch = setFetch;
decide.configure = configure;
decide.MESSAGES = MESSAGES;
