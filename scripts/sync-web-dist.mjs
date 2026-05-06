import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const src = resolve(repoRoot, 'apps', 'web', 'dist');

// Some Vercel projects are configured with different "Root Directory" values.
// We copy the build output to a couple of common locations so the deploy can
// succeed even if the project's Output Directory points at `dist`.
const destinations = [
  resolve(repoRoot, 'dist'),
  resolve(repoRoot, 'apps', 'dist'),
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureSpaEntrypoints(dir) {
  const indexPath = resolve(dir, 'index.html');
  if (!(await exists(indexPath))) return;

  // Routes SPA — DOIT matcher exactement les clés de ROUTES dans router.ts.
  // Sans copie d'index.html à ces chemins, Vercel renvoie 404 (la rewrite
  // SPA du vercel.json n'est pas prioritaire face à cleanUrls + routes
  // statiques manquantes).
  const pages = [
    'onboarding',
    'seances',
    'vitalite',
    'profile',
    'login',
    'auth-callback',
    'bodyweight',
    'mensurations',
    'nutrition',
    'program',
    'progression',
  ];

  for (const p of pages) {
    await cp(indexPath, resolve(dir, `${p}.html`));
  }

  // Compat ancien chemin /auth/callback (au cas où d'anciens magic links
  // ou config Supabase pointent encore dessus).
  const authDir = resolve(dir, 'auth');
  await mkdir(authDir, { recursive: true });
  await cp(indexPath, resolve(authDir, 'callback.html'));
}

if (!(await exists(src))) {
  console.log(`[sync-web-dist] Source not found, skipping: ${src}`);
  process.exit(0);
}

// Vercel outputDirectory points at apps/web/dist, so make sure entrypoints exist there.
await ensureSpaEntrypoints(src);

for (const dest of destinations) {
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
  console.log(`[sync-web-dist] Copied ${src} -> ${dest}`);
}
