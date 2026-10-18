import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';

if (process.env.SHELL_LAB_CONTAINER !== '1' || !existsSync('/.dockerenv')) {
  throw new Error('The shell demos only run inside their Docker container.');
}

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4174);
const maxSessions = 4;
const maxOutput = 2_000_000;
const sessions = new Map();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!localRequest(req, res)) return;

  if (url.pathname === '/dashboard') {
    res.writeHead(308, { ...headers, Location: '/dashboard/' });
    return res.end();
  }

  if (url.pathname.startsWith('/dashboard/')) return proxyDashboard(req, res, url);

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(302, { ...headers, Location: '/assets/favicon.svg' });
    return res.end();
  }

  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad path'); }
  const common = pathname.startsWith('/assets/');
  const base = common ? path.join(root, 'assets') : root;
  const relative = common ? pathname.slice('/assets/'.length) : pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(base, relative);
  if (!file.startsWith(`${base}${path.sep}`) || file.includes(`${path.sep}.`)) return send(res, 404, 'Not found');
  let stat;
  try { stat = statSync(file); } catch { return send(res, 404, 'Not found'); }
  if (!stat.isFile()) return send(res, 404, 'Not found');
  res.writeHead(200, { ...headers, 'Content-Type': mime(path.extname(file)), 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});

const shells = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const id = url.searchParams.get('session');
  if (!localRequest(req, null, true) || url.pathname !== '/shell' || !validId(id)) return socket.destroy();

  let session = sessions.get(id);
  if (!session) {
    if (sessions.size >= maxSessions) {
      socket.end('HTTP/1.1 429 Too Many Sessions\r\nConnection: close\r\n\r\n');
      return;
    }
    const cols = terminalSize(url.searchParams.get('cols'), 20, 200, 80);
    const rows = terminalSize(url.searchParams.get('rows'), 8, 80, 24);
    session = makeSession(id, cols, rows);
  }

  shells.handleUpgrade(req, socket, head, (websocket) => {
    shells.emit('connection', websocket, session);
  });
});

shells.on('connection', (websocket, session) => {
  clearTimeout(session.idleTimer);
  session.sockets.add(websocket);
  for (const event of session.history) websocket.send(JSON.stringify(event));
  websocket.on('message', (data, isBinary) => {
    if (!session.child || session.closed) return;
    if (isBinary) {
      session.child.write(data.toString('utf8'));
      return;
    }
    try {
      const event = JSON.parse(data.toString());
      if (event.type === 'resize' && validTerminalSize(event.cols, 20, 200) && validTerminalSize(event.rows, 8, 80)) {
        session.child.resize(event.cols, event.rows);
      }
    } catch {}
  });
  websocket.on('close', () => {
    session.sockets.delete(websocket);
    if (!session.sockets.size) session.idleTimer = setTimeout(() => stopSession(session), 120_000).unref();
  });
});

server.listen(port, '0.0.0.0', () => console.log(`challenge shell listening on ${port}`));

function makeSession(id, cols, rows) {
  const session = {
    id, sockets: new Set(), history: [], outputBytes: 0, child: null, closed: false, idleTimer: null,
  };
  sessions.set(id, session);
  try {
    const child = session.child = pty.spawn('/usr/bin/ssh', [
      '-tt',
      '-i', '/home/guest/.ssh/tthm_client_key',
      '-p', '2222',
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      'guest@127.0.0.1',
    ], {
      name: 'xterm-256color', cols, rows,
      cwd: '/workspace',
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: String(cols),
        LINES: String(rows),
        HISTFILE: '/dev/null',
      },
    });
    child.onData((text) => {
      if (session.closed) return;
      session.outputBytes += Buffer.byteLength(text);
      if (session.outputBytes > maxOutput) {
        session.closed = true;
        emit(session, { type: 'error', message: 'Terminal output limit reached.' });
        stopSession(session);
      } else {
        emit(session, { type: 'output', text });
      }
    });
    child.onExit(() => {
      session.closed = true;
      session.child = null;
      emit(session, { type: 'closed' });
    });
  } catch (error) {
    session.closed = true;
    emit(session, { type: 'error', message: `Could not start the shell: ${error.message}` });
  }
  return session;
}

function emit(session, item) {
  session.history.push(item);
  if (session.history.length > 240) session.history.splice(0, session.history.length - 240);
  for (const websocket of session.sockets) {
    if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(item));
  }
}

function stopSession(session) {
  clearTimeout(session.idleTimer);
  session.closed = true;
  if (session.child) {
    try { process.kill(-session.child.pid, 'SIGTERM'); }
    catch { try { session.child.kill('SIGTERM'); } catch {} }
    session.child = null;
  }
  sessions.delete(session.id);
}

function proxyDashboard(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return send(res, 405, 'Method not allowed');
  const pathname = url.pathname.slice('/dashboard'.length) || '/';
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: 4175,
    path: `${pathname}${url.search}`,
    method: req.method,
    headers: {
      ...req.headers,
      host: '127.0.0.1:4175',
      origin: 'http://127.0.0.1:4175',
      'sec-fetch-site': 'same-origin',
    },
  }, (response) => {
    const responseHeaders = { ...response.headers };
    if (responseHeaders['content-security-policy']) {
      responseHeaders['content-security-policy'] = responseHeaders['content-security-policy'].replace(
        /frame-ancestors 'none'/i,
        "frame-ancestors 'self'",
      );
    }
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(res);
  });
  upstream.on('error', () => send(res, 502, 'Dashboard unavailable'));
  req.pipe(upstream);
}

function localRequest(req, res, socket = false) {
  const host = req.headers.host || '';
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const origin = req.headers.origin;
  if (!allowed.has(host) || (origin && (() => {
    try { const u = new URL(origin); return u.protocol !== 'http:' || u.host !== host; }
    catch { return true; }
  })())) {
    if (socket) return false;
    send(res, 403, 'Local demo only');
    return false;
  }
  return true;
}

function validId(id) { return typeof id === 'string' && /^[\da-f-]{36}$/i.test(id); }
function validTerminalSize(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function terminalSize(value, min, max, fallback) {
  const size = Number(value);
  return Number.isInteger(size) && size >= min && size <= max ? size : fallback;
}
function send(res, status, text) {
  res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function mime(ext) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[ext] || 'application/octet-stream';
}

const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': `default-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
};

process.on('SIGTERM', () => {
  for (const session of sessions.values()) {
    for (const websocket of session.sockets) websocket.close();
    stopSession(session);
  }
  server.close(() => process.exit(0));
});
