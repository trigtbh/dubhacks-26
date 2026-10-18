// Small formatters shared by the feed and the stage. They only build strings; the caller puts them
// on the page with textContent.
const p2 = (n) => String(n).padStart(2, '0');

export const clock = (ms) => {
  const d = new Date(ms);
  return isNaN(d) ? '' : `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

export const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
};

// Keep origin type and detail separate so each value can be shown with its own label.
// Internal details such as an sshd process id are left out.
export const originParts = (o) => {
  const kinds = { agent: 'Agent', ssh: 'SSH', service: 'Service', local: 'Local' };
  const detailLabels = { agent: 'Agent program', ssh: 'Remote address', service: 'Service unit' };
  const known = !!o && Object.prototype.hasOwnProperty.call(kinds, o.kind);
  const kind = known ? kinds[o.kind] : 'Not recorded';
  const detail = o && o.detail ? String(o.detail) : '';
  const shown = !known ? '' : o.kind === 'ssh'
    ? (/^[0-9a-f:.]+$/i.test(detail) && /[.:]/.test(detail) ? detail : '')
    : o.kind === 'agent'
      ? (/^[a-z0-9._+-]+$/i.test(detail) ? detail : '')
      : o.kind === 'service' ? detail : '';
  return { kind, detailLabel: known ? detailLabels[o.kind] || '' : '', detail: shown };
};

// The daemon may put a numeric UID in `user` when it cannot resolve a login name.
// Do not present that ID as though it were an account name.
export const userText = (u) => {
  if (!u || typeof u.name !== 'string') return 'Not recorded';
  const name = u.name.trim();
  if (!name || name === 'unknown' || /^uid \d+$/i.test(name) || (u.uid != null && name === String(u.uid))) return 'Not recorded';
  return name;
};

// The last path pieces only: the whole path is in the stage.
export const cwdText = (cwd, n = 2) => {
  if (!cwd) return '';
  const parts = String(cwd).split('/').filter(Boolean);
  return parts.length <= n ? String(cwd) : '…/' + parts.slice(-n).join('/');
};

export const SUDO = { none: 'None', some: 'Some commands', 'all-pw': 'All commands, password required', 'all-nopw': 'All commands, no password required', unknown: 'Not recorded' };

export const capsText = (c) => (!c || c.unknown ? 'Not recorded' : c.all ? 'All capabilities' : c.list && c.list.length ? c.list.join(', ') : 'None');

export const OPS = { create: 'created', modify: 'modified', delete: 'deleted', move: 'moved', chmod: 'changed permissions' };
export const FILEOP = { read: 'read', write: 'write', delete: 'delete', perms: 'Change permissions' };
