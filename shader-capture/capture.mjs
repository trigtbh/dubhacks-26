// One-off: render the ShaderGradient in entry.jsx at 4096x4096 and save it as a PNG.
//   node shader-capture/capture.mjs [out.png]      (default ~/Downloads/shadergradient-4096.png)
// Bundles entry.jsx with the frontend's esbuild, serves it on localhost and opens your default
// browser, which renders it and posts the PNG back here.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const frontend = resolve(here, '../frontend');
const { build } = createRequire(join(frontend, 'package.json'))('esbuild');
const out = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(homedir(), 'Downloads', 'shadergradient-4096.png'));

const { outputFiles } = await build({
  entryPoints: [join(here, 'entry.jsx')],
  bundle: true, write: false, minify: true, format: 'iife', target: 'es2020', logLevel: 'warning',
  nodePaths: [join(frontend, 'node_modules')],
  alias: { framer: join(frontend, 'design/shader/stub.js') },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const html = `<!doctype html><title>rendering</title><body style="margin:0;background:#000">
<div id=stage style="position:relative;width:4096px;height:4096px"></div><script src=/bundle.js></script>`;

const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await writeFile(out, Buffer.concat(chunks));
    console.log(`saved ${out}`);
    res.end('ok', () => process.exit(0));
  } else if (req.url === '/bundle.js') {
    res.setHeader('content-type', 'text/javascript').end(outputFiles[0].text);
  } else {
    res.setHeader('content-type', 'text/html').end(html);
  }
});

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`opening ${url}`);
  if (!process.argv.includes('--no-open')) execFile('open', [url]);
});
