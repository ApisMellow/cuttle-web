import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'static/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // eslint-plugin-svelte's recommended config parses `.svelte` files and
    // `.svelte.ts` rune modules (SPEC §5.1, §5.3 — this repo has no
    // `.svelte.js` rune modules, so that extension isn't listed below) with
    // `svelte-eslint-parser` but does not itself delegate the embedded
    // script to a TS-aware parser, so any TypeScript-only syntax
    // (`import type`, generics) fails with a bare "Unexpected token" parse
    // error. Both extensions go through this one block, which sets the
    // TS-aware parser for both at once.
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ['tests/smoke/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
