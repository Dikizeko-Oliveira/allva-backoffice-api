// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import allva from './eslint-rules/index.js';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'eslint-rules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // `_`-prefixed parameters exist to satisfy an interface the implementation
      // does not need every argument of — the convention already says "unused
      // on purpose".
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // P6 — a diferença de plataforma vive no gateway e no `PlatformProfile`,
    // nunca num `if` espalhado pelo domínio (harness de A2-S0, achado D8).
    // Mesmo veredito é cobrado por `test/architecture/platform-conditional.spec.ts`,
    // que roda no gate bloqueante de `pnpm test` — o lint do CI ainda é
    // `continue-on-error`, então esta entrada aqui é a ergonomia (erro no
    // editor), não o gate.
    files: ['src/**/*.ts'],
    ignores: ['**/infrastructure/providers/**', '**/*.spec.ts'],
    plugins: { allva },
    rules: {
      'allva/no-platform-conditional': 'error',
    },
  },
  {
    // Test doubles are `any` by construction: a spec builds
    // `{ findById: jest.fn() }` and casts it to a repository interface rather
    // than implementing every member. The `no-unsafe-*` family then fires on
    // each `mock.calls[0][0]` and every `(service as any).logger`, which is
    // noise, not signal — it was ~60% of the whole lint backlog.
    //
    // Everything that catches real mistakes in a spec stays on: prettier,
    // unused variables, floating promises, require-await.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // A fake implementing an async port has nothing to await; the Promise is
      // the interface's requirement, not the fake's behaviour.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
