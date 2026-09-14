// Flat ESLint config: keep the gate meaningful but not stylistic.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // configUi/vendor holds pinned third-party dist files (SweetAlert2) copied
  // verbatim by scripts/vendor-ui.mjs — never hand-edited, never linted.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'tmp/**', 'src/server/configUi/vendor/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase intentionally uses explicit `unknown` + runtime validation;
      // `any` is a policy violation, not a style choice.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.js'],
    languageOptions: { sourceType: 'module' },
  },
);
