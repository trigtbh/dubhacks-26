// The command list: one row per blocked or held command, newest first. A row says what ran, who ran it
// and where, what happened to it, and (as discs) how sure the classifier was. Event text only reaches the
// page through textContent.
import { setUI, onUI } from './ui.js';
import { probMark } from './mark.js';
import { clock, mmss, originParts, userText } from './fmt.js';
import { fadeChange, fadeRemove, fadeRestore, setVisible } from './fade.js';

const PAGE = 150;
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
// What the chip shows: the verdict, or what a person decided for a held command.
const vOf = (r) => (r.decision ? r.decision.verdict : r.verdict);
const replay = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

export function mountFeed(host, { store, ui, search, shapes }) {
  const rows = new Map();   // id -> row parts
  let shown = PAGE, raf = 0, more = null, none = null;

  function note(rec) {
    if (rec.decision) return [`Held command, then ${rec.decision.verdict === 'allow' ? 'allowed' : 'blocked'}`, 'is-' + rec.decision.verdict];
    if (rec.verdict === 'block') return ['', ''];
    if (rec.pending) return ['Sending decision…', 'is-busy'];
    if (rec.review) return rec.review.finished ? ['Simulation ready for review', 'is-need']
      : store.daemon === 'down' ? ['Simulation unavailable', 'is-warn']
      : rec.review.summary ? ['Simulating command', 'is-busy'] : ['Starting simulation…', 'is-busy'];
    const st = store.state(rec);
    if (st === 'queued') return ['Starting quarantine…', 'is-busy'];
    if (st === 'investigating') { const r = store.remaining(rec); return [r > 0 ? `Investigating, ${mmss(r)} left` : 'Finishing…', 'is-busy']; }
    if (st === 'report') return ['Report ready, waiting for you', 'is-need'];
    if (st === 'noreport') return ['No report from the quarantine', 'is-warn'];
    return ['Held', ''];
  }

  function build(rec) {
    const el = h('button', 'tl cr-cut');
    el.type = 'button';
    el.dataset.id = rec.id;
    const chip = shapes.chip(vOf(rec));
    const time = h('span', 'tl-time');
    const timeValue = h('time', 'tl-time-value');
    time.append(h('span', 'kv-k', 'Local time'), timeValue);
    const cmd = h('span', 'tl-cmd');
    const command = h('span', 'tl-command');
    command.append(h('span', 'kv-k', 'Command'), cmd);
    const who = h('span', 'tl-who');
    const user = h('span', 'kv-v'), origin = h('span', 'kv-v'), detail = h('span', 'kv-v');
    const gUser = shapes.glyph('user-human', 14, 'kv-i'), gOrigin = shapes.glyph('unknown', 14, 'kv-i'), gDetail = shapes.glyph('unknown', 14, 'kv-i');
    const pair = (glyph, label, value, cls = '') => {
      const box = h('span', 'kv' + (cls ? ' ' + cls : ''));
      box.append(glyph, h('span', 'kv-k', label), value);
      return box;
    };
    const detailLabel = h('span', 'kv-k');
    const detailBox = h('span', 'kv kv--wide');
    detailBox.hidden = true;
    detailBox.append(gDetail, detailLabel, detail);
    who.append(pair(gUser, 'User account', user), pair(gOrigin, 'Origin', origin), detailBox);
    const nt = h('span', 'tl-note');
    const mark = probMark(rec.model && rec.model.probabilities);
    const top = h('span', 'tl-top');
    top.append(chip);
    const main = h('span', 'tl-main');
    main.append(top, command, who, nt);
    const side = h('span', 'tl-side');
    const model = h('span', 'tl-model');
    model.append(mark.el);
    side.append(time, model);
    el.append(main, side);
    return { el, chip, timeValue, cmd, user, origin, detail, detailLabel, detailBox, gOrigin, gDetail, oi: 'unknown', di: 'unknown', nt, mark, probKey: JSON.stringify(rec.model && rec.model.probabilities || null), v: vOf(rec), key: '', ncls: null, seen: false };
  }

  // The command with the search matches marked, built from text nodes.
  function paintCmd(r, text, hl) {
    const key = text + ' | ' + hl.join('|');
    if (r.key === key) return;
    r.key = key;
    const rs = search.ranges(text, hl);
    const frag = document.createDocumentFragment();
    if (!rs.length) frag.append(text);
    else {
      let at = 0;
      for (const [s, e] of rs) {
        if (s > at) frag.append(text.slice(at, s));
        frag.append(h('mark', '', text.slice(s, e)));
        at = e;
      }
      if (at < text.length) frag.append(text.slice(at));
    }
    if (r.seen) fadeChange(r.cmd, () => r.cmd.replaceChildren(frag));
    else r.cmd.replaceChildren(frag);
  }

  // The status line fades up when its words change.
  function setNote(r, t, cls) {
    const changed = r.nt.textContent !== t;
    const update = () => {
      if (changed) r.nt.textContent = t;
      if (cls !== r.ncls) { r.ncls = cls; r.nt.className = 'tl-note ' + cls; }
      r.nt.hidden = !t;
    };
    if (changed && r.seen && !r.nt.hidden) fadeChange(r.nt, update);
    else { r.nt.hidden = false; if (changed && r.seen) fadeChange(r.nt, update); else update(); }
    r.seen = true;
  }

  function setValue(r, el, value) {
    if (el.textContent === value) return;
    if (r.seen) fadeChange(el, () => { el.textContent = value; });
    else el.textContent = value;
  }

  function paint(r, rec, hl) {
    const v = vOf(rec);
    if (v !== r.v) { r.v = v; shapes.morph(r.chip, v); }
    r.el.dataset.v = v;
    const stamp = new Date(rec.time);
    r.timeValue.textContent = clock(rec.time) || 'Not recorded';
    r.timeValue.dateTime = isNaN(stamp) ? '' : stamp.toISOString();
    paintCmd(r, rec.ctx.command || 'Not recorded', hl);
    setValue(r, r.user, userText(rec.ctx.user));
    const origin = originParts(rec.ctx.origin);
    setValue(r, r.origin, origin.kind);
    setValue(r, r.detail, origin.detail || 'Not recorded');
    setValue(r, r.detailLabel, origin.detailLabel);
    setVisible(r.detailBox, !!origin.detailLabel);
    if (r.oi !== origin.icon) { r.oi = origin.icon; shapes.reglyph(r.gOrigin, origin.icon); }
    if (r.di !== origin.detailIcon) { r.di = origin.detailIcon; shapes.reglyph(r.gDetail, origin.detailIcon); }
    const [t, cls] = note(rec);
    setNote(r, t, cls);
    const probabilityKey = JSON.stringify(rec.model && rec.model.probabilities || null);
    if (probabilityKey !== r.probKey) {
      r.probKey = probabilityKey;
      const apply = () => r.mark.set(rec.model && rec.model.probabilities);
      if (r.seen) fadeChange(r.mark.el, apply); else apply();
    }
    const sel = ui.sel === rec.id;
    if (sel) r.el.setAttribute('aria-current', 'true'); else r.el.removeAttribute('aria-current');
  }

  function render() {
    raf = 0;
    const res = search.run(store.recs, ui.q, ui.flags, shown);
    const hl = search.compile(ui.q).hl || [];
    const want = [];
    for (const [idx, id] of res.ids.entries()) {
      const rec = store.recs.get(id);
      if (!rec) continue;
      let r = rows.get(id);
      if (!r) {
        r = build(rec);
        rows.set(id, r);
        // New rows rise in, one after another; the class comes off when the animation ends.
        r.el.style.setProperty('--i', String(Math.min(idx, 12)));
        r.el.classList.add('is-new');
        r.el.addEventListener('animationend', (e) => { if (e.target === r.el) r.el.classList.remove('is-new'); });
      }
      paint(r, rec, hl);
      want.push(r.el);
    }
    const seen = new Set(res.ids);
    for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);

    if (store.recs.size && !want.length) {
      if (!none) none = h('p', 'tl-none', 'No commands match');
      want.push(none);
    }
    if (res.total > res.ids.length) {
      if (!more) { more = h('button', 'tl-more', ''); more.type = 'button'; }
      const label = `Show ${Math.min(PAGE, res.total - res.ids.length)} more`;
      if (more.textContent !== label) fadeChange(more, () => { more.textContent = label; });
      want.push(more);
    }
    // Fade removed rows out, while keeping the visible rows and their scroll/focus state in place.
    const wanted = new Set(want);
    for (const child of [...host.children]) if (!wanted.has(child)) fadeRemove(child);
    for (const child of want) fadeRestore(child);
    // Reorder in place so the scroll position and any focus stay put.
    for (let i = 0; i < want.length; i++) if (host.children[i] !== want[i]) host.insertBefore(want[i], host.children[i] || null);
  }

  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };

  host.addEventListener('click', (e) => {
    const b = e.target.closest('.tl, .tl-more');
    if (!b) return;
    if (b === more) { shown += PAGE; schedule(); return; }
    setUI({ sel: b.dataset.id });
  });

  const subs = [
    store.on('rec', schedule),
    store.on('q', (id, kind) => { if (kind === 'start' || kind === 'end' || kind === 'review') schedule(); }),
    store.on('conn', schedule),
  ];
  // Reset the page size when the search or filters change, then redraw.
  let lastQ = ui.q, lastF = '';
  const offUI = onUI(() => {
    const f = JSON.stringify(ui.flags);
    if (ui.q !== lastQ || f !== lastF) { lastQ = ui.q; lastF = f; shown = PAGE; }
    schedule();
  });
  const tick = setInterval(() => { for (const [id, r] of rows) { const rec = store.recs.get(id); if (rec && !rec.decision && rec.verdict === 'hold') { const [t, cls] = note(rec); setNote(r, t, cls); } } }, 1000);
  schedule();

  return {
    refresh: schedule,
    scrollToTop: () => { host.scrollTop = 0; },
    destroy: () => { subs.forEach((u) => u && u()); offUI(); clearInterval(tick); host.replaceChildren(); },
  };
}

