/**
 * spa-entrypoints.mjs — crée une copie de index.html pour chaque route SPA.
 *
 * Pourquoi : avec `cleanUrls`, Vercel sert `/records` depuis `records.html`.
 * Générer ces fichiers garantit qu'un rafraîchissement sur n'importe quelle
 * route renvoie l'app (200) et non une 404, indépendamment de la rewrite.
 *
 * La liste des routes est LUE dans apps/web/src/router.ts (objet ROUTES) :
 * plus de liste dupliquée à maintenir à la main.
 */
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** Routes historiques encore référencées (anciens magic links). */
const LEGACY_ALIASES = ['/auth/callback'];

/** Extrait les clés de `const ROUTES: Record<RouteKey, string> = { ... }`. */
export function extractRoutes(routerSource) {
  const block = routerSource.match(/const ROUTES[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error('[spa-entrypoints] objet ROUTES introuvable dans router.ts');
  const routes = [...block[1].matchAll(/^\s*'(\/[^']*)'\s*:/gm)].map((m) => m[1]);
  if (routes.length === 0) throw new Error('[spa-entrypoints] aucune route extraite');
  return routes;
}

export async function writeEntrypoints(distDir, routes) {
  const indexPath = resolve(distDir, 'index.html');
  await stat(indexPath);
  const written = [];
  for (const route of [...routes, ...LEGACY_ALIASES]) {
    if (route === '/') continue;
    const target = resolve(distDir, `${route.slice(1)}.html`);
    await mkdir(dirname(target), { recursive: true });
    await cp(indexPath, target);
    written.push(route);
  }
  return written;
}

async function main() {
  const routerSource = await readFile(resolve(repoRoot, 'apps/web/src/router.ts'), 'utf8');
  const distDir = resolve(repoRoot, 'apps/web/dist');
  const routes = extractRoutes(routerSource);
  const written = await writeEntrypoints(distDir, routes);
  console.log(`[spa-entrypoints] ${written.length} entrées générées : ${written.join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
