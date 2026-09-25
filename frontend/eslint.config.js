import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'node_modules', 'src/types/**'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // No dangerouslySetInnerHTML anywhere, ever (CLAUDE.md hard constraint).
      'react/no-danger': 'off', // react plugin not loaded; enforced by the custom rule below instead
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: 'dangerouslySetInnerHTML is forbidden in this codebase (CLAUDE.md hard constraint).',
        },
        {
          selector: 'Property[key.name="dangerouslySetInnerHTML"]',
          message: 'dangerouslySetInnerHTML is forbidden in this codebase (CLAUDE.md hard constraint).',
        },
        {
          selector: 'ImportDeclaration[source.value=/^three($|\\/)/]',
          message: 'three.js is forbidden in v1 (CLAUDE.md / Standing Decisions).',
        },
      ],
    },
  },
  {
    // shadcn/ui primitives are generated multi-export barrels (regenerate, don't hand-edit —
    // frontend-builder SKILL). Fast-refresh's single-export rule does not apply to them.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // TanStack Virtual is the mandated virtualization library (CLAUDE.md: "TanStack
    // Virtual on the Matrix and Gantt, non-negotiable"). `useVirtualizer()` returns
    // an object of methods the React Compiler heuristic flags as un-memoizable — this
    // is a known, benign interaction (no memoized value is derived from it), not a
    // hooks-rules violation. Scoped off only for the virtualized table components.
    files: [
      'src/**/virtual-data-table.tsx',
      'src/**/virtual-matrix-grid.tsx',
      'src/**/*gantt*/**/*.{ts,tsx}',
    ],
    rules: {
      'react-hooks/incompatible-library': 'off',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);
