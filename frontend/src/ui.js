// View state shared by the bar, the feed and the stage: what is selected, the search text, the
// status filters and the theme. Anything that needs to react subscribes with onUI.
export const ui = {
  sel: null,                                      // id of the selected record, or null
  q: '',                                          // search text
  flags: { block: true, hold: true, allow: true }, // status filters (allow = held commands a person allowed)
  theme: 'night',
};

const subs = new Set();

export function setUI(patch) {
  let changed = false;
  for (const k in patch) {
    if (k === 'flags') {
      const f = { ...ui.flags, ...patch.flags };
      if (f.block !== ui.flags.block || f.hold !== ui.flags.hold || f.allow !== ui.flags.allow) { ui.flags = f; changed = true; }
    } else if (ui[k] !== patch[k]) { ui[k] = patch[k]; changed = true; }
  }
  if (changed) for (const fn of subs) fn(ui);
}

export function onUI(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
