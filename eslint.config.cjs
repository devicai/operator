const ts = require('@typescript-eslint/eslint-plugin');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  ...ts.configs['flat/recommended'],
  prettier,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      // The runtime and MCP interfaces intentionally accept dynamic payloads.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
];
