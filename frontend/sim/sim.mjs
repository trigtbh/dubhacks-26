#!/usr/bin/env node
// sid simulator: a FAKE daemon and FAKE traffic for the dashboard. DEV ONLY, never shipped in dist/.
//
//   node sim/sim.mjs --scenario showcase [--serve]     curated demo, one hold waits for your click
//   node sim/sim.mjs --loop [--serve]                  endless traffic
//   node sim/sim.mjs --scenario list
//
// It appends contract-shaped lines (CONTRACT.md) to the event log, tails the decisions file,
// and answers decisions like the daemon would (settle line, early abort, timeout).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRng, toJson, guardPath, buildEvent, planQuarantine, createDaemon, sleep } from './lib/core.mjs';
import { BLOCKS, HOLDS, ALLOWS, HOSTILE, HOSTILE_Q, persona, instantiate } from './lib/data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const USAGE = `usage: node sim/sim.mjs [--scenario showcase|probabilities|list] [--loop] [--log PATH] [--decisions PATH]
                      [--decide manual|auto:allow|auto:block|auto:alternate] [--hold-timeout SECS]
                      [--layout compact|spaced|mixed] [--seed N] [--clean] [--quiet] [--serve [--bin PATH]]
defaults: --log sim/.run/events.jsonl  --decisions sim/.run/decisions.jsonl  --decide manual (showcase picks per hold)`;

function parse(argv) {
  const o = { layout: 'compact', decide: null, holdTimeout: 300, seed: Date.now() };
  const val = (i, name) => { if (i + 1 >= argv.length) throw new Error(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--scenario': o.scenario = val(i++, a); break;
      case '--loop': o.loop = true; break;
      case '--log': o.log = val(i++, a); break;
      case '--decisions': o.decisions = val(i++, a); break;
      case '--decide': o.decide = val(i++, a); break;
      case '--hold-timeout': o.holdTimeout = Number(val(i++, a)); break;
      case '--layout': o.layout = val(i++, a); break;
      case '--seed': o.seed = Number(val(i++, a)); break;
      case '--bin': o.bin = val(i++, a); break;
      case '--serve': o.serve = true; break;
      case '--clean': o.clean = true; break;
      case '--quiet': o.quiet = true; break;
      case '--really-write-real-log': o.really = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (!['compact', 'spaced', 'mixed'].includes(o.layout)) throw new Error('--layout is compact, spaced or mixed');
  if (o.decide && !/^(manual|auto:allow|auto:block|auto:alternate)$/.test(o.decide)) throw new Error('--decide is manual, auto:allow, auto:block or auto:alternate');
  if (!(o.holdTimeout > 0)) throw new Error('--hold-timeout needs seconds');
  return o;
}

const SCENARIOS = {
  showcase: 'model probability examples, then blocks, holds and a burst of later traffic',
  probabilities: 'fixed block examples with high, mixed, and rule-overridden model probabilities',
};

async function main() {
  let o;
  try { o = parse(process.argv.slice(2)); } catch (e) { console.error(`sim: ${e.message}\n${USAGE}`); process.exit(2); }
  if (o.help || (!o.scenario && !o.loop)) { console.error(USAGE + '\n\nscenarios: ' + Object.keys(SCENARIOS).join(', ')); process.exit(o.help ? 0 : 2); }
  if (o.scenario === 'list') { for (const [k, v] of Object.entries(SCENARIOS)) console.log(`${k.padEnd(10)} ${v}`); return; }
  if (o.scenario && !SCENARIOS[o.scenario]) { console.error(`sim: unknown scenario ${o.scenario} (try --scenario list)`); process.exit(2); }

  console.error('SIMULATOR: FAKE DATA, dev only');
  const logPath = guardPath(o.log || path.join(HERE, '.run/events.jsonl'), o.really);
  const decPath = guardPath(o.decisions || path.join(HERE, '.run/decisions.jsonl'), o.really);
  for (const p of [logPath, decPath]) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (o.clean || !fs.existsSync(p)) fs.writeFileSync(p, '');
  }

  const r = createRng(o.seed);
  const say = (kind, text) => {
    if (o.quiet) return;
    const t = new Date().toISOString().slice(11, 23);
    const safe = String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, 110); // never echo hostile bytes to a terminal
    console.error(`${t}  ${kind.padEnd(6)} ${safe}`);
  };

  // The one place that writes the log: one append per line, tagged sim:true.
  let lines = 0;
  const write = (obj) => {
    if (!obj.sim) obj.sim = true;
    const spaced = o.layout === 'spaced' || (o.layout === 'mixed' && r.chance(0.5));
    fs.appendFileSync(logPath, toJson(obj, spaced) + '\n');
    lines++;
    if (obj.q === 'start') say('q', `${obj.id} quarantine starts, ${obj.duration_ms / 1000} s`);
    else if (obj.q === 'end') say('q', `${obj.id} ended (${obj.how}): ${obj.summary}`);
  };

  const daemon = createDaemon({ r, write, decisionsPath: decPath, graceMs: o.holdTimeout * 1000, say });
  daemon.start();

  let flip = 0;
  // --decide beats the scenario's own choice for each hold.
  const decision = (own) => {
    if (!o.decide) return own;
    if (o.decide === 'manual') return {};
    if (o.decide === 'auto:alternate') return { auto: flip++ % 2 ? 'block' : 'allow' };
    return { auto: o.decide.slice(5) };
  };

  const describe = (ev) => `${ev.argv.join(' ')}  (${ev.user}, ${ev.origin.type}${ev.origin.detail ? ' ' + ev.origin.detail : ''}, sudo ${/sudo rights: ([^\n]*)/.exec(ev.context || '')?.[1] ?? '?'})`;
  const mk = (verdict, entry, want, extra = {}) => {
    const p = persona(r, want);
    const cmd = instantiate(r, entry, p);
    if (extra.q) cmd.q = extra.q;
    return { ev: buildEvent({ r, now: Date.now(), p, cmd, verdict, choice: extra.choice || verdict,
      decided_by: extra.decided_by, probabilities: extra.probabilities }), cmd };
  };
  const block = (want, entry) => {
    const { ev } = mk('block', entry || r.pick(BLOCKS), want);
    write(ev);
    say('BLOCK', describe(ev));
  };
  const allow = (entry) => write(mk('allow', entry || r.pick(ALLOWS), {}).ev);
  const hold = (entry, want, own = {}, q) => {
    const { ev, cmd } = mk('hold', entry || r.pick(HOLDS), want, { q });
    const plan = planQuarantine(r, cmd.q, 12000);
    say('HOLD', describe(ev));
    return daemon.hold(ev, plan, decision(own));
  };
  const by = (key) => BLOCKS.find((b) => b.key === key);
  const holdBy = (key) => HOLDS.find((h) => h.key === key);

  // ---- scenarios ------------------------------------------------------------------------
  async function showcase() {
    await probabilities();
    allow(); allow();
    await sleep(2000);
    block({ origin: 'agent', utype: 'human', sudo: 'all (password)' }, by('curl-pipe-sh'));
    await sleep(7000);
    block({ origin: 'ssh', utype: 'root', sudo: 'all (nopasswd)', caps: 'all' }, by('rm-rf-root'));
    await sleep(7000);
    block({ origin: 'service', utype: 'service', sudo: 'none', caps: 'one' }, by('bash-dev-tcp'));
    await sleep(7000);
    block({ origin: 'agent', utype: 'human', sudo: 'some', caps: 'none' }, by('chmod-shadow'));
    await sleep(8000);
    // This one waits for a click on Allow or Block (unless --decide says otherwise).
    hold(holdBy('npm-install'), { origin: 'agent', utype: 'human', sudo: 'all (password)', caps: 'none' }, {});
    await sleep(15000);
    // This one decides itself after its report: the installer touches ssh keys, cron and the shell profile.
    hold(holdBy('install-sh'), { origin: 'ssh', utype: 'human', sudo: 'some', caps: 'two' }, { auto: 'block' });
    await sleep(12000);
    for (let i = 0; i < 6; i++) {
      block(i === 2 ? { origin: 'local', utype: 'root', sudo: 'unknown', caps: 'two' } : {});
      allow();
      await sleep(6000);
    }
    say('info', 'showcase sent everything; waiting for the open holds (click Allow or Block in the page)');
  }

  async function probabilities() {
    const examples = [
      { verdict: 'block', choice: 'block', decided_by: 'model', probabilities: { allow: 0.02, hold: 0.03, block: 0.95 }, entry: by('curl-pipe-sh'), want: { origin: 'agent', utype: 'human' } },
      { verdict: 'block', choice: 'block', decided_by: 'model', probabilities: { allow: 0.25, hold: 0.20, block: 0.55 }, entry: by('rm-rf-root'), want: { origin: 'ssh', utype: 'root' } },
      { verdict: 'block', choice: 'hold', decided_by: 'rule', probabilities: { allow: 0.15, hold: 0.70, block: 0.15 }, entry: by('chmod-shadow'), want: { origin: 'service', utype: 'service' } },
      { verdict: 'block', choice: 'allow', decided_by: 'rule', probabilities: { allow: 0.88, hold: 0.09, block: 0.03 }, entry: by('bash-dev-tcp'), want: { origin: 'local', utype: 'human' } },
      { verdict: 'block', choice: 'block', decided_by: 'model', probabilities: { allow: 0.01, hold: 0.04, block: 0.95 }, entry: by('ssh-key-exfil'), want: { origin: 'agent', utype: 'human' } },
      { verdict: 'block', choice: 'block', decided_by: 'model', probabilities: { allow: 0.18, hold: 0.17, block: 0.65 }, entry: by('cron-persist'), want: { origin: 'ssh', utype: 'human' } },
      { verdict: 'block', choice: 'hold', decided_by: 'rule', probabilities: { allow: 0.22, hold: 0.49, block: 0.29 }, entry: by('useradd-backdoor'), want: { origin: 'service', utype: 'service' } },
      { verdict: 'block', choice: 'allow', decided_by: 'rule', probabilities: { allow: 0.74, hold: 0.18, block: 0.08 }, entry: by('sudoers-nopasswd'), want: { origin: 'local', utype: 'root' } },
      { verdict: 'block', choice: 'block', decided_by: 'model', probabilities: { allow: 0.08, hold: 0.12, block: 0.80 }, entry: by('curl-chmod-run'), want: { origin: 'agent', utype: 'human' } },
      { verdict: 'block', choice: 'block', decided_by: 'model', probabilities: { allow: 0.12, hold: 0.24, block: 0.64 }, entry: by('disable-sid'), want: { origin: 'ssh', utype: 'root' } },
      { verdict: 'block', choice: 'hold', decided_by: 'rule', probabilities: { allow: 0.08, hold: 0.86, block: 0.06 }, entry: by('shadow-post'), want: { origin: 'service', utype: 'service' } },
      { verdict: 'block', choice: 'allow', decided_by: 'rule', probabilities: { allow: 0.66, hold: 0.22, block: 0.12 }, entry: by('scp-aws'), want: { origin: 'local', utype: 'human' } },
    ];
    for (const example of examples) {
      const { ev } = mk(example.verdict, example.entry, example.want, example);
      write(ev);
      say('MODEL', `${ev.verdict} decision; ${example.probabilities.allow * 100}% allow, ${example.probabilities.hold * 100}% hold, ${example.probabilities.block * 100}% block`);
      await sleep(180);
    }
  }

  // Demo traffic: a mean gap of about 3 s between events, and enough of them worth showing that the page is never
  // empty for long: 40% allow (the server drops these), 38% block, 20% hold, 2% hostile text.
  let stopped = false;
  async function loop() {
    // Something to look at straight away, then a long quiet.
    block();
    await sleep(6000);
    hold(null, {}, {});
    while (!stopped) {
      await sleep(r.exp(3000));
      const x = r.next();
      if (x < 0.4) allow();
      else if (x < 0.78) block();
      else if (x < 0.98) {
        const x2 = r.next();
        hold(null, {}, x2 < 0.35 ? { auto: 'allow' } : x2 < 0.6 ? { auto: 'block' } : {});
      } else if (r.chance(0.3)) hold(r.pick(HOSTILE), {}, { auto: 'block' }, HOSTILE_Q);
      else block({}, r.pick(HOSTILE));
    }
  }

  // ---- serve ----------------------------------------------------------------------------
  let child = null;
  const stop = () => {
    stopped = true;
    daemon.stop();
    if (child) child.kill('SIGTERM');
  };
  process.on('SIGINT', () => { stop(); say('info', `stopped after ${lines} lines`); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  if (o.serve) {
    const uname = (f) => execFileSync('uname', [f]).toString().trim();
    const bin = path.resolve(o.bin || path.join(ROOT, 'build', `${uname('-s')}-${uname('-m')}`, 'sid-web'));
    if (!fs.existsSync(bin)) { console.error(`sim: ${bin} not found; build it with make server`); process.exit(1); }
    const free = (p) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
    let port = 8080;
    if (!(await free(port))) port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
    child = spawn(bin, [], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, SID_EVENT_LOG: logPath, SID_DECISION_LOG: decPath, SID_WEB_PORT: String(port), SID_WEB_ADDR: '127.0.0.1', SID_WEB_ROOT: path.join(ROOT, 'dist') },
    });
    child.on('exit', (code) => { console.error(`sim: sid-web exited (${code})`); child = null; });
    console.log(`http://127.0.0.1:${port}/`);
    await sleep(300);
  }

  say('info', `log ${logPath}  decisions ${decPath}  decide ${o.decide || 'per scenario'}  hold timeout ${o.holdTimeout} s`);
  if (o.scenario === 'showcase') await showcase();
  if (o.scenario === 'probabilities') await probabilities();
  if (o.loop) await loop();
  await daemon.drain();
  say('info', `done, ${lines} lines written`);
  if (o.serve) await new Promise(() => {}); // keep serving until Ctrl-C
  stop();
}

main().catch((e) => { console.error(`sim: ${e.stack || e.message}`); process.exit(1); });
