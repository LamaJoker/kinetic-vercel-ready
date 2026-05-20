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
        inline: ['@capacitor/core', '@capacitor/filesystem', '@capacitor/share'],
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

      thresholds: {
        lines: 70,
        statements: 70,
        functions: 72,
        branches: 84,
      },
    },
  },
});
