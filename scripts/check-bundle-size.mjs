#!/usr/bin/env node
/**
 * scripts/check-bundle-size.mjs
 *
 * Vérifie que les bundles de production respectent les budgets.
 * Échoue (exit 1) si un seuil est dépassé.
 *
 * Utilisation : pnpm size
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'apps', 'web', 'dist');

// Budgets en octets (raw / gzip / brotli)
const BUDGETS = {
  totalDist: 2 * 1024 * 1024, // 2 MiB total
  singleJsRaw: 350 * 1024, // 350 KiB par fichier JS
  singleJsGzip: 110 * 1024, // 110 KiB gzip par fichier JS
  totalJsGzip: 250 * 1024, // 250 KiB gzip pour tout le JS
  totalCssGzip: 30 * 1024, // 30 KiB gzip pour tout le CSS
};

const PALETTE = {
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  err: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function check(label, actual, budget) {
  const pct = ((actual / budget) * 100).toFixed(0);
  const within = actual <= budget;
  const color = within ? PALETTE.ok : PALETTE.err;
  const icon = within ? '✓' : '✗';
  console.log(
    `${color}${icon}${PALETTE.reset} ${label}: ${fmt(actual)} / ${fmt(budget)} (${pct}%)`,
  );
  return within;
}

try {
  statSync(DIST);
} catch {
  console.error(
    `${PALETTE.err}✗ Pas de build trouvé à ${DIST}.${PALETTE.reset} Lance d'abord \`pnpm build\`.`,
  );
  process.exit(1);
}

const files = walk(DIST);
let totalSize = 0;
let totalJsGzip = 0;
let totalCssGzip = 0;
let allOk = true;

console.log(`\n${PALETTE.dim}=== Bundle audit ===${PALETTE.reset}\n`);

for (const f of files) {
  const st = statSync(f);
  totalSize += st.size;
  if (!/\.(js|css)$/.test(f)) continue;

  const content = readFileSync(f);
  const gz = gzipSync(content).length;
  const br = brotliCompressSync(content).length;
  const rel = f.replace(DIST + '\\', '').replace(DIST + '/', '');

  console.log(
    `  ${PALETTE.dim}${rel.padEnd(60)}${PALETTE.reset} ` +
      `raw=${fmt(st.size).padStart(10)}  gz=${fmt(gz).padStart(10)}  br=${fmt(br).padStart(10)}`,
  );

  if (f.endsWith('.js')) {
    totalJsGzip += gz;
    if (st.size > BUDGETS.singleJsRaw) {
      console.error(
        `    ${PALETTE.err}✗ JS individuel ${fmt(st.size)} > ${fmt(BUDGETS.singleJsRaw)}${PALETTE.reset}`,
      );
      allOk = false;
    }
    if (gz > BUDGETS.singleJsGzip) {
      console.error(
        `    ${PALETTE.err}✗ JS gzip ${fmt(gz)} > ${fmt(BUDGETS.singleJsGzip)}${PALETTE.reset}`,
      );
      allOk = false;
    }
  } else if (f.endsWith('.css')) {
    totalCssGzip += gz;
  }
}

console.log('');
allOk = check('Total dist', totalSize, BUDGETS.totalDist) && allOk;
allOk = check('Total JS gzip', totalJsGzip, BUDGETS.totalJsGzip) && allOk;
allOk = check('Total CSS gzip', totalCssGzip, BUDGETS.totalCssGzip) && allOk;

if (!allOk) {
  console.error(`\n${PALETTE.err}✗ Bundle audit failed — ${'budget'} dépassé.${PALETTE.reset}\n`);
  process.exit(1);
}

console.log(`\n${PALETTE.ok}✓ Bundle audit passed.${PALETTE.reset}\n`);
