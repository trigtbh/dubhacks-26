// The sid dashboard shell: opens the stream, picks the theme and mounts the bar, feed and stage.
// Event text only ever reaches the page through textContent.
import { store } from './store.js';
import { ui, setUI, onUI } from './ui.js';
import * as shapes from './shapes.js';
import * as search from './search.js';
import * as decide from './decide.js';
import { mountBar } from './bar.js';
import { mountFeed } from './feed.js';
import { mountStage } from './live.js';

store.start();

const root = document.documentElement, $ = (id) => document.getElementById(id);
const asked = /[?&]theme=(night|paper)(&|$)/.exec(location.search);
const theme = asked ? asked[1] : matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'night';
root.dataset.theme = theme;
setUI({ theme });

// The loading bar shows while connecting, reconnecting or replaying the recent log.
const busy = () => { root.dataset.busy = store.conn !== 'live' || store.replaying ? '1' : '0'; };
busy();
store.on('conn', busy);

const deps = { store, ui, shapes, search, decide };
const wall = $('wall'), barEl = $('bar');

// Mobile shows one pane at a time: the list, or the stage after a person picks a command.
let view = 'list', auto = false, cleared = false, shown = null;
const setView = (v) => { view = wall.dataset.view = barEl.dataset.view = v; };
setView('list');
const select = (id) => { auto = true; setUI({ sel: id }); auto = false; };

const feed = mountFeed($('feed'), deps);
const bar = mountBar(barEl, { ...deps, back: () => setView('list') });
const stage = mountStage($('stage'), deps);

onUI((u) => {
  // Only react to a selection change. Reacting to every ui change (e.g. typing in
  // the search box, which updates ui.q) would flip to the stage view on each
  // keystroke and, on narrow viewports, hide the list and the search box so the
  // results never appear to filter.
  if (u.sel === shown) return;
  shown = u.sel;
  stage.show(u.sel);
  if (!auto && u.sel) { cleared = false; setView('stage'); }
});

// Select the oldest undecided hold, else the newest record, unless a person has chosen or cleared.
const waiting = (r) => r.verdict === 'hold' && !r.decision && /^(queued|investigating|report)$/.test(store.state(r));
function pick() {
  if (store.replaying) return;
  if (ui.sel && store.recs.has(ui.sel)) return;
  if (!ui.sel && cleared) return;
  let id = null;
  for (let i = store.order.length - 1; i >= 0 && !id; i--) if (waiting(store.recs.get(store.order[i]))) id = store.order[i];
  select(id || store.order[0] || null);
}

// Announcements: polite for a new block or hold, assertive when a report is ready. Never during the replay.
const say = (el, t) => { el.textContent = t; };
const cmd = (id) => { const r = store.recs.get(id), c = r && r.ctx && r.ctx.command; return c ? String(c).slice(0, 80) : id; };
store.on('rec', (id, kind) => {
  if (store.replaying) return;
  const r = store.recs.get(id);
  if (kind === 'new' && r) say($('say'), (r.verdict === 'block' ? 'Blocked: ' : 'Held: ') + cmd(id));
});
store.on('q', (id, kind) => {
  const rec = store.recs.get(id);
  if ((kind === 'end' || (kind === 'review' && rec && rec.review && rec.review.finished)) && !store.replaying) {
    say($('alert'), 'Report ready for ' + cmd(id) + '. Allow or block?');
  }
});

let tick = 0;
function frame() {
  tick = 0;
  pick();
}
const later = () => { if (!tick) tick = requestAnimationFrame(frame); };
store.on('rec', later);
store.on('conn', later);

addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.sel && !e.defaultPrevented) {
    cleared = true; setUI({ sel: null }); setView('list');
  } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) {
    const i = barEl.querySelector('input');
    if (i) { e.preventDefault(); i.focus(); }
  }
});

if (DEBUG) window.__sid = { store, ui, feed, bar, stage };
