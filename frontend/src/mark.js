// Three probability values, paired with discs whose area tracks each value.
const NS = 'http://www.w3.org/2000/svg';
const KEYS = ['block', 'hold', 'allow'];   // top to bottom, like a traffic light
const NAME = { allow: 'Allow', hold: 'Hold', block: 'Block' };
const R = 15;  // radius of the 100% guide in a 32 x 32 box

const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : Math.round(x * 100) + '%');
const node = (tag, cls, text) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const circle = (cls, r) => {
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('class', cls);
  c.setAttribute('cx', 16);
  c.setAttribute('cy', 16);
  c.setAttribute('r', r);
  return c;
};

export function probMark(p) {
  const el = document.createElement('span');
  el.className = 'pm';
  el.setAttribute('role', 'img');
  const title = node('span', 'pm-title', 'Model probabilities');
  const empty = node('span', 'pm-empty', 'Not reported');
  const rows = node('span', 'pm-rows');
  el.append(title, empty, rows);
  const parts = {};
  for (const k of KEYS) {
    const item = node('span', 'pm-i pm-' + k);
    item.className = 'pm-i pm-' + k;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    const disc = circle('pm-d', 0);
    disc.style.setProperty('r', '0px');
    svg.append(circle('pm-g', R), disc);
    const value = node('span', 'pm-value');
    const name = node('span', 'pm-name', NAME[k]);
    item.append(svg, value, name);
    rows.append(item);
    parts[k] = { item, disc, value };
  }

  let painted = false;
  function set(q) {
    const ok = q && KEYS.every((k) => typeof q[k] === 'number' && isFinite(q[k]));
    let top = null;
    const says = [];
    for (const k of KEYS) {
      const v = ok ? Math.min(1, Math.max(0, q[k])) : 0;
      if (ok && (!top || v > q[top])) top = k;
      const rr = v > 0 ? Math.max(1.6, R * Math.sqrt(v)) : 0;
      parts[k].disc.setAttribute('r', rr.toFixed(2));
      parts[k].value.textContent = ok ? pct(v) : '—';
      // The CSS r property animates, so the disc grows to its size (and from one size to the next).
      const grow = () => parts[k].disc.style.setProperty('r', rr.toFixed(2) + 'px');
      if (painted) grow(); else requestAnimationFrame(() => requestAnimationFrame(grow));
      says.push(`${NAME[k]} ${ok ? pct(v) : 'unknown'}`);
    }
    for (const k of KEYS) parts[k].item.classList.toggle('is-top', k === top);
    empty.hidden = !!ok;
    rows.hidden = !ok;
    el.setAttribute('aria-label', ok ? 'Model probabilities: ' + says.join(', ') : 'Model probabilities: not reported');
    painted = true;
  }
  set(p);
  return { el, set };
}
