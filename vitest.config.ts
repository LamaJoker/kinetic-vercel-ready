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
      reporter: ['text', 'json', 'html', 'json-summary'],
      include:  ['packages/*/src/**/*.ts'],
      exclude:  ['**/*.test.ts', '**/index.ts', '**/database.types.ts'],
    },
  },
});
