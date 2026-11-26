#!/usr/bin/env node
/**
 * scripts/check-bundle-size.mjs
 *
 * Vérifie que les bundles de production respectent les budgets.
 * Échoue (exit 1) si un seuil est dépassé.
 *
 * Utilisation : pnpm size
 *
 * Deux budgets JS complémentaires :
 *  - « JS initial » : ce que le navigateur télécharge et exécute AVANT le premier
 *    écran = le script d'entrée + ses <link rel="modulepreload"> dans
 *    dist/index.html (le graphe statique d'imports, calculé par Vite). C'est ce
 *    qui ralentit le démarrage : budget serré.
 *  - « Total JS » : tous les chunks, y compris ceux chargés à la demande (pages,
 *    import/export, gestes…), qui restent téléchargés puis mis en cache hors-ligne.
 *    Plafond plus large, contre l'embonpoint général.
 *
 * Règle pour ajouter du code (voir aussi apps/web/src/page-components.ts) :
 *  - une page = un gabarit src/pages/<page>.html (émis en fichier .txt, hors JS)
 *    + son composant enregistré dans page-components.ts, jamais importé par main.ts ;
 *  - une fonction rare (import, export, partage, célébration…) = import() à
 *    l'endroit où elle sert, pas d'import statique depuis main.ts, un store ou
 *    lib/training/storage.ts ;
 *  - une grosse donnée de packages/core propre à un écran : l'ajouter à
 *    LAZY_CORE_MODULES (vite.config.ts), sans appel de fonction au niveau du
 *    module (ou annoté « @__PURE__ »), sinon Rollup l'importe partout. Un appel annoté
 *    garde quand même ses ARGUMENTS : envelopper le tout (`/* @__PURE__ *\/ (() => …)()`) ;
 *  - jamais `import('@kinetic/core')` ni `import('@kinetic/adapters-web')` : l'import()
 *    du point d'entrée d'un paquet garde TOUS ses exports dans le lot de démarrage
 *    (tests/unit/startup-bundle.test.ts).
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = join(process.cwd(), 'apps', 'web', 'dist');

// Budgets en octets (raw / gzip / brotli)
export const BUDGETS = {
  // Tout dist (police, schémas SVG, gabarits…) : l'app est installée sur le téléphone,
  // relevé de 2 à 3 MiB ; la vitesse d'ouverture reste tenue par initialJsGzip.
  totalDist: 3 * 1024 * 1024,
  singleJsRaw: 350 * 1024, // 350 KiB par fichier JS
  singleJsGzip: 110 * 1024, // 110 KiB gzip par fichier JS
  initialJsGzip: 130 * 1024, // 130 KiB gzip chargés avant le premier écran
  // Tout le JS, écrans chargés à la demande compris. Le démarrage est tenu par
  // initialJsGzip ; ce plafond évite seulement une dérive globale (relevé de 250 à
  // 350 KiB : les écrans à la demande sont dans l'app et ne ralentissent pas l'ouverture).
  totalJsGzip: 350 * 1024,
  totalTemplatesGzip: 100 * 1024, // 100 KiB gzip de gabarits de pages (.txt)
  totalCssGzip: 30 * 1024, // 30 KiB gzip pour tout le CSS
};

/**
 * Fichiers JS du chargement initial, d'après dist/index.html : script(s) module
 * d'entrée + modulepreload. Chemins relatifs à dist (sans « / » initial).
 * @param {string} indexHtml
 * @returns {string[]}
 */
export function initialJsFiles(indexHtml) {
  const files = new Set();
  for (const tag of indexHtml.match(/<(script|link)\b[^>]*>/g) ?? []) {
    const isEntry = /^<script/.test(tag) && /type="module"/.test(tag);
    const isPreload = /^<link/.test(tag) && /rel="modulepreload"/.test(tag);
    if (!isEntry && !isPreload) continue;
    const url = tag.match(/(?:src|href)="([^"]+\.js)"/)?.[1];
    if (url && !/^(https?:)?\/\//.test(url)) files.add(url.replace(/^\//, ''));
  }
  return [...files];
}

/**
 * Sorties du compilateur TypeScript égarées dans dist (QA-05) : déclarations, sourcemaps,
 * tsbuildinfo ou le dossier `src/` qu'émettait `tsc --build`. dist est copié tel quel
 * dans les apps natives (`cap sync`) : ces fichiers y livreraient le code source.
 * @param {string[]} relPaths chemins relatifs à dist, séparés par « / »
 * @returns {string[]}
 */
export function compilerLeftovers(relPaths) {
  return relPaths.filter((rel) => /\.(ts|map|tsbuildinfo)$/.test(rel) || rel.startsWith('src/'));
}

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

function main() {
  try {
    statSync(DIST);
  } catch {
    console.error(
      `${PALETTE.err}✗ Pas de build trouvé à ${DIST}.${PALETTE.reset} Lance d'abord \`pnpm build\`.`,
    );
    process.exit(1);
  }

  const files = walk(DIST);
  const initial = new Set(initialJsFiles(readFileSync(join(DIST, 'index.html'), 'utf8')));
  let totalSize = 0;
  let totalJsGzip = 0;
  let initialJsGzip = 0;
  let totalTemplatesGzip = 0;
  let totalCssGzip = 0;
  let allOk = true;

  console.log(`\n${PALETTE.dim}=== Bundle audit ===${PALETTE.reset}\n`);

  for (const f of files) {
    const st = statSync(f);
    totalSize += st.size;
    const rel = f
      .replace(DIST + '\\', '')
      .replace(DIST + '/', '')
      .replace(/\\/g, '/');
    // Gabarits de pages émis par compactPageHtml (vite.config.ts).
    if (/^static\/assets\/.+\.txt$/.test(rel)) {
      totalTemplatesGzip += gzipSync(readFileSync(f)).length;
      continue;
    }
    if (!/\.(js|css)$/.test(f)) continue;

    const content = readFileSync(f);
    const gz = gzipSync(content).length;
    const br = brotliCompressSync(content).length;
    const mark = initial.has(rel) ? '*' : ' ';

    console.log(
      `${mark} ${PALETTE.dim}${rel.padEnd(60)}${PALETTE.reset} ` +
        `raw=${fmt(st.size).padStart(10)}  gz=${fmt(gz).padStart(10)}  br=${fmt(br).padStart(10)}`,
    );

    if (f.endsWith('.js')) {
      totalJsGzip += gz;
      if (initial.has(rel)) initialJsGzip += gz;
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

  const leftovers = compilerLeftovers(
    files.map((f) => f.slice(DIST.length + 1).replace(/\\/g, '/')),
  );
  if (leftovers.length > 0) {
    console.error(
      `${PALETTE.err}✗ Sorties de tsc dans dist (à ne pas livrer) : ${leftovers.slice(0, 5).join(', ')}` +
        `${leftovers.length > 5 ? '…' : ''}${PALETTE.reset}`,
    );
    allOk = false;
  }

  if (initial.size === 0) {
    console.error(`${PALETTE.err}✗ Aucun script d'entrée trouvé dans index.html${PALETTE.reset}`);
    allOk = false;
  }

  console.log(`\n${PALETTE.dim}* = chargé au démarrage (index.html)${PALETTE.reset}\n`);
  allOk = check('Total dist', totalSize, BUDGETS.totalDist) && allOk;
  allOk = check('JS initial gzip', initialJsGzip, BUDGETS.initialJsGzip) && allOk;
  allOk = check('Total JS gzip', totalJsGzip, BUDGETS.totalJsGzip) && allOk;
  allOk = check('Gabarits de pages gzip', totalTemplatesGzip, BUDGETS.totalTemplatesGzip) && allOk;
  allOk = check('Total CSS gzip', totalCssGzip, BUDGETS.totalCssGzip) && allOk;

  if (!allOk) {
    console.error(`\n${PALETTE.err}✗ Bundle audit failed — budget dépassé.${PALETTE.reset}\n`);
    process.exit(1);
  }

  console.log(`\n${PALETTE.ok}✓ Bundle audit passed.${PALETTE.reset}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
