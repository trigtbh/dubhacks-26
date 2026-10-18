// The model's answer as three discs, one per outcome (allow, hold, block). The AREA of each disc is that
// outcome's probability, and a thin guide circle shows 100%. A certain verdict fills its guide and the other
// two shrink to specks, so 100% hold can never read as a split between allow and block.
// The display is shape-only; its accessible name carries the values for assistive technology.
const NS = 'http://www.w3.org/2000/svg';
const KEYS = ['block', 'hold', 'allow'];   // top to bottom, like a traffic light
const NAME = { allow: 'Allow', hold: 'Hold', block: 'Block' };
const R = 15;  // radius of the 100% guide in a 32 x 32 box

const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : Math.round(x * 100) + '%');
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
  const parts = {};
  for (const k of KEYS) {
    const item = document.createElement('span');
    item.className = 'pm-i pm-' + k;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    const disc = circle('pm-d', 0);
    disc.style.setProperty('r', '0px');
    svg.append(circle('pm-g', R), disc);
    item.append(svg);
    el.append(item);
    parts[k] = { item, disc };
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
      // The CSS r property animates, so the disc grows to its size (and from one size to the next).
      const grow = () => parts[k].disc.style.setProperty('r', rr.toFixed(2) + 'px');
      if (painted) grow(); else requestAnimationFrame(() => requestAnimationFrame(grow));
      says.push(`${NAME[k]} ${ok ? pct(v) : 'unknown'}`);
    }
    for (const k of KEYS) parts[k].item.classList.toggle('is-top', k === top);
    el.setAttribute('aria-label', ok ? 'Model probabilities: ' + says.join(', ') : 'No model probabilities reported');
    painted = true;
  }
  set(p);
  return { el, set };
}
