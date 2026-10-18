// Shapes for the sid dashboard: glyphs, facet silhouettes, probability and privilege marks, path and history
// marks, file-op glyphs, the countdown ring and ornaments. Everything is built with createElement(NS); event text
// only ever reaches textContent or a plain-string attribute. Colour and motion live in shapes.css.
const { PI, cos, sin, min, max, floor, ceil, round, log } = Math;
const NS = 'http://www.w3.org/2000/svg', PI2 = PI * 2, HALF = PI / 2;
const R = n => round(n * 10) / 10;
const A = (e, a) => { for (const k in a) if (a[k] != null) e.setAttribute(k, a[k]); return e; };
const S = (t, a, p) => { const e = A(document.createElementNS(NS, t), a); if (p) p.appendChild(e); return e; };
const H = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const svg = (w, h, c, vb) => S('svg', { viewBox: vb || `0 0 ${w} ${h}`, width: w, height: h, class: c, 'aria-hidden': 'true', focusable: 'false' });
const P = (d, c, p) => S('path', { d, class: c }, p);
const pd = pts => 'M' + pts.map(p => R(p[0]) + ' ' + R(p[1])).join('L') + 'Z';
const ngon = (cx, cy, n, r, rot = 0) => Array.from({ length: n }, (_, i) => {
  const a = i / n * PI2 - HALF + rot;
  return [cx + r * cos(a), cy + r * sin(a)];
});
// Point on a regular n-gon perimeter, t in [0, n): vertex k is t = k. Same maths as Crystal's brokenRing.at().
const at = (c, n, r, t) => {
  const k = floor(t), u = t - k, a = k / n * PI2 - HALF, b = (k + 1) / n * PI2 - HALF;
  return [c + r * ((1 - u) * cos(a) + u * cos(b)), c + r * ((1 - u) * sin(a) + u * sin(b))];
};
// A mark with a tooltip: an HTML wrapper, because ::after cannot render on an <svg> root.
const W = (child, tip, cls) => {
  const t = String(tip).slice(0, 160);
  const e = A(H('span', 'sh-tip' + (cls ? ' ' + cls : '')), { role: 'img', 'aria-label': t, 'data-tip': t });
  e.appendChild(child);
  return e;
};

// Status glyphs: Crystal's path data (bundle.js GLYPH), 10x10 grid.
const ST = {
  __proto__: null,
  allow: 'M.53 6.07l2.7 2.7L4.57 7.43 1.87 4.73M4.62 8.71l5-5.9L8.18 1.59l-5 5.9',
  hold: 'M1.6 1V9H4V1M6 1V9H8.4V1',
  block: 'M.89 2.31l6.8 6.8L9.11 7.69 2.31 .89m5.38 0L.89 7.69 2.31 9.11 9.11 2.31',
};
const LABEL = { __proto__: null, allow: 'Allow', hold: 'Hold', block: 'Block' };
// Other glyphs, 16x16 grid. One path per '|'; a leading ~ strokes, ! strokes dashed, * fills even-odd, else fills.
const G = {
  __proto__: null,
  agent: '~M8 1l6 3.5v7L8 15 2 11.5v-7z|M6.2 5.6 10.8 8 6.2 10.4',
  ssh: 'M2 4 6 8 2 12H4.2l4-4-4-4|M8 4l4 4-4 4h2.2l4-4-4-4',
  service: '~M5.2 1.5h5.6l3.7 3.7v5.6l-3.7 3.7H5.2L1.5 10.8V5.2z|M8 5.6 10.4 8 8 10.4 5.6 8',
  local: '~M2 2H14v9l-3 3H2z|M4.5 9H9v1.6H4.5',
  'user-human': 'M3.5 8a4.5 4.5 0 1 0 9 0 4.5 4.5 0 1 0-9 0',
  'user-service': 'M3.5 3.5h9v9h-9',
  'user-root': 'M6.2 3.3 8 5.1 9.8 3.3 14.5 8 8 14.5 1.5 8',
  lens: '~M5.5 2.5h3l2 2v3l-2 2h-3l-2-2v-3z|~M9.8 9.8l4 4',
  theme: '~M2.5 8a5.5 5.5 0 1 0 11 0 5.5 5.5 0 1 0-11 0z|M8 2.5A5.5 5.5 0 0 0 8 13.5',
  back: '~M13.5 8H3M6.5 4.5 3 8 6.5 11.5',
  up: '~M4 10 8 6l4 4',
  down: '~M4 6l4 4 4-4',
  retry: '~M12.5 9.6A4.8 4.8 0 1 1 12.2 5.6|M13.7 8.4l.2-4-3.4 2.2',
  lock: 'M3.5 7h9v7h-9|~M5.5 7V4.8L7 2.8H9l1.5 2V7',
  unknown: '!M8 1.5 14.5 8 8 14.5 1.5 8z|M7.2 7.2H8.8V8.8H7.2',
  spinner: '~M8 1.5l5.6 3.25v6.5L8 14.5',
  suspect: '~M8 2l6.5 11.5H1.5z|M7.3 6H8.7V9.6H7.3|M7.3 10.8H8.7v1.4H7.3',
  arrow: '~M2.5 8H13M9.5 4.5 13 8 9.5 11.5',
  plus: 'M7.2 2.5H8.8V7.2h4.7V8.8H8.8v4.7H7.2V8.8H2.5V7.2H7.2',
  chevron: '~M6 3.5 10.5 8 6 12.5',
  chevrons: '~M1 3.5 5 8 1 12.5|~M6 3.5 10 8 6 12.5|~M11 3.5 15 8 11 12.5',
};
const OP = {
  __proto__: null,
  create: '*M2 2H14V14H2M7.2 4.5H8.8V7.2h2.7V8.8H8.8v2.7H7.2V8.8H4.5V7.2H7.2',
  modify: '~M2.8 2.8H13.2V13.2H2.8z|M2.8 2.8H13.2L2.8 13.2',
  delete: '~M2.8 2.8H13.2V13.2H2.8z|~M2.5 13.5l11-11',
  move: '~M1.8 5.8H5.3v4.4H1.8z|~M5.8 8H9.4|M8.6 6.2 10.4 8 8.6 9.8|M10.5 5.5H15v5H10.5',
  chmod: 'M2 2.8H14V5H2|M2 6.9h8V9.1H2|M2 11H12v2.2H2',
  read: '~M2.7 8a5.3 5.3 0 1 0 10.6 0 5.3 5.3 0 1 0-10.6 0z',
};
const M = { __proto__: null, '~': 'sh-s', '!': 'sh-s sh-d', '*': 'sh-f sh-eo' };
const draw = (spec, cls, size) => {
  const s = svg(size, size, cls, '0 0 16 16');
  for (const d of spec.split('|')) { const c = M[d[0]]; P(c ? d.slice(1) : d, c || 'sh-f', s); }
  return s;
};

export function glyph(name, size = 16) {
  const st = ST[name];
  if (st) { const s = svg(size, size, `sh-glyph sh-gs sh-gs--${name}`, '0 0 10 10'); P(st, 'sh-f', s); return s; }
  return draw(G[name] || G.unknown, 'sh-glyph' + (name === 'spinner' ? ' sh-spin' : ''), size);
}

// Verdict chip: the same markup and classes as Crystal.chip, so Crystal's .cr-verdict rules and status.css apply.
export function chip(v) {
  const e = H('span', `cr-verdict cr-cut cr-verdict--${v}`);
  P(ST[v] || '', null, S('svg', { class: 'cr-glyph', viewBox: '0 0 10 10', 'aria-hidden': 'true' }, e));
  e.appendChild(H('span', 'cr-label', LABEL[v] || v));
  return e;
}
// Swap a chip's (or a status glyph's) verdict: class, label and path. The CSS d: rule morphs the path.
export function morph(el, v) {
  el.setAttribute('class', (el.getAttribute('class') || '').replace(/\b(cr-verdict|sh-gs)--\w+/, `$1--${v}`));
  const l = el.querySelector('.cr-label'), p = el.querySelector('path');
  if (l) l.textContent = LABEL[v] || v;
  if (p && ST[v]) p.setAttribute('d', ST[v]);
}

// Silhouettes, clockwise in css px. block = parallelogram (lean `tip`, default 12) unless `cut` is passed, then
// chamfers at top-left and bottom-right; hold = all four corners cut; allow = top-right cut. cut defaults to 14.
export function facet(w, h, o = {}) {
  const c = min(o.cut == null ? 14 : o.cut, w / 2, h / 2);
  if (o.status === 'block') {
    if (o.cut == null) { const t = min(o.tip == null ? 12 : o.tip, w / 2); return [[t, 0], [w, 0], [w - t, h], [0, h]]; }
    return [[c, 0], [w, 0], [w, h - c], [w - c, h], [0, h], [0, c]];
  }
  if (o.status === 'hold') return [[c, 0], [w - c, 0], [w, c], [w, h - c], [w - c, h], [c, h], [0, h - c], [0, c]];
  return [[0, 0], [w - c, 0], [w, c], [w, h], [0, h]];
}
export const clipPath = pts => 'polygon(' + pts.map(p => R(p[0]) + 'px ' + R(p[1]) + 'px').join(',') + ')';

// Ternary mark: hold on top, allow bottom-left, block bottom-right. 48x44 box; the dot is placed by barycentric coords.
const TA = [4, 40], TH = [24, 5.4], TB = [44, 40];
const pc = v => v > 0 && v < .005 ? '<1%' : round(v * 100) + '%';
export function ternary(p, size = 44) {
  const s = svg(size, round(size * 44 / 48), 'sh-tern', '0 0 48 44');
  P('M24 5.4 44 40H4z', 'sh-l', s);
  P('M14 22.7 24 40 34 22.7z', 'sh-l sh-in', s);
  P('M4 40l4.8-8.3 4.8 8.3z', 'sh-va', s);
  P('M24 5.4l4.8 8.3h-9.6z', 'sh-vh', s);
  P('M44 40h-9.6l4.8-8.3z', 'sh-vb', s);
  const dot = P('M0-3.2L3.2 0L0 3.2L-3.2 0Z', 'sh-dot sh-hide', s);
  dot.style.setProperty('--x', 24); dot.style.setProperty('--y', 28.5);
  const el = W(s, 'No model probabilities', 'sh-tern-w');
  const set = q => {
    let a = q && +q.allow, h = q && +q.hold, b = q && +q.block;
    const t = a + h + b;
    if (!q || !(a >= 0 && h >= 0 && b >= 0 && t > 0 && isFinite(t))) {
      dot.setAttribute('class', 'sh-dot sh-hide');
      A(el, { 'aria-label': 'No model probabilities', 'data-tip': 'No model probabilities' });
      return;
    }
    a /= t; h /= t; b /= t;
    dot.style.setProperty('--x', R(a * TA[0] + h * TH[0] + b * TB[0]));
    dot.style.setProperty('--y', R(a * TA[1] + h * TH[1] + b * TB[1]));
    dot.setAttribute('class', 'sh-dot');
    const tip = `allow ${pc(a)}, hold ${pc(h)}, block ${pc(b)}`;
    A(el, { 'aria-label': tip, 'data-tip': tip });
  };
  set(p);
  return { el, set };
}

// Privilege marks. Ink and muted tones only: red, amber and green mean a verdict and nothing else.
const SUDO = { __proto__: null, none: [0, 'none'], some: [1, 'some'], 'all-pw': [2, 'all (password)'], 'all-nopw': [3, 'all (nopasswd)'] };
const PRIV = new Set(['sudo', 'wheel', 'docker', 'adm', 'root', 'shadow', 'disk']);
export function privilege(ctx) {
  ctx = ctx || {};
  const u = ctx.user || {}, cp = ctx.caps || { unknown: true }, gs = Array.isArray(ctx.groups) ? ctx.groups : [];
  // sudo: three chevron pips
  const sv = SUDO[ctx.sudo], ss = svg(27, 12, 'sh-sudo');
  for (let i = 0; i < 3; i++) P(`M${i * 9.5} 0h4l4 6-4 6h-4l4-6Z`, sv ? (i < sv[0] ? 'sh-f' : 'sh-s sh-faint') : 'sh-s sh-d', ss);
  const sudo = W(ss, 'sudo rights: ' + (sv ? sv[1] : 'unknown'));
  // caps: eight wedges
  const cs = svg(18, 18, 'sh-caps'), list = Array.isArray(cp.list) ? cp.list : [];
  const unk = !cp.all && cp.unknown, lit = cp.all ? 8 : min(8, list.length);
  for (let i = 0; i < 8; i++) {
    const a0 = i * PI2 / 8 - HALF + .06, a1 = (i + 1) * PI2 / 8 - HALF - .06, q = (r, a) => [9 + r * cos(a), 9 + r * sin(a)];
    P(pd([q(7.4, a0), q(7.4, a1), q(3.6, a1), q(3.6, a0)]), unk ? 'sh-s sh-d' : i < lit ? 'sh-f' : 'sh-s sh-faint', cs);
  }
  if (cp.all) P(pd(ngon(9, 9, 8, 8.6)), 'sh-s', cs);
  const caps = W(cs, 'capabilities: ' + (cp.all ? 'all' : unk ? 'unknown' : list.length ? list.join(', ') : 'none'));
  // user type mark
  const ty = u.type, type = ty === 'human' || ty === 'service' || ty === 'root' ? ty : null;
  const user = W(glyph(type ? 'user-' + type : 'unknown'), `user ${u.name == null ? '?' : u.name} (uid ${u.uid == null ? '?' : u.uid}${type ? ', ' + type + ' account' : ''})`);
  // groups: a strand of hexagons, privileged ones filled
  const shown = gs.slice(0, 6), more = gs.length - 6, cells = shown.map(g => PRIV.has(g)), m = cells.length + (more > 0 ? 1 : 0) || 1;
  const gsv = svg(R(4.8 * (m - 1) + 10), 17, 'sh-hex');
  for (let i = 0; i < m; i++) {
    const cx = 4.8 + 4.8 * i, cy = 5.4 + (i % 2) * 7, x = i < cells.length;
    P(pd(ngon(cx, cy, 6, 4.4)), x ? (cells[i] ? 'sh-f' : 'sh-s') : 'sh-s sh-d', gsv);
    if (i === cells.length && more > 0) P(`M${R(cx - 1.6)} ${R(cy - .4)}h3.2v.8h-3.2ZM${R(cx - .4)} ${R(cy - 1.6)}h.8v3.2h-.8Z`, 'sh-f', gsv);
  }
  const groups = W(gsv, 'groups: ' + (gs.length ? gs.join(', ') : 'none'));
  return { sudo, caps, user, groups };
}

// Working directory as slanted segments. The last shows its name; earlier ones truncate, the full path in data-tip.
export function pathSegs(cwd, o = {}) {
  const mx = max(2, o.max || 5), parts = String(cwd == null ? '' : cwd).split('/').filter(Boolean);
  const box = A(H('span', 'sh-path'), { role: 'group', 'aria-label': 'Working directory ' + cwd });
  const items = parts.length ? parts.map((n, i) => [n, '/' + parts.slice(0, i + 1).join('/')]) : [['/', '/']];
  const gap = items.length > mx ? items.length - mx : 0;
  items.forEach(([n, full], i) => {
    if (gap && i === 1) box.appendChild(W(glyph('chevrons', 12), '\u2026/' + parts.slice(1, 1 + gap).join('/'), 'sh-gap'));
    if (gap && i >= 1 && i < 1 + gap) return;
    const last = i === items.length - 1, e = A(H('span', 'sh-tip sh-seg' + (last ? ' sh-last' : '')), { 'data-tip': full });
    e.style.setProperty('--n', max(2, min(last ? 22 : 8, n.length)));
    e.appendChild(H('span', null, n));
    box.appendChild(e);
  });
  return box;
}

// History as a tick barcode: oldest left, newest right, height follows log(command length), newest emphasised.
export function histTicks(history, o = {}) {
  const hs = (Array.isArray(history) ? history : []).slice(-(o.max || 16)), n = hs.length, s = svg(max(n, 2) * 4 + 2, 20, 'sh-hist');
  let old = '', last = '';
  hs.forEach((c, i) => {
    const hh = 4 + 14 * min(1, log(1 + String(c).length) / log(161)), y = R((20 - hh) / 2), x = i * 4;
    const d = `M${x + 1.5} ${y}h2L${x + 2} ${R(y + hh)}h-2Z`;
    if (i < n - 1) old += d; else last = d;
  });
  if (!n) P('M0 9.2H8V10.8H0Z', 'sh-f sh-faint', s);
  if (old) P(old, 'sh-f', s);
  if (last) P(last, 'sh-f sh-hi', s);
  return W(s, n ? `${n} earlier command${n > 1 ? 's' : ''}, newest at right` : 'no earlier commands');
}

// File-op glyphs. Motion is in shapes.css and starts when .is-new is on the glyph or an ancestor.
export function fileOp(op) {
  const known = OP[op], s = draw(known || G.unknown, `sh-op sh-op--${known ? op : 'unknown'}`, 16), t = known ? op : 'unknown operation';
  s.removeAttribute('aria-hidden');
  return A(s, { role: 'img', 'aria-label': t, 'data-tip': t });
}

// Countdown ring: a dodecagon of 48 wedges. set(frac) 1 -> 0, only wedges that cross a threshold are touched.
export function ring(o = {}) {
  const sides = o.sides || 12, segs = o.segs || 48, R0 = 33, R1 = 46, s = svg(100, 100, 'sh-ring');
  const w = [];
  for (let i = 0; i < segs; i++) {
    const t0 = i * sides / segs, t1 = (i + 1) * sides / segs;
    const e = P(pd([at(50, sides, R0, t0), at(50, sides, R0, t1), at(50, sides, R1, t1), at(50, sides, R1, t0)]), 'sh-w', s);
    e.style.setProperty('--i', i);
    w.push(e);
  }
  P(pd(ngon(50, 50, sides, R1 + 2.6)), 'sh-rl', s);
  P(pd(ngon(50, 50, sides, R0 - 2.6)), 'sh-rl sh-faint', s);
  const pe = P(pd(ngon(50, 50, sides, R1 + 2.6)), 'sh-pulse', s);
  let lit = segs, lead = -1, last = 1, md = 'run', pp = 0;
  const show = f => {                                  // wedges [0, ceil(x)) are lit, wedge floor(x) is partial
    const x = max(0, min(1, f)) * segs, m = ceil(x), k = floor(x);
    for (let i = min(m, lit); i < max(m, lit); i++) w[i].classList.toggle('off', i >= m);
    lit = m;
    const l = x > k && k < segs ? k : -1;
    if (lead >= 0 && lead !== l) w[lead].style.removeProperty('--o');
    if (l >= 0) w[l].style.setProperty('--o', R(.14 + .86 * (x - k)));
    lead = l;
  };
  return {
    el: s,
    set(f) { last = f; if (md === 'run') show(f); },
    pulse() { pp ^= 1; pe.setAttribute('class', 'sh-pulse p' + pp); },
    mode(m) {
      md = m;
      for (const c of ['done', 'broken', 'orbit']) s.classList.toggle(c, c === m);
      show(m === 'run' ? last : 0);
    },
  };
}

// Ornaments.
function nested(o) {
  const n = o.n || 8, sides = o.sides || 6, s = svg(o.size || 240, o.size || 240, 'sh-orn', '0 0 240 240');
  for (let i = 0; i < n; i++) {
    const p = P(pd(ngon(120, 120, sides, 112 * .78 ** i, i * .13)), i === n - 1 ? 'sh-fill sh-hi sh-rot' : 'sh-l sh-rot' + (i % 3 ? '' : ' sh-hi') + (i % 2 ? ' sh-rev' : ''), s);
    p.style.setProperty('--d', 90 + i * 23);
  }
  return s;
}
function brokenRing(o) {
  const sides = o.sides || 6, rings = o.rings || 4, segs = o.segs || 8, dens = o.density == null ? .7 : o.density, sd = o.seed || 3;
  const s = svg(o.size || 240, o.size || 240, 'sh-orn', '0 0 240 240'), q = (r, t) => at(120, sides, r, t);
  let lo = '', hi = '';
  for (let r = 0; r < rings; r++) for (let i = 0; i < sides * segs; i++) {
    const v = (sin(i * .55 + r * 1.7 + sd) + sin(i * .23 - r * .9 + sd * 2) + 2) / 4;
    if (v > dens) continue;
    const r0 = 48 + 64 * r / rings, r1 = 48 + 64 * (r + 1) / rings, d = pd([q(r0, i / segs), q(r0, (i + 1) / segs), q(r1, (i + 1) / segs), q(r1, i / segs)]);
    if (v > dens - .04) hi += d; else lo += d;
  }
  P(lo, 'sh-fill', s); P(hi, 'sh-fill sh-hi', s);
  return s;
}
// The divider between the Allow and Block buttons: rows of chevron zigzags, apexes up.
function seam(o) {
  const w = o.w || 44, h = o.h || 128, n = o.rows || max(2, round(h / 16)), t = o.teeth || 2, amp = min(6, w / t / 3);
  const s = svg(w, h, 'sh-seam');
  let d = '';
  for (let i = 0; i < n; i++) {
    const y = (i + .5) * h / n;
    for (let k = 0; k <= 2 * t; k++) d += (k ? 'L' : 'M') + R(k * w / (2 * t)) + ' ' + R(y + (k % 2 ? -amp : amp));
  }
  P(d, 'sh-s sh-bold', s);
  return s;
}
const ORN = { __proto__: null, nested, brokenRing, seam };
export const ornament = (kind, o) => (ORN[kind] || nested)(o || {});
