import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Issue #185. The Node version used to live in four places that disagreed
// (.nvmrc said 20, README and CI said 22, no engines field). Now each pnpm root
// has a .nvmrc with the exact version nvm and CI use, and a package.json
// engines.node with the supported range; this test keeps the pairs identical.
//
// Vercel ignores .nvmrc and builds with the newest Node major that
// boilerindy-react/package.json engines.node allows, overriding the project
// setting. An open range such as ">=22" would therefore move the production
// build to every new major as Vercel ships it, so each clause must be a caret
// range with an upper bound. See README "Production deployment".

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')

const nvmrc = read('.nvmrc').trim()
const frontendNvmrc = read('boilerindy-react/.nvmrc').trim()
const engines = JSON.parse(read('package.json')).engines?.node
const frontendEngines = JSON.parse(read('boilerindy-react/package.json')).engines?.node

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text)
  return m ? m.slice(1).map(Number) : null
}

// Only "^X.Y.Z || ^X.Y.Z" is accepted: anything else fails here on purpose so
// a new range style gets a deliberate look at what Vercel will do with it.
function parseCaretRange(range) {
  return range.split('||').map((clause) => {
    const m = /^\^(\d+\.\d+\.\d+)$/.exec(clause.trim())
    return m ? parseVersion(m[1]) : null
  })
}

function satisfiesCaret([major, minor, patch], [floorMajor, floorMinor, floorPatch]) {
  if (major !== floorMajor) return false
  if (minor !== floorMinor) return minor > floorMinor
  return patch >= floorPatch
}

test('both .nvmrc files pin the same exact version', () => {
  assert.ok(parseVersion(nvmrc), `.nvmrc must hold an exact X.Y.Z version, found "${nvmrc}"`)
  assert.equal(frontendNvmrc, nvmrc, 'boilerindy-react/.nvmrc and the root .nvmrc disagree')
})

test('both package.json files declare the same engines.node range', () => {
  assert.equal(typeof engines, 'string', 'package.json is missing engines.node')
  assert.equal(frontendEngines, engines, 'boilerindy-react/package.json engines.node differs from the root')
})

test('every engines.node clause is a caret range, so Vercel cannot drift to a new major', () => {
  const clauses = parseCaretRange(engines)
  assert.ok(
    clauses.every(Boolean),
    `engines.node "${engines}" must be "^X.Y.Z" clauses joined by "||"; an open range moves the Vercel build to each new Node major`,
  )
})

test('the pinned .nvmrc version satisfies engines.node', () => {
  const version = parseVersion(nvmrc)
  const clauses = parseCaretRange(engines).filter(Boolean)
  assert.ok(
    clauses.some((floor) => satisfiesCaret(version, floor)),
    `.nvmrc ${nvmrc} is outside engines.node "${engines}"`,
  )
})

test('the caret matcher follows semver for the ranges used here', () => {
  const range = parseCaretRange('^22.22.2 || ^24.15.0')
  const ok = (v) => range.some((floor) => satisfiesCaret(parseVersion(v), floor))
  assert.equal(ok('22.22.2'), true)
  assert.equal(ok('22.23.0'), true)
  assert.equal(ok('24.15.0'), true)
  assert.equal(ok('22.22.1'), false)
  assert.equal(ok('22.9.9'), false)
  assert.equal(ok('24.14.9'), false)
  assert.equal(ok('26.0.0'), false)
  assert.deepEqual(parseCaretRange('>=22 || ^24.15.0'), [null, [24, 15, 0]])
})

test('every setup-node step in CI reads the root .nvmrc', () => {
  const ci = read('.github/workflows/ci.yml')
  const setupSteps = ci.match(/uses: actions\/setup-node@/g) ?? []
  const fromFile = ci.match(/^\s+node-version-file: \.nvmrc\s*$/gm) ?? []
  assert.ok(setupSteps.length > 0, 'no actions/setup-node step found in ci.yml - the pattern or the path is wrong')
  assert.equal(fromFile.length, setupSteps.length, 'a setup-node step in ci.yml does not use node-version-file: .nvmrc')
  assert.doesNotMatch(ci, /^\s+node-version:/m, 'ci.yml hardcodes node-version; read it from .nvmrc instead')
})
