// Builds the dashboard into dist/: plain html, css and js that sid-web serves as is.
// esbuild is the only build step and nothing from node_modules is needed at run time.
//   node build.mjs          production build; fails if the size budget is broken
//   node build.mjs --dev    keeps the ?debug hooks (window.__sid, window.__csp)
import { build, transform } from 'esbuild';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dev = process.argv.includes('--dev');
const root = fileURLToPath(new URL('.', import.meta.url));
const at = (...p) => join(root, ...p);
const dist = at('dist');

// Size budget in bytes of minified output. The page must stay small to stay fast.
const BUDGET = { app: 64 * 1024 };

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'fonts'), { recursive: true });

// Fonts, renamed to the files tokens.css points at.
const fonts = [
  ['syne', 'Syne', [600]],
  ['tasa-explorer', 'TASAExplorer', [400, 600, 700]],
  ['commit-mono', 'CommitMono', [400, 500]],
];
for (const [pkg, name, weights] of fonts)
  for (const w of weights)
    await copyFile(
      at('node_modules', '@fontsource', pkg, 'files', `${pkg}-latin-${w}-normal.woff2`),
      join(dist, 'fonts', `${name}-${w}.woff2`));

// One stylesheet: Crystal's tokens and components, the status tokens, then the page's own rules.
// Each file is optional so the pieces can land one at a time.
const CSS = [
  ['design', 'tokens.css'], ['design', 'bundle.css'],
  ['src', 'status.css'], ['src', 'app.css'], ['src', 'shapes.css'],
  ['src', 'feed.css'], ['src', 'bar.css'], ['src', 'live.css'],
].filter((p) => existsSync(at(...p)));
const css = (await Promise.all(CSS.map((p) => readFile(at(...p), 'utf8')))).join('\n');
await writeFile(join(dist, 'app.css'), (await transform(css, { loader: 'css', minify: true })).code);

// The page. DEBUG is false in production, so the ?debug hooks are dropped from the output.
const common = { bundle: true, minify: true, format: 'iife', target: 'es2020', legalComments: 'none', metafile: true };
const app = await build({
  ...common,
  entryPoints: [at('src', 'app.js')],
  define: { DEBUG: String(dev) },
  outfile: join(dist, 'app.js'),
});

// Optional page modules are bundled only when the source exists.
if (existsSync(at('src', 'lib.js')))
  await build({ ...common, entryPoints: [at('src', 'lib.js')], outfile: join(dist, 'lib.js') });

await copyFile(at('src', 'index.html'), join(dist, 'index.html'));

// Report, and enforce the budget.
const out = app.metafile.outputs[Object.keys(app.metafile.outputs)[0]];
const parts = Object.entries(out.inputs)
  .map(([f, v]) => [f.replace(/^.*?(src|design)\//, '$1/'), v.bytesInOutput])
  .sort((a, b) => b[1] - a[1]);
const kb = (n) => (n / 1024).toFixed(1);
console.log('app.js by module (minified):');
for (const [f, n] of parts) console.log(`  ${kb(n).padStart(6)} kB  ${f}`);
const total = (await stat(join(dist, 'app.js'))).size;
console.log(`dist/app.js ${kb(total)} kB (budget ${kb(BUDGET.app)})`);
for (const f of ['index.html', 'app.css', 'lib.js'])
  if (existsSync(join(dist, f))) console.log(`dist/${f}  ${kb((await stat(join(dist, f))).size)} kB`);

if (total > BUDGET.app) {
  console.error('build: size budget broken');
  process.exit(1);
}
