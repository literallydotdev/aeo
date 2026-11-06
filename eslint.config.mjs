import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import importPlugin from 'eslint-plugin-import';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// The TypeScript here follows the Literally.dev TypeScript style guide: the
// typescript-eslint type-checked preset plus the rules below.
const typeScriptFiles = ['**/*.{ts,mts,cts}'];

// Command-line entry points print to the terminal, and the shared logger is
// the one module that writes to the console.
const consoleModules = ['src/**/cli.ts', 'src/lib/log.ts', 'scripts/**'];

export default defineConfig([
  {
    name: 'style-guide',
    files: typeScriptFiles,
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'eslint-comments': eslintComments,
      'import': importPlugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import/resolver': { node: true, typescript: true },
    },
    rules: {
      ...Object.assign(
        {},
        ...tseslint.configs.recommendedTypeChecked.map(
          (config) => config.rules ?? {},
        ),
      ),
      'import/order': [
        'error',
        {
          'groups': ['builtin', 'external', 'internal', 'parent', 'sibling'],
          'newlines-between': 'never',
        },
      ],
      'import/no-default-export': 'error',
      'import/no-duplicates': 'error',
      'import/no-cycle': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'func-style': ['error', 'expression'],
      '@typescript-eslint/max-params': ['error', { max: 3 }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      'no-param-reassign': [
        'error',
        { props: true, ignorePropertyModificationsFor: ['draft', 'acc'] },
      ],
      'prefer-const': 'error',
      'curly': ['error', 'all'],
      'eqeqeq': 'error',
      'prefer-template': 'error',
      'no-nested-ternary': 'error',
      'no-multiple-empty-lines': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      'preserve-caught-error': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'eslint-comments/no-use': [
        'error',
        { allow: ['eslint-disable-next-line'] },
      ],
      'eslint-comments/require-description': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'camelcase': 'off',
      '@typescript-eslint/no-unused-expressions': 'error',
      // Environment variables are read through src/lib/env.ts.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Read environment variables through readEnv/requireEnv from src/lib/env.ts.',
        },
      ],
    },
  },
  {
    name: 'style-guide/env',
    // The env helper reads the environment, and specs set it up.
    files: ['src/lib/env.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    name: 'style-guide/tests',
    files: ['**/*.spec.ts', '**/__fixtures__/**'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },
  {
    name: 'style-guide/console',
    files: consoleModules,
    rules: {
      'no-console': 'off',
    },
  },
  {
    name: 'style-guide/config-files',
    files: ['*.config.ts'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  globalIgnores([
    'dist/**',
    'resources/**',
    'node_modules/**',
    'audit-run/**',
    // Local scratch space (cloned repositories, experiments): not ours to
    // lint, and large enough to exhaust ESLint's memory.
    '.dev/**',
  ]),
]);
