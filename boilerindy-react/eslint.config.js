import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

// React Compiler advisory rules (perf hints, not bug detectors) - kept at
// 'warn' so CI lint blocks on real errors while set-state-in-effect debt is
// burned down screen by screen, with testing.
const reactAdvisoryRules = {
  'react-hooks/set-state-in-effect': 'warn',
  'react-hooks/preserve-manual-memoization': 'warn',
}

const languageOptions = {
  ecmaVersion: 2020,
  globals: globals.browser,
  parserOptions: {
    ecmaVersion: 'latest',
    ecmaFeatures: { jsx: true },
    sourceType: 'module',
  },
}

export default defineConfig([
  globalIgnores(['dist']),
  // The handful of plain JS files left: the config itself, the service worker,
  // theme-init, the icon renderer, vite.config and the vitest setup.
  {
    files: ['**/*.{js,jsx}'],
    extends: [js.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions,
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      ...reactAdvisoryRules,
    },
  },
  // Everything under src/ (issue #183). Until this block existed the lint step
  // matched only .js/.jsx, so no component or hook had been linted since the
  // TypeScript migration finished.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions,
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Type hygiene, not a bug detector: 30 `any`s survive in Home.tsx and
      // Map.tsx (widget payloads and Leaflet event shapes). Reported, not
      // blocking, until those two pages are typed properly.
      '@typescript-eslint/no-explicit-any': 'warn',
      ...reactAdvisoryRules,
    },
  },
])
