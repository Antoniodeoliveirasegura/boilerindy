import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// A fresh deploy discovers its configuration from .env.example. Seven variables
// that change behaviour were readable only by grepping server.mjs (issue #210),
// including TRUST_PROXY and the CAS endpoints. This walks the code for
// process.env reads and fails when one of them is not in the example file.

const root = fileURLToPath(new URL('../', import.meta.url))

function sourceFiles() {
  const files = [path.join(root, 'server.mjs')]
  for (const dir of ['src', 'scripts']) {
    const walk = (current) => {
      for (const entry of readdirSync(current)) {
        const full = path.join(current, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (full.endsWith('.mjs')) files.push(full)
      }
    }
    walk(path.join(root, dir))
  }
  return files
}

// RATE_LIMIT_<NAME>_MAX / _WINDOW_MS are built from a limiter's name at runtime,
// so they are documented as a pattern in docs/RATE_LIMITS.md rather than one
// line per bucket. Everything else is a literal name and must be listed.
const isPattern = (name) => name.startsWith('RATE_LIMIT_')

// scripts/check-conventions.mjs runs in the CI "conventions" job and reads what
// GitHub Actions sets (GITHUB_*) plus two values ci.yml hands it from the event
// payload. None of that is deploy configuration, so it stays out of .env.example.
const isCiOnly = (name, file) =>
  file === 'scripts/check-conventions.mjs' && (name.startsWith('GITHUB_') || name === 'EVENT_BEFORE' || name === 'PR_BODY')

function readEnvNames() {
  const used = new Map()
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8')
    const where = path.relative(root, file).split(path.sep).join('/')
    for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const name = match[1]
      if (isPattern(name) || isCiOnly(name, where)) continue
      if (!used.has(name)) used.set(name, [])
      if (!used.get(name).includes(where)) used.get(name).push(where)
    }
  }
  return used
}

// Commented-out entries count: the file uses `# NAME=` for optional variables.
function documentedNames() {
  const text = readFileSync(path.join(root, '.env.example'), 'utf8')
  return new Set([...text.matchAll(/^\s*#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]))
}

test('every environment variable the code reads is in .env.example', () => {
  const documented = documentedNames()
  const missing = [...readEnvNames()]
    .filter(([name]) => !documented.has(name))
    .map(([name, files]) => `${name} (read in ${files.join(', ')})`)
  assert.deepEqual(missing, [], `add these to .env.example:\n${missing.join('\n')}`)
})

test('the variables this issue was about are documented, not just present somewhere', () => {
  const documented = documentedNames()
  for (const name of [
    'TRUST_PROXY',
    'BACKEND_PUBLIC_URL',
    'PURDUE_CAS_LOGIN_URL',
    'PURDUE_CAS_VALIDATE_URL',
    'BOARD_BLOCKED_WORDS',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    'PLAYWRIGHT_BROWSERS_PATH',
    'NODE_ENV',
  ]) {
    assert.ok(documented.has(name), `${name} is missing from .env.example`)
  }
})

test('the deprecated fallbacks are marked as deprecated, not offered as options', () => {
  const text = readFileSync(path.join(root, '.env.example'), 'utf8')
  const deprecated = text.slice(text.indexOf('# ── Deprecated'))
  assert.ok(deprecated.length > 0, '.env.example should have a Deprecated section')
  for (const name of ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'XAI_API_KEY']) {
    assert.ok(deprecated.includes(`${name}=`), `${name} should sit under the Deprecated heading`)
  }
})

test('the guard would notice a new variable', () => {
  // Without this, the check above passes forever by listing nothing.
  const documented = documentedNames()
  assert.ok(!documented.has('A_VARIABLE_NOBODY_DOCUMENTED'), 'fixture name should not be in the file')
  assert.ok(documented.has('SUPABASE_URL'), 'a real variable should be found by the same parser')
})
