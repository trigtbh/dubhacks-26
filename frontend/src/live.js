// The stage: the selected command in full. For a held command it also shows the quarantine as it runs
// (countdown, live output, file changes), the summary when the run ends, and the Allow and Block buttons.
// Event text only reaches the page through textContent.
import { probMark } from './mark.js';
import { mmss, clock, originParts, userText, SUDO, capsText, OPS, FILEOP } from './fmt.js';
import { fadeChange, fadeRemove, fadeIn, setVisible } from './fade.js';

// Output is shown without terminal escapes or invisible and reordering characters (newline and tab stay).
const INV = [[0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('');
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
const CTRL = new RegExp('[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f' + INV + ']', 'g');
const clean = (s) => String(s).replace(ANSI, '').replace(CTRL, '');

const NS = 'http://www.w3.org/2000/svg';
const RING = 52, CIRC = 2 * Math.PI * RING;
const ARM_MS = 700;   // the buttons stay locked this long after the report appears, against mis-clicks

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const vOf = (r) => (r.decision ? r.decision.verdict : r.verdict);
// Restart a CSS animation on an element (its class is removed, the layout is read, the class is added back).
const replay = (e, cls) => { e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls); };
const changeText = (e, text, cls = 'is-swap') => {
  if (e.textContent === text) return;
  if (cls === 'is-swap') fadeChange(e, () => { e.textContent = text; });
  else { e.textContent = text; if (e.isConnected) replay(e, cls); }
};
// A line or row that has just been added fades up; the class comes off when its animation ends.
const fresh = (e) => {
  e.classList.add('is-new');
  e.addEventListener('animationend', () => e.classList.remove('is-new'), { once: true });
};
const kb = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB');
const fileFields = (row, f, showPath = (p) => p) => {
  const add = (label, value, cls = '') => row.append(h('span', 'lv-key', label), h('span', cls, value));
  add('Action', OPS[f.op] || 'Not recorded', 'lv-fo is-' + f.op);
  if (f.op === 'move' && f.to) {
    add('From', showPath(f.path), 'lv-mono');
    add('To', showPath(f.to), 'lv-mono');
  } else add('Path', showPath(f.path), 'lv-mono');
  if (f.bytes != null) add('Size', kb(f.bytes), 'lv-file-meta');
  const countLabel = h('span', 'lv-key', 'Count');
  const count = h('span', 'lv-file-count', f.n > 1 ? f.n + ' operations' : '');
  countLabel.hidden = count.hidden = f.n <= 1;
  row.append(countLabel, count);
  return { count, countLabel };
};
const outputLine = (r) => {
  const line = h('span', r.stream === 'stderr' ? 'e' : 'o');
  const data = h('span', 'lv-stream-data', clean(r.text));
  line.append(h('span', 'lv-stream-label', r.stream === 'stderr' ? 'stderr: ' : 'stdout: '), data);
  return { line, data };
};

export function mountStage(host, { store, shapes, decide }) {
  let id = null, rec = null, el = null, timer = 0, raf = 0, heroKey = '', full = null;
  let pendingId = null, switching = false, switchTimer = 0;
  let advanced = false;
  try { advanced = localStorage.getItem('sid-advanced') === '1'; } catch (e) { /* storage may be blocked */ }

  function teardown() {
    closeFull(false);
    clearInterval(timer); timer = 0;
    host.replaceChildren();
    el = null;
  }

  // ---- nothing selected: say what is going on -------------------------------------------------

  function paintHero() {
    const k = [store.conn, store.daemon, store.replaying, store.recs.size].join('|');
    if (k === heroKey) return;
    heroKey = k;
    const box = el.hero;
    let text, spin = false;
    if (store.conn === 'connecting') { text = 'Connecting to sid…'; spin = true; }
    else if (store.conn === 'lost') { text = 'Connection lost. Retrying…'; spin = true; }
    else if (store.daemon === 'down') text = 'Daemon unreachable';
    else if (store.replaying && !store.recs.size) { text = 'Loading recent commands…'; spin = true; }
    else text = 'Nothing blocked or held';
    const next = document.createDocumentFragment();
    if (spin) { const s = h('div', 'lv-spin'); s.setAttribute('aria-hidden', 'true'); next.append(s); }
    const p = h('p', 'lv-hero-t', text);
    p.setAttribute('role', 'status');
    next.append(p);
    if (box.childNodes.length) fadeChange(box, () => box.replaceChildren(next));
    else { box.replaceChildren(next); fadeIn(box); }
  }

  // ---- a command ---------------------------------------------------------------------------------

  function fact(dl, icon, label, value, cls) {
    const row = h('div', cls || '');
    row.style.setProperty('--fact-n', String(dl.children.length));
    row.append(shapes.glyph(icon, 18, 'lv-fi'), h('dt', '', label));
    const dd = h('dd');
    if (value instanceof Node) dd.append(value); else dd.textContent = value;
    row.append(dd);
    dl.append(row);
  }

  function build() {
    teardown();
    if (!rec) { el = { hero: h('div', 'lv-hero') }; heroKey = ''; host.append(el.hero); paintHero(); return; }
    const c = rec.ctx, u = c.user || {}, q = rec.verdict === 'hold' || rec.from === 'hold' || !!rec.q;
    el = { q, v: '', st: '', rev: -1, actKey: '', arming: false, spans: [], fileRows: new Map(), ph: null, fph: null };

    // One panel: the details scroll inside it, and Allow and Block are part of it at the bottom.
    const root = h('div', 'lv');
    el.body = h('div', 'lv-body cr-cut');
    el.body.dataset.adv = advanced ? '1' : '0';
    el.scroll = h('div', 'lv-scroll');
    el.body.append(el.scroll);
    root.append(el.body);

    el.sys = h('p', 'lv-sys');
    el.sys.hidden = true;

    const head = h('div', 'lv-head');
    el.chip = shapes.chip(vOf(rec));
    const adv = h('button', 'lv-adv', advanced ? 'Show basic details' : 'Show all details');
    adv.type = 'button';
    adv.setAttribute('aria-pressed', String(advanced));
    adv.addEventListener('click', () => {
      const rows = [...el.body.querySelectorAll('.lv-more')];
      advanced = !advanced;
      if (advanced) {
        el.body.dataset.adv = '1';
        rows.forEach((row) => { row.classList.remove('is-detail-leaving'); replay(row, 'is-content-fade-in'); });
      } else {
        rows.forEach((row) => row.classList.add('is-detail-leaving'));
        setTimeout(() => {
          if (el && el.body && !advanced) {
            el.body.dataset.adv = '0';
            rows.forEach((row) => row.classList.remove('is-detail-leaving'));
          }
        }, 180);
      }
      changeText(adv, advanced ? 'Show basic details' : 'Show all details');
      adv.setAttribute('aria-pressed', String(advanced));
      try { localStorage.setItem('sid-advanced', advanced ? '1' : '0'); } catch (e) { /* storage may be blocked */ }
    });
    const time = h('span', 'lv-time');
    const stamp = new Date(rec.time);
    const timeValue = h('time', 'lv-time-value', clock(rec.time) || 'Not recorded');
    timeValue.dateTime = isNaN(stamp) ? '' : stamp.toISOString();
    time.append(h('span', 'lv-time-label', 'Local time'), timeValue);
    head.append(el.chip, h('h2', 'lv-title', 'Command'), time, adv);

    const cmd = h('pre', 'lv-cmd', c.command || 'Not recorded');
    const reason = rec.ev && rec.ev.reason ? h('p', 'lv-reason') : null;
    if (reason) reason.append(h('span', 'lv-field-label', 'Reason'), h('span', 'lv-reason-text', String(rec.ev.reason)));
    const prob = h('div', 'lv-prob');
    el.probMark = probMark(rec.model && rec.model.probabilities);
    el.probKey = JSON.stringify(rec.model && rec.model.probabilities || null);
    prob.append(el.probMark.el);

    const main = h('div', 'lv-main');
    main.append(head, cmd);
    if (reason) main.append(reason);
    const top = h('div', 'lv-top');
    top.append(main, prob);

    // Keep identity, origin and location explicit in the default view. Advanced fields stay labeled too.
    const dl = h('dl', 'lv-facts');
    const recorded = !!c.raw;
    const userName = userText(u);
    const origin = originParts(c.origin);
    const accountType = ({ human: 'Human', service: 'Service', root: 'Root' })[u.type] || 'Not recorded';
    const groups = Array.isArray(c.groups) ? c.groups : [];
    const numericGroups = groups.length > 0 && groups.every((g) => /^\d+$/.test(g));
    fact(dl, 'user-human', 'User account', userName);
    fact(dl, origin.icon, 'Origin', origin.kind);
    if (origin.detailLabel) fact(dl, origin.detailIcon, origin.detailLabel, origin.detail || 'Not recorded');
    fact(dl, 'folder', 'Working directory', h('span', 'lv-mono', c.cwd || 'Not recorded'));
    fact(dl, 'exec', 'Executable path', h('span', 'lv-mono', c.program || 'Not recorded'));
    fact(dl, 'uid', 'User ID', u.uid != null ? String(u.uid) : 'Not recorded', 'lv-more');
    fact(dl, 'account', 'Account type', accountType, 'lv-more');
    fact(dl, 'groups', numericGroups ? 'Group IDs' : 'Groups', groups.length ? groups.join(', ') : recorded ? 'None recorded' : 'Not recorded', 'lv-more');
    fact(dl, 'sudo', 'Sudo access', SUDO[c.sudo] && c.sudo !== 'unknown' ? SUDO[c.sudo] : 'Not recorded', 'lv-more');
    const capValue = capsText(c.caps);
    fact(dl, 'caps', 'Linux capabilities', capValue, 'lv-more');
    const fl = h('ul', 'lv-fl');
    for (const f of (c.files || []).slice(0, 16)) {
      const li = h('li');
      li.append(h('span', 'lv-key', 'Action'), h('span', 'lv-fo', FILEOP[f.op] || 'Not recorded'),
        h('span', 'lv-key', 'Path'), h('span', 'lv-mono', f.path));
      fl.append(li);
    }
    if (c.filesMore) fl.append(h('li', 'lv-file-more', 'Additional paths: ' + c.filesMore + ' more'));
    fact(dl, 'files', 'Files inferred from the command', fl.children.length ? fl : recorded ? 'No file paths inferred' : 'Not available in event fields', 'lv-more lv-wide');
    const hist = h('ol', 'lv-hist');
    for (const x of (c.history || []).slice(-5)) hist.append(h('li', 'lv-mono', x));
    fact(dl, 'history', 'Recent commands', hist.children.length ? hist : recorded ? 'None recorded' : 'Not available in event fields', 'lv-more lv-wide');
    const contextSource = c.contextMismatch ? 'Structured event fields; supplied context conflicted'
      : c.contextInvalid ? 'Structured event fields; supplied context could not be read'
      : recorded ? 'Inspected command context' : 'Structured event fields';
    fact(dl, 'source', 'Context source', contextSource, 'lv-more lv-wide');

    const context = h('section', 'lv-context');
    context.append(h('h3', 'lv-section-title', 'Execution details'), dl);
    el.scroll.append(el.sys, top, context);
    if (c.suspect) el.scroll.append(h('p', 'lv-warn', c.contextMismatch
      ? 'The inspected context conflicts with event data. Context-only details are hidden; the fields above come from the event.'
      : 'The supplied command context could not be read. The fields above come from the event.'));

    if (q) {
      const sec = h('section', 'lv-q');
      el.activityTitle = h('h3', 'lv-section-title', rec.review ? 'Simulation activity' : 'Quarantine activity');
      const qh = h('div', 'lv-qhead');
      el.rb = h('div', 'lv-ringbox');
      el.rb.setAttribute('role', 'timer');
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 120 120');
      svg.setAttribute('class', 'lv-ring');
      svg.setAttribute('aria-hidden', 'true');
      for (const cls of ['lv-ring-bg', 'lv-ring-fg']) {
        const ci = document.createElementNS(NS, 'circle');
        ci.setAttribute('class', cls); ci.setAttribute('cx', 60); ci.setAttribute('cy', 60); ci.setAttribute('r', RING);
        svg.append(ci);
        el[cls] = ci;
      }
      el['lv-ring-fg'].setAttribute('stroke-dasharray', CIRC.toFixed(2));
      el.ringT = h('span', 'lv-ring-t');
      el.ringValue = h('span', 'lv-ring-value');
      el.ringCaption = h('span', 'lv-ring-caption');
      el.ringT.append(el.ringValue, el.ringCaption);
      el.rb.append(svg, el.ringT);
      el.qtxt = h('p', 'lv-qtxt');
      el.sum = h('p', 'lv-sum');
      el.sum.hidden = true;
      const qt = h('div', 'lv-qtxts');
      qt.append(el.qtxt, el.sum);
      qh.append(el.rb, qt);

      // Output and Files changed: click one to open the whole log full screen.
      const panes = h('div', 'lv-panes');
      const mkPane = (kind, title, label) => {
        const pane = h('div', 'lv-pane');
        pane.tabIndex = 0;
        pane.setAttribute('role', 'button');
        pane.setAttribute('aria-label', label);
        const n = h('span', 'lv-pn');
        const hd = h('h3', 'lv-ph');
        hd.append(h('span', '', title), h('span', 'lv-exp', 'Expand'), n);
        const open = () => openFull(kind, pane);
        pane.addEventListener('click', open);
        pane.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        return { pane, hd, n };
      };
      const po = mkPane('out', 'Output', 'Open the full output');
      const pf = mkPane('files', 'Files changed', 'Open the reported file changes');
      el.outN = po.n;
      el.filesN = pf.n;
      el.out = h('div', 'lv-out');
      el.files = h('ul', 'lv-files');
      po.pane.append(po.hd, el.out);
      pf.pane.append(pf.hd, el.files);
      panes.append(po.pane, pf.pane);

      sec.append(el.activityTitle, qh, panes);
      el.scroll.append(sec);

      // Allow and Block, part of the panel, not a bar of its own. Hidden once the command is settled.
      el.act = h('div', 'lv-act');
      el.btns = h('div', 'lv-btns');
      el.allow = h('button', 'lv-btn lv-allow cr-cut', 'Allow');
      el.block = h('button', 'lv-btn lv-block cr-cut', 'Block');
      for (const [b, v] of [[el.allow, 'allow'], [el.block, 'block']]) {
        b.type = 'button';
        b.addEventListener('click', () => {
          if (b.getAttribute('aria-disabled') === 'true' || !rec) return;
          decide.decide(rec.id, v);
        });
      }
      el.btns.append(el.allow, el.block);
      el.hint = h('p', 'lv-hint');
      el.hint.hidden = true;
      el.act.append(el.btns, el.hint);
      el.body.append(el.act);
    }
    // Each section rises in, one after the other.
    [...el.scroll.children].forEach((ch, i) => ch.style.setProperty('--n', String(i)));
    host.append(root);
    paint();
  }

  // ---- the full-screen log ----------------------------------------------------------------------------

  function openFull(kind, opener) {
    closeFull(false);
    const root = h('div', 'lv-full');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    const title = kind === 'out' ? 'Output' : 'Files changed';
    root.setAttribute('aria-label', title);
    const bar = h('div', 'lv-full-bar');
    const meta = h('span', 'lv-full-meta');
    const close = h('button', 'lv-full-close', 'Close');
    close.type = 'button';
    bar.append(h('h2', 'lv-full-title', title), meta, close);
    const body = h('div', kind === 'out' ? 'lv-fout' : 'lv-ffiles');
    body.tabIndex = 0;
    root.append(bar, body);
    document.body.append(root);
    full = { kind, root, body, meta, opener, rev: -2, outputRows: [], fileRows: new Map(), placeholder: null, warning: null };
    close.addEventListener('click', () => closeFull(true));
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFull(true); } });
    paintFull();
    close.focus();
  }

  function closeFull(restore) {
    if (!full) return;
    const f = full, o = f.opener;
    full = null;
    fadeRemove(f.root, () => { if (restore && o && o.isConnected) o.focus(); });
  }

  function paintFull() {
    if (!full || !rec) return;
    const qd = rec.q, f = full;
    f.rev = qd ? qd.rev : -1;
    if (f.kind === 'out') {
      const stuck = f.body.scrollTop + f.body.clientHeight >= f.body.scrollHeight - 24;
      const runs = qd ? qd.out : [];
      while (f.outputRows.length > runs.length) fadeRemove(f.outputRows.pop().line);
      for (let i = 0; i < runs.length; i++) {
        const text = clean(runs[i].text);
        if (!f.outputRows[i]) {
          const item = outputLine(runs[i]);
          fresh(item.line);
          f.outputRows[i] = item;
          f.body.append(item.line);
        } else if (f.outputRows[i].data.textContent !== text) {
          fadeChange(f.outputRows[i].data, () => { f.outputRows[i].data.textContent = text; });
        }
      }
      if (!runs.length) {
        if (!f.placeholder) { f.placeholder = h('span', 'lv-empty'); f.body.append(f.placeholder); fadeIn(f.placeholder); }
        changeText(f.placeholder, qd && qd.end ? 'No output reported.' : 'No output yet.');
      } else if (f.placeholder) { fadeRemove(f.placeholder); f.placeholder = null; }
      const missing = !!(qd && (qd.dropped || qd.incomplete));
      if (missing && !f.warning) { f.warning = h('span', 'lv-empty', 'Some output may be missing.'); f.body.append(f.warning); fadeIn(f.warning); }
      else if (!missing && f.warning) { fadeRemove(f.warning); f.warning = null; }
      if (stuck) f.body.scrollTop = f.body.scrollHeight;
      changeText(f.meta, qd && qd.outLines ? `${qd.outLines} lines` : '');
    } else {
      const list = qd ? [...qd.files.entries()].reverse() : [];
      const keep = new Set(list.map(([key]) => key));
      for (const [key, item] of f.fileRows) if (!keep.has(key)) { f.fileRows.delete(key); fadeRemove(item.row); }
      if (list.length && f.placeholder) { fadeRemove(f.placeholder); f.placeholder = null; }
      for (let i = 0; i < list.length; i++) {
        const [key, x] = list[i];
        let item = f.fileRows.get(key);
        if (!item) {
          const row = h('div', 'lv-ff');
          fileFields(row, x);
          item = { row, n: x.n };
          f.fileRows.set(key, item);
          fresh(row);
        } else if (item.n !== x.n) {
          item.n = x.n;
          fadeChange(item.row, () => { item.row.replaceChildren(); fileFields(item.row, x); });
        }
        const before = f.body.children[i] || null;
        if (before !== item.row) f.body.insertBefore(item.row, before);
      }
      if (!list.length && !f.placeholder) { f.placeholder = h('span', 'lv-empty', qd && qd.end ? 'No file changes reported.' : 'No file changes yet.'); f.body.append(f.placeholder); fadeIn(f.placeholder); }
      else if (!list.length) changeText(f.placeholder, qd && qd.end ? 'No file changes reported.' : 'No file changes yet.');
      changeText(f.meta, qd && qd.fileCount ? (qd.filesPushed ? `${qd.files.size} shown of ${qd.fileCount} changes` : `${qd.fileCount} changes`) : '');
    }
  }

  // ---- keeping it current ---------------------------------------------------------------------------

  // Output: lines already on screen are kept, and only the new ones are added, so each can fade up.
  function paintOut() {
    const qd = rec.q, box = el.out;
    const runs = qd ? qd.out : [];
    const stuck = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    while (runs.length < el.spans.length) fadeRemove(el.spans.pop().n);
    if (runs.length && el.ph) { fadeRemove(el.ph); el.ph = null; }
    for (let i = 0; i < runs.length; i++) {
      const t = clean(runs[i].text), cur = el.spans[i];
      if (!cur) {
        const { line, data } = outputLine(runs[i]);
        if (el.outReady) fresh(line);
        box.append(line);
        el.spans[i] = { n: line, data, t };
      } else if (cur.t !== t) { cur.t = t; fadeChange(cur.data, () => { cur.data.textContent = t; }); }
    }
    if (!runs.length) {
      const message = qd && qd.end ? 'No output reported.' : 'No output yet.';
      if (!el.ph) { el.ph = h('span', 'lv-empty'); box.append(el.ph); fadeIn(el.ph); }
      changeText(el.ph, message);
    }
    if (qd && (qd.dropped || qd.incomplete)) {
      if (!el.outWarning) { el.outWarning = h('span', 'lv-empty lv-warning', 'Some output may be missing.'); box.append(el.outWarning); fadeIn(el.outWarning); }
    } else if (el.outWarning) { fadeRemove(el.outWarning); el.outWarning = null; }
    el.outReady = true;
    if (stuck) box.scrollTop = box.scrollHeight;
    changeText(el.outN, qd && qd.outLines ? `${qd.outLines} lines` : '');
  }

  // Files: each change is one row, newest on top; a new row slides in, a repeated change updates its count.
  function paintFiles() {
    const qd = rec.q, list = qd ? [...qd.files.entries()] : [];
    const keep = new Set(list.map(([k]) => k));
    for (const [k, row] of el.fileRows) if (!keep.has(k)) { el.fileRows.delete(k); fadeRemove(row.li); }
    if (list.length && el.fph) { fadeRemove(el.fph); el.fph = null; }
    for (const [k, f] of list) {
      const have = el.fileRows.get(k);
      if (have) {
        const count = f.n > 1 ? f.n + ' operations' : '';
        if (have.count.textContent !== count) {
          have.count.hidden = have.countLabel.hidden = false;
          fadeChange(have.count, () => {
            have.count.textContent = count;
            have.count.hidden = have.countLabel.hidden = !count;
          });
        }
        continue;
      }
      const li = h('li', 'lv-file-row');
      const parts = fileFields(li, f);
      li.title = f.op === 'move' && f.to ? `Moved from ${f.path} to ${f.to}` : f.path;
      if (el.filesReady) fresh(li);
      el.files.insertBefore(li, el.files.children[0] || null);
      el.fileRows.set(k, { li, count: parts.count, countLabel: parts.countLabel });
    }
    if (!list.length) {
      const message = qd && qd.end ? 'No file changes reported.' : 'No file changes yet.';
      if (!el.fph) { el.fph = h('li', 'lv-empty'); el.files.append(el.fph); fadeIn(el.fph); }
      changeText(el.fph, message);
    }
    el.filesReady = true;
    changeText(el.filesN, qd && qd.fileCount ? (qd.filesPushed ? `${qd.files.size} shown of ${qd.fileCount} changes` : `${qd.fileCount} changes`) : '');
  }

  function paintAct(st) {
    const settled = !!rec.decision;
    const canReport = st === 'report' || st === 'noreport';
    const key = [st, rec.pending || '', rec.failed, store.canDecide, el.arming, settled].join('|');
    if (key === el.actKey) return;
    el.actKey = key;
    setVisible(el.act, !settled);   // once settled the whole block goes; the chip shows the outcome
    if (settled) return;
    const off = !canReport || !!rec.pending || !store.canDecide || el.arming;
    for (const [b, v, word, busy] of [[el.allow, 'allow', 'Allow', 'Allowing…'], [el.block, 'block', 'Block', 'Blocking…']]) {
      b.setAttribute('aria-disabled', String(off));
      b.classList.toggle('is-arming', el.arming && canReport);
      b.classList.toggle('is-busy', rec.pending === v);
      const label = rec.pending === v ? busy : word;
      changeText(b, label);
    }
    // Only a problem is worth a line under the buttons.
    const msgs = decide.MESSAGES || {};
    const hint = rec.failed ? (msgs[rec.failed] || 'The decision did not go through')
      : !store.canDecide ? (msgs.unavailable || 'Decisions are switched off') : '';
    setVisible(el.hint, !!hint);
    changeText(el.hint, hint);
  }

  function paint() {
    raf = 0;
    if (!rec) { if (el && el.hero) paintHero(); return; }
    const latest = store.recs.get(id);
    if (latest) rec = latest;
    const v = vOf(rec), st = store.state(rec);

    const probabilityKey = JSON.stringify(rec.model && rec.model.probabilities || null);
    if (probabilityKey !== el.probKey) {
      el.probKey = probabilityKey;
      fadeChange(el.probMark.el, () => el.probMark.set(rec.model && rec.model.probabilities));
    }
    if (el.activityTitle) changeText(el.activityTitle, rec.review ? 'Simulation activity' : 'Quarantine activity');

    if (v !== el.v) {
      el.v = v;
      shapes.morph(el.chip, v);
      el.body.dataset.v = v;
    }
    const sys = store.conn === 'lost' ? 'Disconnected. This is the last data received.' : store.conn === 'connecting' ? 'Connecting…' : store.daemon === 'down' ? 'Daemon unreachable' : '';
    if (sys) { el.sys.hidden = false; changeText(el.sys, sys); }
    else if (!el.sys.hidden) fadeChange(el.sys, () => { el.sys.textContent = ''; el.sys.hidden = true; });

    if (!el.q) return;
    const live = !rec.review && (st === 'queued' || st === 'investigating');
    const total = rec.q && rec.q.start ? rec.q.start.duration_ms : 0, rem = store.remaining(rec);
    const done = st === 'report' || !!rec.decision;
    const frac = rec.review ? (rec.review.finished ? 1 : 0) : live ? (total ? Math.max(0, Math.min(1, rem / total)) : 1) : done ? 1 : 0;
    el['lv-ring-fg'].setAttribute('stroke-dashoffset', (CIRC * (1 - frac)).toFixed(2));
    const rt = rec.review ? (rec.review.finished ? 'Done' : '…') : st === 'queued' ? '…' : st === 'investigating' ? mmss(rem) : st === 'noreport' ? '–' : 'Done';
    changeText(el.ringValue, rt);
    el.ringT.classList.toggle('is-word', !!rec.review || st !== 'investigating');
    changeText(el.ringCaption, !rec.review && st === 'investigating' ? 'left' : '');
    el.rb.setAttribute('aria-label', rec.decision ? (rec.q && rec.q.end ? 'Quarantine finished' : 'Decision recorded')
      : rec.review && !rec.review.finished && st === 'noreport' ? 'Simulation unavailable'
      : rec.review && !rec.review.finished ? (rec.review.summary ? 'Simulation running' : 'Simulation starting')
      : rec.review ? 'Simulation ready for review'
      : st === 'investigating' ? `Time remaining: ${mmss(rem)}`
      : st === 'queued' ? 'Quarantine starting'
      : st === 'noreport' ? 'No report from the quarantine' : 'Report ready');
    el.rb.classList.toggle('is-urgent', live && rem > 0 && rem <= 10000);
    el.rb.classList.toggle('is-done', done);
    const qText = rec.decision ? (rec.q && rec.q.end ? 'Quarantine finished' : 'Decision recorded')
      : rec.review ? (rec.review.finished ? 'Simulation ready for review' : st === 'noreport' ? 'Simulation unavailable' : rec.review.summary ? 'Simulating command' : 'Starting simulation…')
      : st === 'queued' ? 'Starting the quarantine…'
      : st === 'investigating' ? (rem > 0 ? 'Running in quarantine' : 'Finishing…')
      : st === 'report' ? 'Report ready' : st === 'noreport' ? 'No report from the quarantine' : '';
    changeText(el.qtxt, qText);

    if (rec.q && rec.q.rev !== el.rev) { el.rev = rec.q.rev; paintOut(); paintFiles(); }
    else if (!rec.q && el.rev !== -2) { el.rev = -2; paintOut(); paintFiles(); }
    if (full && full.rev !== (rec.q ? rec.q.rev : -1)) paintFull();
    const end = rec.q && rec.q.end;
    const summary = end && end.summary || '';
    if (summary) {
      el.sum.hidden = false;
      changeText(el.sum, summary);
    } else if (!el.sum.hidden) fadeChange(el.sum, () => { el.sum.textContent = ''; el.sum.hidden = true; });

    if (st !== el.st) {
      if (st === 'report' && el.st !== 'report') {
        el.arming = true;
        setTimeout(() => { el.arming = false; schedule(); }, ARM_MS);
      }
      el.st = st;
    }
    paintAct(st);

    if (live && !timer) timer = setInterval(schedule, 250);
    else if (!live && timer) { clearInterval(timer); timer = 0; }
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(paint); }

  function show(next) {
    pendingId = next || null;
    if (switching) return;
    if (pendingId === id && host.firstElementChild) {
      rec = id ? store.recs.get(id) || rec : null;
      if (rec) schedule();
      return;
    }
    const current = host.firstElementChild;
    if (!current) {
      id = pendingId;
      rec = id ? store.recs.get(id) || null : null;
      build();
      return;
    }
    switching = true;
    current.classList.add('is-leaving');
    const finish = () => {
      if (!switching) return;
      switching = false;
      switchTimer = 0;
      id = pendingId;
      rec = id ? store.recs.get(id) || null : null;
      build();
    };
    current.addEventListener('animationend', (event) => { if (event.target === current) finish(); }, { once: true });
    switchTimer = setTimeout(finish, 240);
  }

  const subs = [
    store.on('rec', (rid) => { if (rid === id || !rec) { if (!rec && id) { rec = store.recs.get(id) || null; if (rec) { build(); return; } } schedule(); } }),
    store.on('q', (qid) => { if (qid === id) schedule(); }),
    store.on('conn', schedule),
  ];
  show(null);

  return {
    show,
    destroy: () => { subs.forEach((u) => u && u()); clearTimeout(switchTimer); switching = false; teardown(); },
  };
}
