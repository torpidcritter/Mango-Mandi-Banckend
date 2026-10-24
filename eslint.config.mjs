// A small lint (TST-3): the rules of hooks, and unused variables. Types and
// everything else are tsc's job (npm run typecheck).
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

// ARC-02: the API is plain JavaScript on Node, so tsc checks nothing there.
// The lint catches undefined names, unused code, async functions with no
// await, and promise misuse (the built-in rules closest to a floating-promise
// check; there is no promise plugin here). Node's globals are listed by hand.
const nodeGlobals = Object.fromEntries(
  [
    'AbortController', 'AbortSignal', 'Blob', 'Buffer', 'FormData', 'Headers', 'Request', 'Response', 'TextDecoder',
    'TextEncoder', 'URL', 'URLSearchParams', 'clearImmediate', 'clearInterval', 'clearTimeout', 'console', 'crypto',
    'fetch', 'performance', 'process', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout', 'structuredClone',
  ].map((name) => [name, 'readonly']),
)

export default [
  // .claude/ holds agents' worktree copies of this repo.
  { ignores: ['**/node_modules/**', 'dist/**', 'playwright-report*/**', 'test-results*/**', '.claude/**'] },
  {
    files: ['src/**/*.{ts,tsx}', 'customer-app/src/**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { 'react-hooks': reactHooks, '@typescript-eslint': tsPlugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // The TypeScript version: the core rule counts parameter names in function types as unused.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, caughtErrors: 'none' }],
    },
  },
  {
    files: ['mango-api/**/*.{js,mjs}'],
    ignores: ['mango-api/ops/load/**'], // k6 scripts, below
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { ignoreRestSiblings: true, caughtErrors: 'none' }],
      'require-await': 'error',
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-self-assign': 'error',
      'no-unsafe-finally': 'error',
    },
  },
  {
    // Test stubs stand in for async providers (async with nothing to await), and
    // `new Promise((r) => setTimeout(r, ms))` is the tests' sleep.
    files: ['mango-api/test/**/*.js'],
    rules: { 'require-await': 'off', 'no-promise-executor-return': 'off' },
  },
  {
    files: ['mango-api/ops/load/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...nodeGlobals, __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
  },
]
