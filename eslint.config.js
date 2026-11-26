'use strict';

const js = require('@eslint/js');

const nodeGlobals = {
  process: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  structuredClone: 'readonly',
  performance: 'readonly'
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  indexedDB: 'readonly',
  fetch: 'readonly',
  EventSource: 'readonly',
  File: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLSelectElement: 'readonly',
  HTMLImageElement: 'readonly',
  HTMLElement: 'readonly',
  Event: 'readonly',
  MutationObserver: 'readonly',
  CSS: 'readonly',
  Node: 'readonly',
  Notification: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  console: 'readonly',
  AbortController: 'readonly'
};

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', 'coverage/**', 'apps/web/public/assets/**', '**/*.min.js']
  },
  js.configs.recommended,
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals
    }
  },
  {
    files: [
      'apps/server/**/*.js',
      'packages/**/*.js',
      'scripts/**/*.js',
      'test/**/*.js',
      'tests/**/*.js',
      'server.js',
      'engine.js',
      'lib/**/*.js'
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      eqeqeq: ['error', 'smart']
    }
  },
  {
    files: ['apps/web/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: browserGlobals
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      eqeqeq: ['error', 'smart']
    }
  }
];
