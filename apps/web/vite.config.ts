import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';
import { basename, resolve } from 'path';
import { readFileSync, readdirSync, writeFileSync } from 'fs';

/**
 * Remplit les jetons de public/sw.js (copié tel quel par Vite) :
 *   __SW_BUILD__      version unique du déploiement (nom des caches versionnés) ;
 *   __SW_EXERCISES__  noms des schémas public/exercises/*.svg, précachés à
 *                     l'installation pour fonctionner hors ligne.
 */
export function injectSwTokens(src: string, version: string, exerciseNames: string[]): string {
  const names = exerciseNames
    .filter((n) => /^[a-z0-9-]+$/.test(n))
    .sort()
    .join(',');
  return src.replace(/__SW_BUILD__/g, version).replace(/__SW_EXERCISES__/g, names);
}

/**
 * Injects a build-time cache-busting version into dist/sw.js.
 * public/sw.js is copied verbatim by Vite (not run through Rollup) so we
 * post-process the output file in closeBundle instead.
 * Replaces __SW_BUILD__ with a unique timestamp on every production build.
 */
function injectSwVersion(): Plugin {
  const version = `kinetic-v${Date.now()}`;
  return {
    name: 'inject-sw-version',
    async closeBundle() {
      const swOut = resolve(__dirname, 'dist/sw.js');
      try {
        const src = readFileSync(swOut, 'utf8');
        const names = readdirSync(resolve(__dirname, 'public/exercises'))
          .filter((f) => f.endsWith('.svg'))
          .map((f) => f.slice(0, -4));
        // Minifié (commentaires, espaces) : ~1,6 KiB gzip de moins à chaque installation.
        const { code } = await transformWithEsbuild(injectSwTokens(src, version, names), 'sw.js', {
          minify: true,
          loader: 'js',
          target: 'es2020',
        });
        writeFileSync(swOut, code, 'utf8');
      } catch {
        // Not a production build (e.g. vite dev) — silently skip.
      }
    },
  };
}

/**
 * Compacte au build le HTML des pages, embarqué dans les chunks JS via `?raw`
 * (cf. router.ts) : retire les commentaires et l'indentation. Environ 10 KiB
 * gzip de moins au total. Sûr : les espaces entre balises sont réduits par le
 * navigateur de toute façon, et le seul <pre> des pages est rempli par x-text.
 */
export function compactHtml(source: string): string {
  // Retrait répété jusqu'à stabilité : un commentaire imbriqué ou reformé par
  // un premier passage (« <!<!---->-- ») ne peut pas survivre.
  let html = source;
  let previous: string;
  do {
    previous = html;
    html = html.replace(/<!--[\s\S]*?-->/g, '');
  } while (html !== previous);
  return html.replace(/\n[ \t]+/g, '\n').replace(/\n{2,}/g, '\n');
}

/** Module qui télécharge un gabarit émis en fichier statique (voir ci-dessous). */
const PAGE_TEMPLATE_LOADER = resolve(__dirname, 'src/lib/page-template.ts');

/**
 * Gabarits des pages (`src/pages/*.html?raw`, cf. router.ts) : au build, chacun
 * est compacté puis émis en fichier statique `static/assets/<page>-<hash>.txt`
 * au lieu d'une chaîne dans un chunk JS. Le module JS ne contient plus que
 * l'URL ; le texte est téléchargé à l'affichage (lib/page-template.ts) et mis en
 * cache par le service worker comme les autres fichiers de /static/.
 * Extension .txt (text/plain) et non .html : le service worker refuse de mettre
 * en cache une réponse text/html sous /static/ (repli SPA), et Vercel
 * (cleanUrls) redirigerait un .html.
 * Gain : ~70 KiB gzip de HTML sortis du JS (plus à analyser comme du code).
 */
export function pageTemplateModule(fileUrlExpression: string): string {
  return (
    `import { pageTemplate } from ${JSON.stringify(PAGE_TEMPLATE_LOADER)};\n` +
    `export default pageTemplate(${fileUrlExpression});\n`
  );
}

function compactPageHtml(): Plugin {
  return {
    name: 'compact-page-html',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      const [file, query] = id.split('?');
      if (query !== 'raw' || !file || !/[\\/]src[\\/]pages[\\/][^\\/]+\.html$/.test(file)) {
        return null;
      }
      const ref = this.emitFile({
        type: 'asset',
        name: basename(file).replace(/\.html$/, '.txt'),
        source: compactHtml(readFileSync(file, 'utf8')),
      });
      return pageTemplateModule(`import.meta.ROLLUP_FILE_URL_${ref}`);
    },
  };
}

/**
 * Sous-modules de supabase-js jamais utilisés par Kinetic (Realtime, Storage,
 * Edge Functions) mais importés et instanciés par createClient() : remplacés
 * par des coquilles vides (~22 KiB gzip de JS en moins). Voir
 * src/lib/supabase-stubs/unused.ts pour le détail et comment les réactiver.
 */
export const SUPABASE_UNUSED_STUBS: Record<string, string> = {
  '@supabase/realtime-js': resolve(__dirname, 'src/lib/supabase-stubs/realtime.ts'),
  '@supabase/storage-js': resolve(__dirname, 'src/lib/supabase-stubs/storage.ts'),
  '@supabase/functions-js': resolve(__dirname, 'src/lib/supabase-stubs/functions.ts'),
};

/**
 * Même principe à l'intérieur de `@supabase/auth-js` : l'API d'administration
 * (clé service_role, jamais côté client), WebAuthn (MFA, passkeys) et la
 * connexion Web3 ne servent pas à Kinetic (lien magique + OAuth uniquement) mais
 * sont instanciées par GoTrueClient. Imports relatifs → plugin resolveId.
 */
export const SUPABASE_AUTH_UNUSED_STUBS: Record<string, string> = {
  './GoTrueAdminApi': resolve(__dirname, 'src/lib/supabase-stubs/auth-admin.ts'),
  './lib/webauthn': resolve(__dirname, 'src/lib/supabase-stubs/auth-webauthn.ts'),
  './lib/web3/ethereum': resolve(__dirname, 'src/lib/supabase-stubs/auth-web3.ts'),
};

function stubUnusedSupabaseAuth(): Plugin {
  return {
    name: 'stub-unused-supabase-auth',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !/[\\/]@supabase[\\/]auth-js[\\/]/.test(importer)) return null;
      return SUPABASE_AUTH_UNUSED_STUBS[source.replace(/\.js$/, '')] ?? null;
    },
  };
}

/**
 * Modules sortis des chunks partagés chargés au démarrage (kinetic-core,
 * lib-training) : chacun dans son propre chunk, chargé seulement avec les pages
 * qui l'importent. (Un module simplement non assigné serait aspiré dans le chunk
 * de son importeur, le barrel index.ts de kinetic-core.) À compléter pour toute donnée ou logique qui ne sert pas au
 * premier écran (voir docs dans scripts/check-bundle-size.mjs).
 */
export const LAZY_CORE_MODULES = [
  'domain/glossary.domain', // glossaire (page Glossaire, bulles ⓘ)
  'domain/exercise-cues.domain', // consignes d'exécution (Séances)
  // programmes 5/3/1, etc. (page Programmes). Ses appels au niveau du module sont
  // annotés @__PURE__ : sinon Rollup le croit à effets de bord et l'importe partout.
  'domain/programs-catalog.domain',
  'domain/training-calendar.domain', // calendrier du mois (Séances › Historique)
  'domain/muscle-map.domain', // carte des muscles (Progression, aperçu accueil)
  'domain/session-share-card.domain', // carte « Partager en image » (Séances)
  'domain/superset.domain', // supersets (Séances, éditeur de modèles)
  'domain/exercise-measure.domain', // exercices chronométrés / distance (Séances, Records)
  'domain/week-plan.domain', // semaine qui s'adapte (Programme, accueil si programme suivi)
  'domain/strength-goals.domain', // objectifs de force (Progression, accueil, Séances)
  'domain/plateau.domain', // alerte de stagnation (Séances, Progression)
  'domain/strength-tools.domain', // calculateurs 1RM / % / RPE (page Outils)
  'domain/period-compare.domain', // comparer deux périodes (Progression)
];
export const LAZY_TRAINING_MODULES = [
  'training/import', // import Strong / Hevy (Profil)
  'training/export', // export CSV / JSON (Profil, sauvegarde auto)
];

export default defineConfig({
  plugins: [compactPageHtml(), stubUnusedSupabaseAuth(), injectSwVersion()],

  resolve: {
    alias: {
      // Use the CSP-safe Alpine build at runtime (removes 'unsafe-eval' from CSP).
      // TypeScript still resolves types from 'alpinejs' (kept in devDependencies).
      alpinejs: '@alpinejs/csp',
      '@kinetic/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@kinetic/adapters-web': resolve(__dirname, '../../packages/adapter-web/src/index.ts'),
      ...SUPABASE_UNUSED_STUBS,
    },
  },

  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    cssMinify: true,
    cssCodeSplit: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 250, // KiB — warning si un chunk dépasse

    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
      output: {
        manualChunks(id) {
          // Vendors séparés pour caching long
          if (id.includes('node_modules')) {
            if (id.includes('alpinejs') || id.includes('@alpinejs')) return 'alpine';
            if (id.includes('@supabase/supabase-js')) return 'supabase';
            if (id.includes('idb-keyval')) return 'idb';
            // Seulement le cœur Capacitor : les implémentations web des plugins
            // (`web.js`, importées à la demande par registerPlugin) et les plugins
            // chargés par import() restent des chunks séparés, hors démarrage.
            if (/@capacitor[\\/](core|synapse)[\\/]/.test(id)) return 'capacitor';
            if (id.includes('@capacitor') || id.includes('@capgo')) return undefined;
            return 'vendor';
          }
          // Domain layer (packages/core) — pure logic, peut être caché agressivement
          // Sauf les données et la logique propres à des écrans rares (LAZY_CORE_MODULES).
          if (id.includes('packages/core/')) {
            const lazy = LAZY_CORE_MODULES.find((m) => id.includes(m));
            return lazy ? `core-${lazy.split('/').pop()!.replace('.domain', '')}` : 'kinetic-core';
          }
          // Adapters (packages/adapter-web)
          if (id.includes('packages/adapter-web/')) return 'kinetic-adapters';
          // Stores Alpine — partagés entre toutes les pages
          if (id.includes('apps/web/src/stores/')) return 'stores';
          // Libs utilitaires
          if (id.includes('apps/web/src/lib/training/')) {
            const lazy = LAZY_TRAINING_MODULES.find((m) => id.includes(m));
            return lazy ? `lib-training-${lazy.split('/').pop()!}` : 'lib-training';
          }
          if (id.includes('apps/web/src/lib/user/')) return 'lib-user';
          // Pages secondaires (programmes, photos) — déchargent main de ~30 KB
          if (id.includes('apps/web/src/pages/programs.page')) return 'page-programs';
          if (id.includes('apps/web/src/pages/photos.page')) return 'page-photos';
          if (id.includes('apps/web/src/pages/achievements.page')) return 'page-achievements';
          if (id.includes('apps/web/src/pages/plates.page')) return 'page-plates';
          // Photos lib : dépendances DOM lourdes (canvas), seulement utiles sur /photos
          if (id.includes('apps/web/src/lib/photos.ts')) return 'lib-photos';
          // Error reporter : non critique, peut être chargé séparément
          if (id.includes('apps/web/src/lib/error-reporter.ts')) return 'lib-error-reporter';
        },
        assetFileNames: 'static/assets/[name]-[hash][extname]',
        chunkFileNames: 'static/chunks/[name]-[hash].js',
        entryFileNames: 'static/[name]-[hash].js',
      },
    },
  },

  server: {
    port: 3000,
  },

  preview: {
    port: 4173,
    headers: { 'Cache-Control': 'no-store' },
  },

  optimizeDeps: {
    include: ['@alpinejs/csp', 'idb-keyval'],
  },

  esbuild: {
    // console.error + console.warn kept in prod: vital for diagnosing APK bugs
    // without DevTools. The global handler in main.ts also persists them to
    // localStorage so errors surface even on device.
    // console.log/debug/info/trace: marked pure so esbuild drops them as
    // side-effect-free dead code (their return values are always unused).
    pure:
      process.env['NODE_ENV'] === 'production'
        ? ['console.log', 'console.debug', 'console.info', 'console.trace']
        : [],
    drop: process.env['NODE_ENV'] === 'production' ? ['debugger'] : [],
    legalComments: 'none',
  },
});
