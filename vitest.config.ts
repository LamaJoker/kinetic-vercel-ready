import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@kinetic/core':         resolve(__dirname, 'packages/core/src/index.ts'),
      '@kinetic/adapters-web': resolve(__dirname, 'packages/adapter-web/src/index.ts'),
      '@test-helpers':         resolve(__dirname, 'tests/helpers'),
    },
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
       * Valeurs courantes (baseline 2026-04-30) :
       *   lines:      ~73%   functions: ~60%
       *   statements: ~73%   branches:  ~66%
       *
       * Seuils fixés légèrement sous le baseline pour prévenir les régressions
       * sans bloquer les PRs existantes. À augmenter progressivement.
       */
      thresholds: {
        lines:      70,
        statements: 70,
        functions:  58,
        branches:   62,
      },
    },
  },
});
