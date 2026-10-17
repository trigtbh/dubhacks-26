// The sid dashboard: plain DOM, no framework. It listens to /events and keeps a
// short list of rows; a click on a row opens its detail panel.
//
// Everything in an event is text an attacker may have chosen (it is the command line
// of whatever ran), so it only ever reaches the page through textContent. The one
// HTML string used is the design system's verdict chip, built from fixed words.
import '../design/bundle.js';

const C = window.Crystal;
const MAX_ROWS = 200;
const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const feed = $('feed'), stateEl = $('state'), side = $('side'), toggle = $('allowed'), announce = $('announce');

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const store = (k, v) => {
  try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch { return null; }
};

// Night unless the system asks for light. ?theme=night or ?theme=paper overrides.
const asked = /[?&]theme=(night|paper)(&|$)/.exec(location.search);
const light = matchMedia('(prefers-color-scheme: light)');
const paintTheme = () => {
  const t = asked ? asked[1] : light.matches ? 'paper' : 'night';
  root.dataset.theme = t;
  root.style.colorScheme = t === 'paper' ? 'light' : 'dark';
};
paintTheme();
light.addEventListener('change', paintTheme);

// ---- what an event says in words ----------------------------------------------

const cmd = (ev) => (Array.isArray(ev.argv) && ev.argv.length ? ev.argv.join(' ') : ev.path || ev.file || '');
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

const clock = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return isNaN(d) ? '' : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// One plain sentence about who ran it: "Run by ops over SSH from 198.51.100.24".
function who(ev) {
  const o = ev.origin || {};
  const user = ev.user || `uid ${ev.uid}`;
  const el = h('span', 'cr-meta');
  const say = (s) => el.append(s);
  const code = (s) => el.append(h('span', 'cr-code', s));
  let kind = o.type || 'local';
  if (kind === 'local' && ev.via_ssh) kind = 'ssh';
  say('Run by ');
  if (kind === 'service') {
    const name = ev.service || o.detail;
    say(name ? 'the ' : 'a service as ');
    if (name) { code(name); say(' service as '); }
    code(user);
  } else if (kind === 'ssh') {
    code(user);
    say(' over SSH');
    if (/^[0-9a-f:.]+$/i.test(o.detail || '') && /[.:]/.test(o.detail)) { say(' from '); code(o.detail); }
  } else if (kind === 'agent') {
    code(user);
    say(' through a coding agent');
  } else {
    code(user);
  }
  if (typeof ev.latency_ms === 'number' && ev.latency_ms < 1) say(`, decided in ${Math.max(0.1, ev.latency_ms).toFixed(1)} ms`);
  return el;
}

// ---- rows and the detail panel --------------------------------------------------

function row(ev) {
  const b = h('button', `cr-row cr-row--${ev.verdict}`);
  b.type = 'button';
  b.setAttribute('role', 'listitem');
  b.dataset.id = ev.id;
  b.insertAdjacentHTML('afterbegin', C.chip(ev.verdict));
  const mid = h('span');
  mid.append(h('span', 'cr-argv', cmd(ev)), who(ev));
  if (ev.verdict === 'block' && ev.reason) mid.append(h('span', 'cr-reason', ev.reason));
  b.append(mid, h('span', 'cr-time', clock(ev.time)));
  return b;
}

const DECIDERS = { exploration: 'Sandbox run', explore: 'Sandbox run' };

// Facts worth a name, left out when the log has nothing for them.
function facts(ev) {
  const out = [];
  const add = (name, value) => { if (value) out.push([name, value]); };
  add('Decided by', DECIDERS[ev.decided_by] || cap(ev.decided_by));
  if (typeof ev.score === 'number')
    add('Risk score', ev.score_after != null ? `${ev.score}, then ${ev.score_after} after the sandbox run` : String(ev.score));
  add('User', ev.user && { code: ev.user });
  const parent = (ev.parent_chain || []).find((p) => p.pid === ev.ppid);
  add('Started by', parent && base(parent.exe) && { code: base(parent.exe) });
  add('ATT&CK', ev.attack_id && { code: ev.attack_id });
  return out;
}

function detail(ev) {
  const s = h('section', 'cr-detail cr-cut');
  const head = h('div', 'dhead');
  head.insertAdjacentHTML('beforeend', C.chip(ev.verdict));
  const name = base(ev.argv && ev.argv[0] || ev.path || ev.file);
  if (name) {
    const t = h('h3', 'cr-title', name);
    t.id = 'dt';
    s.setAttribute('aria-labelledby', 'dt');
    head.append(t);
  }
  s.append(head, h('div', 'cr-well', cmd(ev)));

  const effects = Array.isArray(ev.effects) ? ev.effects : [];
  if (effects.length) {
    const ul = h('ul', 'cr-effects');
    for (const e of effects) ul.append(h('li', e && e.hit ? 'hit' : '', typeof e === 'string' ? e : e && e.text));
    s.append(ul);
  }
  if (ev.reason) s.append(h('p', ev.verdict === 'block' ? 'why--block' : '', ev.reason));

  const rows = facts(ev);
  if (rows.length) {
    const dl = h('dl', 'cr-fields');
    for (const [k, v] of rows) {
      const d = h('div');
      d.append(h('dt', '', k), h('dd', v.code ? 'cr-code' : '', v.code || v));
      dl.append(d);
    }
    s.append(dl);
  }
  return s;
}

// ---- the idle shader --------------------------------------------------------------
// ShaderGradient with three.js is 1.2 MB, so it is fetched only when the dashboard has
// nothing to show, and let go of as soon as there is something.

let shader = null;
let shaderLib = 0;  // 0 not asked for, 1 loading, 2 ready
const waiting = [];

function loadShader(then) {
  if (shaderLib === 2) return then();
  waiting.push(then);
  if (shaderLib) return;
  shaderLib = 1;
  const s = document.createElement('script');
  s.src = 'shader.js';
  s.onload = () => { shaderLib = 2; waiting.splice(0).forEach((f) => f()); };
  s.onerror = () => { shaderLib = 0; waiting.length = 0; };  // the solid ground stays
  document.head.append(s);
}

let selected = null;  // the event in the detail panel
let current = null;   // its row, while that row is still on screen
let idle = false;     // connected, and nothing to show yet

function paintSide() {
  if (shader) { shader.stop(); shader = null; }
  side.textContent = '';
  if (selected) {
    side.append(detail(selected));
  } else if (idle) {
    const host = h('div', 'cr-shader');
    host.setAttribute('aria-hidden', 'true');
    side.append(host);
    loadShader(() => { if (host.isConnected && !shader) shader = C.shader(host, { preset: 'tide' }); });
  }
}

function select(rowEl) {
  if (current) current.removeAttribute('aria-current');
  if (current === rowEl) {
    current = selected = null;
  } else {
    current = rowEl;
    selected = events.get(rowEl.dataset.id);
    rowEl.setAttribute('aria-current', 'true');
  }
  paintSide();
  if (selected && !matchMedia('(min-width: 900px)').matches) side.scrollIntoView({ block: 'nearest' });
}

// ---- the feed ---------------------------------------------------------------------

const events = new Map();  // id -> event, for the rows on screen
let blocked = 0;           // rows on screen that are not allowed
let hideAllowed = store('sid.hideAllowed') === '1';
let queue = [], timer = 0;

function removeRow(el) {
  const ev = events.get(el.dataset.id);
  events.delete(el.dataset.id);
  if (ev && ev.verdict !== 'allow') blocked--;
  if (el === current) current = null;  // the panel keeps showing it
  el.remove();
}

// Rows are added in batches, so a burst of commands costs one layout.
function flush() {
  timer = 0;
  let batch = queue;
  queue = [];
  if (batch.length > MAX_ROWS) {  // a flood: keep every non-allowed event, then the newest allowed ones
    let room = MAX_ROWS;
    batch = batch.reverse().filter((e) => e.verdict !== 'allow' || room-- > 0).reverse();
  }
  const frag = document.createDocumentFragment();
  for (let i = batch.length - 1; i >= 0; i--) {
    const ev = batch[i];
    if (events.has(ev.id)) continue;
    events.set(ev.id, ev);
    if (ev.verdict !== 'allow') {
      blocked++;
      if (Date.now() - Date.parse(ev.time) < 10000)
        announce.textContent = `${ev.verdict === 'block' ? 'Blocked' : 'Held'}: ${cmd(ev)}`;
    }
    frag.append(row(ev));
  }
  feed.prepend(frag);
  while (feed.childElementCount > MAX_ROWS) removeRow(feed.lastElementChild);
  if (idle && events.size) { idle = false; paintSide(); }
  paintFeed();
}

function paintFeed() {
  feed.hidden = !events.size;
  feed.toggleAttribute('data-hide', hideAllowed);
  toggle.hidden = !events.size;
  toggle.textContent = hideAllowed ? 'Show allowed' : 'Hide allowed';
  paintState();
}

feed.addEventListener('click', (e) => {
  const el = e.target.closest('.cr-row');
  if (el) select(el);
});
toggle.addEventListener('click', () => {
  hideAllowed = !hideAllowed;
  store('sid.hideAllowed', hideAllowed ? '1' : '0');
  paintFeed();
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !selected) return;
  if (current) current.removeAttribute('aria-current');
  current = selected = null;
  paintSide();
});

// ---- states: a title and a moving pattern, nothing more ---------------------------

let conn = 'connecting';  // connecting | live | lost
let guardUp = true;       // sid-daemon is running, as far as sid-web can tell
let waited = false;       // connecting has taken long enough to be worth showing
let stateKey = '', art = null;

function paintState() {
  const key = conn === 'lost' || !guardUp ? 'down'
    : conn === 'connecting' ? (waited ? 'wait' : '')
    : !events.size ? 'none'
    : hideAllowed && !blocked ? 'quiet' : '';
  if (key === stateKey) return;
  stateKey = key;
  if (art) { art.stop(); art = null; }
  stateEl.textContent = '';
  if (!key) return;

  const box = h('div', 'cr-state');
  const pic = h('div', 'cr-art');
  const title = h('h4', '', { down: 'Daemon unreachable', wait: 'Connecting to the daemon', none: 'No events yet', quiet: 'Nothing blocked or held' }[key]);
  if (key === 'wait') {
    box.setAttribute('role', 'status');
    box.append(title, h('div', 'cr-loading'));
  } else {
    if (key === 'down') {
      box.classList.add('cr-state--error');
      box.setAttribute('role', 'alert');
      pic.classList.add('cr-art--narrow');
    } else {
      pic.classList.add('cr-art--wide');
    }
    box.append(pic, title);
  }
  stateEl.append(box);
  if (key === 'down') art = C.patterns.play(pic, 'brokenRing', { size: 40, rings: 3, segments: 6, alerts: 1, tone: 'strong' });
  else if (key !== 'wait') art = C.patterns.play(pic, 'signalDecay', { width: 240, height: 40, lines: 4, tone: 'quiet' });
}

// ---- the connection ---------------------------------------------------------------

let idleTimer = 0, lostTimer = 0;
const valid = (ev) => ev && typeof ev.id === 'string' && (ev.verdict === 'allow' || ev.verdict === 'hold' || ev.verdict === 'block');

function connect() {
  const es = new EventSource('events');
  es.onopen = () => {
    clearTimeout(lostTimer);
    conn = 'live';
    paintState();
    // A browser that has just connected is sent the recent past first; wait for it
    // before deciding there is nothing to show.
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!events.size && !queue.length && !idle) { idle = true; paintSide(); }
    }, 600);
  };
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (!valid(ev)) return;
    queue.push(ev);
    if (!timer) timer = setTimeout(flush, 60);
  };
  es.addEventListener('status', (m) => { guardUp = m.data !== 'down'; paintState(); });
  es.onerror = () => {
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => { conn = 'lost'; paintState(); }, 1500);
    if (es.readyState === EventSource.CLOSED) {  // the browser gave up (the server refused): try again
      es.close();
      setTimeout(connect, 3000);
    }
  };
}

setTimeout(() => { waited = true; paintState(); }, 400);
paintFeed();
connect();
