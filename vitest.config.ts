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
      include:          ['packages/*/src/**/*.ts'],
      exclude:          ['**/*.test.ts', '**/index.ts', '**/database.types.ts'],

      /**
       * Seuils de couverture — bloquants : la CI échoue si en dessous.
       *
       * L2 FIX (2026-05-04): seuils remontés au niveau de la baseline mesurée
       * pour détecter toute régression. Ne pas descendre ces valeurs sans
       * commenter la justification dans la PR.
       *
       * Valeurs courantes (baseline 2026-04-30) :
       *   lines:      ~73%   functions: ~60%
       *   statements: ~73%   branches:  ~66%
       */
      thresholds: {
        lines:      73,
        statements: 73,
        functions:  60,
        branches:   66,
      },
    },
  },
});
