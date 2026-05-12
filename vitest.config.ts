import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@kinetic/core', replacement: resolve(__dirname, 'packages/core/src/index.ts') },
      { find: '@kinetic/adapters-web', replacement: resolve(__dirname, 'packages/adapter-web/src/index.ts') },
      { find: /^@test-helpers\/(.*)$/, replacement: resolve(__dirname, 'tests/helpers') + '/$1' },
      { find: '@test-helpers', replacement: resolve(__dirname, 'tests/helpers') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    coverage: {
      provider:         'v8',
      reportsDirectory: 'tests/coverage',
      reporter:         ['text', 'json', 'html', 'json-summary'],
      include:          ['packages/*/src/**/*.ts', 'apps/web/src/**/*.ts'],
      exclude:          [
        '**/*.test.ts',
        '**/index.ts',
        '**/database.types.ts',
        'apps/web/src/alpine.d.ts',
        // Port interfaces are pure types — no runtime coverage possible
        'packages/core/src/ports/**',
        // Infrastructure adapters require real browser/IDB — covered by integration tests
        'packages/adapter-web/src/IdbStorage.ts',
        'packages/adapter-web/src/SupabaseStorage.ts',
        'packages/adapter-web/src/SupabaseDailyLogSync.ts',
        'packages/adapter-web/src/auth.ts',
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
        lines:      60,
        statements: 60,
        functions:  60,
        branches:   55,
      },
    },
  },
});
