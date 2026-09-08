module.exports = {
  root: true,
  env: {
    es2020: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended'],
  ignorePatterns: ['dist/', 'webview/', 'node_modules/'],
  rules: {
    // The extension intentionally accepts protocol payloads as `any` at the
    // webview/worker boundary. Tighten those contracts incrementally instead
    // of turning on a rule that would bury real lint regressions in legacy noise.
    '@typescript-eslint/no-explicit-any': 'off',
    // These are TypeScript-only symbols/constructs. The core ESLint rules do
    // not understand parameter properties, ambient VS Code types, or declared
    // namespaces; TypeScript performs the relevant semantic checks instead.
    'no-unused-vars': 'off',
    'no-undef': 'off',
    'no-case-declarations': 'off',
    'no-constant-condition': 'off',
    'no-irregular-whitespace': 'off',
    'no-useless-escape': 'off',
  },
};
