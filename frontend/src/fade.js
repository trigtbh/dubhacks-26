// Run content changes as an exit followed by an entrance. The newest queued
// change wins when a live field updates before its current transition ends.
const active = new WeakMap();

function phase(el, cls, duration, done) {
  el.classList.remove('is-content-fade-in', 'is-content-fade-out');
  void el.offsetWidth;
  el.classList.add(cls);
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    el.removeEventListener('animationend', onEnd);
    done();
  };
  const onEnd = (event) => { if (event.target === el) finish(); };
  el.addEventListener('animationend', onEnd);
  const timer = setTimeout(finish, duration + 80);
}

export function fadeChange(el, mutate) {
  if (!el) return;
  let state = active.get(el);
  if (!state) { state = { running: false, pending: null }; active.set(el, state); }
  if (state.running) { state.pending = mutate; return; }
  if (!el.isConnected) { mutate(); return; }
  state.running = true;
  phase(el, 'is-content-fade-out', 150, () => {
    mutate();
    phase(el, 'is-content-fade-in', 210, () => {
      el.classList.remove('is-content-fade-in');
      state.running = false;
      const next = state.pending;
      state.pending = null;
      if (next) fadeChange(el, next);
    });
  });
}

export function fadeIn(el) {
  if (!el || !el.isConnected) return;
  phase(el, 'is-content-fade-in', 210, () => el.classList.remove('is-content-fade-in'));
}

export function setVisible(el, visible) {
  if (!el || el.hidden === !visible) return;
  if (visible) {
    el.hidden = false;
    fadeIn(el);
  } else fadeChange(el, () => { el.hidden = true; });
}

export function fadeRemove(el, after = () => {}) {
  if (!el || !el.isConnected) { after(); return; }
  if (el.classList.contains('is-leaving')) return;
  el.classList.add('is-leaving');
  phase(el, 'is-leaving', 170, () => {
    if (el.classList.contains('is-leaving')) {
      el.remove();
      after();
    }
  });
}

export function fadeRestore(el) {
  if (!el || !el.classList.contains('is-leaving')) return;
  el.classList.remove('is-leaving');
  for (const animation of el.getAnimations()) animation.cancel();
}
