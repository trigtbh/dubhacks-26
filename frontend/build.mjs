// Builds the dashboard into dist/: plain html, css and js that sid-web serves as is.
// esbuild is the only build step and nothing from node_modules is needed at run time.
import { build, transform } from 'esbuild';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const at = (...p) => join(root, ...p);
const dist = at('dist');

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

// ShaderGradient with three.js and React, bundled once (design system appendix E).
// The page loads it only while it has no events to show, then lets it go.
await build({
  entryPoints: [at('design', 'shader', 'entry.jsx')],
  bundle: true, minify: true, format: 'iife', target: 'es2019',
  alias: { framer: at('design', 'shader', 'stub.js') },
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  banner: { js: '/* ShaderGradient 2.4.20 (MIT, ruucm) with three.js 0.169.0 (MIT), @react-three/fiber 8.17.10 (MIT), @react-spring/three 9.7.5 (MIT), React 18.3.1 (MIT). Bundled for the Crystal design system as window.CrystalGradient. */' },
  outfile: join(dist, 'shader.js'),
});

// One stylesheet: tokens, components, then the dashboard's own rules.
const css = (await Promise.all(
  [at('design', 'tokens.css'), at('design', 'bundle.css'), at('src', 'app.css')]
    .map((f) => readFile(f, 'utf8')))).join('\n');
await writeFile(join(dist, 'app.css'), (await transform(css, { loader: 'css', minify: true })).code);

// One script: the design system's bundle.js plus the dashboard.
await build({
  entryPoints: [at('src', 'app.js')],
  bundle: true, minify: true, format: 'iife', target: 'es2019',
  outfile: join(dist, 'app.js'),
});

await copyFile(at('src', 'index.html'), join(dist, 'index.html'));

for (const f of ['index.html', 'app.css', 'app.js', 'shader.js']) {
  const kb = ((await stat(join(dist, f))).size / 1024).toFixed(1);
  console.log(`dist/${f}  ${kb} kB`);
}
