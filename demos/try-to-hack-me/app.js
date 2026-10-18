(async () => {
await document.fonts.load('14px "Commit Mono"').catch(() => {});

const session = crypto.randomUUID();
const screen = document.querySelector('#terminal');
const shellState = document.querySelector('#shell-state');
const workspace = document.querySelector('#workspace');
const dashboard = document.querySelector('#review-dashboard');
const cursor = document.querySelector('#fake-cursor');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const reviewed = new Set();
let cursorPoint = { x: 0, y: 0 };
let cursorAnimation;
let reviewQueue = Promise.resolve();
const terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: '"Commit Mono", monospace',
  fontSize: 14,
  lineHeight: 1.45,
  scrollback: 5000,
  theme: {
    background: '#0e0f10',
    foreground: '#e6e3dc',
    cursor: '#3fbfae',
    cursorAccent: '#0e0f10',
    selectionBackground: '#3fbfae66',
  },
});
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open(screen);
fit.fit();

const socketUrl = new URL('/shell', location.href);
socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
socketUrl.searchParams.set('session', session);
socketUrl.searchParams.set('cols', String(terminal.cols));
socketUrl.searchParams.set('rows', String(terminal.rows));
const shell = new WebSocket(socketUrl);

terminal.onData((data) => {
  if (shell.readyState === WebSocket.OPEN) shell.send(new TextEncoder().encode(data));
});
terminal.onResize(({ cols, rows }) => {
  if (shell.readyState === WebSocket.OPEN) shell.send(JSON.stringify({ type: 'resize', cols, rows }));
});
window.addEventListener('resize', () => requestAnimationFrame(() => fit.fit()));

shell.addEventListener('open', () => {
  shellState.textContent = 'shell open';
  shellState.dataset.state = 'online';
  shell.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  terminal.focus();
});
shell.addEventListener('message', ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === 'output') terminal.write(event.text);
  if (event.type === 'closed') {
    shellState.textContent = 'shell closed';
    shellState.dataset.state = 'closed';
    terminal.options.disableStdin = true;
  }
  if (event.type === 'error') {
    shellState.textContent = event.message;
    terminal.options.disableStdin = true;
  }
});
shell.addEventListener('error', () => {
  shellState.textContent = 'shell connection failed';
  shellState.dataset.state = '';
});
shell.addEventListener('close', () => {
  if (shellState.dataset.state !== 'closed') shellState.textContent = 'shell connection closed';
  shellState.dataset.state = '';
  terminal.options.disableStdin = true;
});

dashboard.addEventListener('load', watchDashboard);

function watchDashboard() {
  let doc;
  try { doc = dashboard.contentDocument; } catch { return; }
  if (!doc) return;
  const scan = () => {
    for (const row of doc.querySelectorAll('.tl[data-v="hold"]')) {
      const id = row.dataset.id;
      if (!id || reviewed.has(id)) continue;
      reviewed.add(id);
      reviewQueue = reviewQueue.then(() => reviewHold(id)).catch(() => {});
    }
  };
  new MutationObserver(scan).observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-v'],
  });
  scan();
}

async function reviewHold(id) {
  const doc = dashboard.contentDocument;
  const feed = doc?.querySelector('#feed');
  const row = [...(feed?.querySelectorAll('.tl[data-v="hold"]') || [])].find((item) => item.dataset.id === id);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  cursor.classList.add('is-active');
  await moveTo(row);
  cursor.classList.add('is-clicking');
  row.click();
  await pause(2100);
  cursor.classList.remove('is-clicking');

  while (dashboard.isConnected) {
    const block = dashboard.contentDocument?.querySelector('.lv-block');
    if (block && block.getAttribute('aria-disabled') !== 'true' && block.getClientRects().length) {
      await moveTo(block);
      cursor.classList.add('is-clicking');
      block.click();
      await pause(180);
      cursor.classList.remove('is-clicking');
      return;
    }
    await pause(250);
  }
}

async function moveTo(target) {
  const area = workspace.getBoundingClientRect();
  const frame = dashboard.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const next = {
    x: frame.left + rect.left + rect.width / 2 - area.left,
    y: frame.top + rect.top + rect.height / 2 - area.top,
  };
  cursorAnimation?.cancel();
  const from = cursorPoint;
  const animation = cursor.animate([
    { transform: `translate3d(${from.x}px, ${from.y}px, 0)` },
    { transform: `translate3d(${next.x}px, ${next.y}px, 0)` },
  ], { duration: reducedMotion.matches ? 0 : 520, easing: 'cubic-bezier(.2,.75,.2,1)', fill: 'forwards' });
  cursorAnimation = animation;
  try { await animation.finished; } catch { return; }
  cursorPoint = next;
}

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
})();
