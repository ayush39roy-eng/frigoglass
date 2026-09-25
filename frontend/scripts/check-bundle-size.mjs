/**
 * Bundle-budget CI gate (CLAUDE.md / frontend-builder SKILL): the INITIAL load —
 * shell + providers + the first route — must stay under 400 KB gzipped.
 *
 * "Initial chunk" here = the HTML entry's JS chunk + every chunk it statically
 * imports (transitively) + all CSS emitted by those chunks. Lazy route chunks
 * (the six surfaces) are excluded because they load on navigation, not first paint.
 *
 * Reads dist/.vite/manifest.json (vite `build.manifest: true`). No extra deps —
 * gzip via node:zlib.
 *
 * Exit non-zero (fails `npm run build` / CI) if over budget.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 400 * 1024;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, 'dist');
const manifestPath = join(distDir, '.vite', 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(`[bundle-budget] manifest not found at ${manifestPath}. Run \`vite build\` first.`);
  process.exit(1);
}

/** @type {Record<string, { file: string, isEntry?: boolean, imports?: string[], css?: string[] }>} */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
if (!entryKey) {
  console.error('[bundle-budget] no entry found in manifest.');
  process.exit(1);
}

const seen = new Set();
const files = new Set();

/** @param {string} key */
function walk(key) {
  if (seen.has(key)) return;
  seen.add(key);
  const chunk = manifest[key];
  if (!chunk) return;
  files.add(chunk.file);
  for (const css of chunk.css ?? []) files.add(css);
  for (const imp of chunk.imports ?? []) walk(imp);
}

walk(entryKey);

let total = 0;
const rows = [];
for (const file of [...files].sort()) {
  const buf = readFileSync(join(distDir, file));
  const gz = gzipSync(buf, { level: 9 }).length;
  total += gz;
  rows.push({ file, raw: buf.length, gzip: gz });
}

const fmt = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log('\n[bundle-budget] initial-load chunks (entry + static imports + their CSS):\n');
for (const r of rows) {
  console.log(`  ${r.file.padEnd(42)} ${fmt(r.raw).padStart(10)} raw   ${fmt(r.gzip).padStart(10)} gzip`);
}
console.log(`  ${'-'.repeat(42)}`);
console.log(`  ${'INITIAL TOTAL'.padEnd(42)} ${''.padStart(10)}       ${fmt(total).padStart(10)} gzip`);
console.log(`  budget: ${fmt(BUDGET_BYTES)} gzip   (${((total / BUDGET_BYTES) * 100).toFixed(1)}% used)\n`);

if (total > BUDGET_BYTES) {
  console.error(
    `[bundle-budget] FAIL — initial load ${fmt(total)} gzip exceeds the ${fmt(BUDGET_BYTES)} budget by ${fmt(total - BUDGET_BYTES)}.`,
  );
  console.error('Route-split further or reconsider the dependency. Raising the budget needs an ADR.');
  process.exit(1);
}

console.log(`[bundle-budget] PASS — ${fmt(total)} gzip, ${fmt(BUDGET_BYTES - total)} headroom.\n`);
