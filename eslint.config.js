// @ts-check
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
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
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // ─── Discipline d'imports (résolveur Node par défaut) ───
      'import/no-duplicates': 'error',
      'import/no-self-import': 'error',

      // ─── Complexité & taille (warnings non bloquants) ────────
      // Seuil large pour ne pas pénaliser les fonctions OAuth/onboarding
      // existantes (à refactorer dans un PR dédié).
      complexity: ['warn', 35],
      'max-depth': ['warn', 6],
      'max-params': ['warn', 7],

      // ─── Bonnes pratiques ────────────────────────────────────
      eqeqeq: ['error', 'smart'],
      'no-debugger': 'error',
      'no-throw-literal': 'error',
      'prefer-const': 'error',

      // Interdit les magic-strings kinetic: (forcer STORAGE_KEYS)
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^kinetic:[a-z]/]',
          message:
            "Utilise STORAGE_KEYS.<KEY> depuis @kinetic/core au lieu d'une string littérale.",
        },
        {
          selector: 'TemplateLiteral > TemplateElement[value.cooked=/^kinetic:[a-z]/]',
          message:
            "Utilise STORAGE_KEYS.<KEY>(…) depuis @kinetic/core au lieu d'un template littéral.",
        },
      ],
    },
  },

  // ─── Fichiers de config (pas de projet TS) ───────────────────
  {
    files: ['**/*.config.{js,mjs,ts}', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.node,
      parserOptions: { project: false },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ─── Tests ───────────────────────────────────────────────────
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parserOptions: { project: false },
      globals: globals.browser,
    },
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'no-undef': 'off',
      complexity: 'off',
      'max-depth': 'off',
      'max-params': 'off',
      'import/no-duplicates': 'off',
      'import/no-self-import': 'off',
    },
  },

  // ─── Exclusions ──────────────────────────────────────────────
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      '**/node_modules/**',
      'apps/web/android/**',
      'apps/web/public/sw.js',
      'packages/adapter-web/src/supabase/database.types.ts',
      // storage-keys.ts is the definitions file — it must declare the literal strings
      'packages/core/src/constants/storage-keys.ts',
      'tests/coverage/**',
      'playwright-report/**',
    ],
  },
];
