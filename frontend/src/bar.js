// The top bar: the wordmark and the search box (and a back button on phones).
import { setUI } from './ui.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function mountBar(host, { back }) {
  const wrap = h('div', 'bx');

  const bk = h('button', 'bx-back', 'Back');
  bk.type = 'button';
  bk.addEventListener('click', () => back && back());

  const word = h('h1', 'wordmark bx-word', 'sid');

  const box = h('label', 'bx-search cr-cut');
  const input = h('input');
  input.type = 'search';
  input.placeholder = 'Search commands, users, paths';
  input.setAttribute('aria-label', 'Search blocked and held commands');
  input.autocomplete = 'off';
  input.spellcheck = false;
  box.append(input);
  let raf = 0;
  input.addEventListener('input', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; setUI({ q: input.value }); });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; setUI({ q: '' }); }
  });

  wrap.append(bk, word, box);
  host.replaceChildren(wrap);
  return { destroy: () => host.replaceChildren() };
}
