import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@kinetic/core', replacement: resolve(__dirname, 'packages/core/src/index.ts') },
      {
        find: '@kinetic/adapters-web',
        replacement: resolve(__dirname, 'packages/adapter-web/src/index.ts'),
      },
      { find: /^@test-helpers\/(.*)$/, replacement: resolve(__dirname, 'tests/helpers') + '/$1' },
      { find: '@test-helpers', replacement: resolve(__dirname, 'tests/helpers') },
      // idb-keyval is a browser-only package — replace with in-memory stub for Node tests.
      // The real IdbStorage adapter is excluded from coverage and tested via E2E.
      // Mêmes coquilles vides qu'au build (vite.config.ts) pour les sous-modules
      // supabase-js inutilisés : les tests tournent sur le même client qu'en prod.
      ...['realtime', 'storage', 'functions'].map((name) => ({
        find: new RegExp(`^@supabase/${name}-js$`),
        replacement: resolve(__dirname, `apps/web/src/lib/supabase-stubs/${name}.ts`),
      })),
      {
        find: 'idb-keyval',
        replacement: resolve(__dirname, 'tests/helpers/idb-keyval.mock.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    // Global mocks for Capacitor (mobile-only, not available in Node test env).
    // Tests that need finer control can override with their own vi.mock() calls.
    server: {
      deps: {
        inline: [
          '@capacitor/core',
          '@capacitor/filesystem',
          '@capacitor/share',
          '@supabase/supabase-js',
        ],
      },
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'tests/coverage',
      reporter: ['text', 'json', 'html', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/web/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/database.types.ts',
        'apps/web/src/alpine.d.ts',
        // Port interfaces are pure types — no runtime coverage possible
        'packages/core/src/ports/**',
        // Infrastructure adapters require real browser/IDB — covered by integration tests
        'packages/adapter-web/src/IdbStorage.ts',
        'packages/adapter-web/src/supabase/SupabaseStorage.ts',
        'packages/adapter-web/src/supabase/SupabaseDailyLogSync.ts',
        'packages/adapter-web/src/supabase/auth.ts',
        'packages/adapter-web/src/supabase.ts',
        // Pages are UI components best covered by E2E tests (Playwright)
        'apps/web/src/pages/**',
        // main.ts and router.ts are app bootstrap — tested via E2E
        'apps/web/src/main.ts',
        'apps/web/src/router.ts',
        // deps.ts is the app wire-up — covered by deps.factory tests
        'apps/web/src/deps.ts',
      ],

      // Seuils vérifiés par `pnpm test:coverage` (CI) : un peu sous la valeur mesurée
      // (QA-06, novembre 2026), pour qu'une baisse nette fasse échouer la CI. Mesure du
      // jour : global 85,2 / 89,0 / 90,3 (lignes / branches / fonctions) ; core 98,8 /
      // 91,4 / 98,6 ; synchro 89,8 / 81,9 / 85,7 ; lib/training 96,5 / 91,2 / 96,7.
      // À remonter quand la couverture progresse ; ne jamais les baisser pour passer.
      thresholds: {
        lines: 83,
        statements: 83,
        functions: 88,
        branches: 87,
        // Domaine pur : règles métier, calculs de progression, fusion de synchro.
        'packages/core/src/**': { lines: 97, statements: 97, functions: 97, branches: 89 },
        // Moteur de synchro (outbox, pull/push, base par compte, migrations).
        'packages/adapter-web/src/sync/**': {
          lines: 87,
          statements: 87,
          functions: 83,
          branches: 79,
        },
        // Séances : enregistrement, suppression, séance en cours, import/export.
        'apps/web/src/lib/training/**': {
          lines: 94,
          statements: 94,
          functions: 94,
          branches: 88,
        },
      },
    },
  },
});
