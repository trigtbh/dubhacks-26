import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.SHELL_LAB_CONTAINER !== '1' || !existsSync('/.dockerenv')) {
  throw new Error('The shell demos only run inside their Docker container.');
}

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const maxSessions = 4;
const maxOutput = 2_000_000;
const sessions = new Map();
const ansi = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/events') {
    const id = url.searchParams.get('session');
    if (!validId(id)) return send(res, 400, 'Bad session id');
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= maxSessions) return send(res, 429, 'Too many local demo sessions');
      session = makeSession(id);
    }
    clearTimeout(session.idleTimer);
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    session.clients.add(res);
    for (const item of session.history) writeEvent(res, item);
    res.on('close', () => {
      session.clients.delete(res);
      if (!session.clients.size) session.idleTimer = setTimeout(() => stopSession(session), 120_000).unref();
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/command') {
    const data = await readJson(req, res);
    if (!data) return;
    const session = getSession(data.session, res);
    if (!session) return;
    const line = data.line;
    if (typeof line !== 'string' || line.length > 4096 || /[\r\n\0]/.test(line)) return send(res, 400, 'Enter one line at a time');
    if (!line.trim()) return send(res, 204);
    if (!session.child || session.closed) return send(res, 410, 'The shell has closed. Start a new session.');
    if (session.busy) return send(res, 409, 'The previous command is still running.');

    session.busy = true;
    session.child.stdin.write(`${line}\n`);
    return send(res, 202, 'Command sent');
  }

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

server.listen(port, '0.0.0.0', () => console.log(`exposed shell listening on ${port}`));

function makeSession(id) {
  const session = {
    id, clients: new Set(), history: [], outputBytes: 0, outputTail: '', prompt: '>>> ',
    busy: true, child: null, closed: false, idleTimer: null,
  };
  sessions.set(id, session);
  const shell = 'stty -echo; stty cols 100 rows 32; exec /usr/local/bin/sid-session';
  const child = session.child = spawn('script', ['-q', '-c', shell, '/dev/null'], {
    cwd: '/workspace', detached: true,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      PS1: 'guest@worker:\\w$ ',
      SSH_ORIGINAL_COMMAND: "export PS1='guest@worker:\\w$ '; python3 -q; exec bash --noprofile --norc -i",
      HISTFILE: '/dev/null',
      PYTHONHISTFILE: '/dev/null',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => shellOutput(session, chunk));
  child.stderr.on('data', (chunk) => shellOutput(session, chunk));
  child.on('error', (error) => {
    emit(session, { type: 'error', message: `Could not start the shell: ${error.message}` });
    stopSession(session);
  });
  child.on('close', () => {
    session.closed = true;
    session.busy = false;
    session.child = null;
    emit(session, { type: 'closed' });
  });
  return session;
}

function shellOutput(session, chunk) {
  if (session.closed) return;
  session.outputBytes += chunk.length;
  if (session.outputBytes > maxOutput) {
    emit(session, { type: 'error', message: 'Output limit reached. Start a new shell.' });
    stopSession(session);
    return;
  }
  const text = chunk.toString('utf8');
  emit(session, { type: 'output', text });
  session.outputTail = `${session.outputTail}${text.replace(ansi, '').replace(/\r/g, '')}`.slice(-240);
  const match = session.outputTail.match(/(>>> |\.\.\. |guest@worker:[^\n]*\$ )$/);
  if (match) {
    session.prompt = match[1];
    session.busy = false;
    emit(session, { type: 'ready', prompt: session.prompt });
  }
}

function emit(session, item) {
  session.history.push(item);
  if (session.history.length > 240) session.history.splice(0, session.history.length - 240);
  for (const client of session.clients) writeEvent(client, item);
}

function writeEvent(res, item) {
  if (!res.destroyed) res.write(`data: ${JSON.stringify(item)}\n\n`);
}

function stopSession(session) {
  clearTimeout(session.idleTimer);
  if (session.child) {
    try { process.kill(-session.child.pid, 'SIGTERM'); } catch {}
    session.child = null;
  }
  sessions.delete(session.id);
}

async function readJson(req, res) {
  if (req.headers['content-type'] !== 'application/json') {
    send(res, 415, 'JSON required');
    return null;
  }
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8192) throw new Error('Request too large');
    }
    return JSON.parse(raw);
  } catch (error) {
    send(res, 400, error.message === 'Request too large' ? error.message : 'Invalid JSON');
    return null;
  }
}

function getSession(id, res) {
  if (!validId(id)) {
    send(res, 400, 'Bad session id');
    return null;
  }
  const session = sessions.get(id);
  if (!session) send(res, 404, 'Shell session expired. Reload the page.');
  return session;
}

function validId(id) { return typeof id === 'string' && /^[\da-f-]{36}$/i.test(id); }
function send(res, status, text) {
  res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function mime(ext) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
}

const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

process.on('SIGTERM', () => {
  for (const session of sessions.values()) {
    for (const client of session.clients) client.end();
    stopSession(session);
  }
  server.close(() => process.exit(0));
});
