// @ts-check
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  js.configs.recommended,

  // ─── TypeScript source ───────────────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json', './apps/web/tsconfig.json', './packages/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        Alpine: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Interdit les magic-strings kinetic: (forcer STORAGE_KEYS)
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^kinetic:[a-z]/]",
          message: "Utilise STORAGE_KEYS.<KEY> depuis @kinetic/core au lieu d'une string littérale.",
        },
      ],
    },
  },

  // ─── Fichiers de config (pas de projet TS) ───────────────────
  {
    files: ['*.config.{js,mjs,ts}', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // ─── Tests ───────────────────────────────────────────────────
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',       // les tests peuvent accéder aux strings brutes
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ─── Exclusions ──────────────────────────────────────────────
  {
    ignores: [
      'dist/**',
      '**/node_modules/**',
      'apps/web/android/**',
      'apps/web/public/sw.js',
      'packages/adapter-web/src/supabase/database.types.ts',
      'tests/coverage/**',
      'playwright-report/**',
    ],
  },
];
