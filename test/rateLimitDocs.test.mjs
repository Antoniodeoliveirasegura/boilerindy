import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// docs/RATE_LIMITS.md is the operator's map of what is throttled: anyone tuning
// RATE_LIMIT_* works from it. It had drifted badly (issue #201) - a row for a
// route that never existed, a bucket listing four of its fourteen routes, and
// six limiters missing altogether. These checks read both files as text, because
// server.mjs starts listening on import and cannot be required from a test.

const root = new URL('../', import.meta.url)
const server = readFileSync(fileURLToPath(new URL('server.mjs', root)), 'utf8')
const doc = readFileSync(fileURLToPath(new URL('docs/RATE_LIMITS.md', root)), 'utf8')

// Route params are free to be renamed without touching the doc, so compare
// /api/x/:id and /api/x/:postId as the same route.
const normalize = (route) => route.replace(/:\w+/g, ':p').trim()

// var name -> bucket name, for every createRateLimiter call in server.mjs.
function limiterDefinitions() {
  const found = new Map()
  const re = /const (\w+) = createRateLimiter\(\{/g
  let m
  while ((m = re.exec(server))) {
    const name = /name: '([a-z0-9-]+)'/.exec(server.slice(m.index, m.index + 400))
    assert.ok(name, `createRateLimiter for ${m[1]} has no name`)
    found.set(m[1], name[1])
  }
  return found
}

// bucket name -> every route the server attaches it to.
function routesByLimiter() {
  const defs = limiterDefinitions()
  const byName = new Map([...defs.values()].map((n) => [n, []]))
  const re = /^app\.(get|post|patch|put|delete)\('([^']+)',([^\n]*)$/gm
  let m
  while ((m = re.exec(server))) {
    const [, verb, path, rest] = m
    for (const [variable, name] of defs) {
      if (new RegExp(`\\b${variable}\\b`).test(rest)) {
        byName.get(name).push(`${verb.toUpperCase()} ${path}`)
      }
    }
  }
  return byName
}

// The cell that lists a bucket's endpoints, from its row in the coverage table.
function endpointCell(name) {
  const row = doc.split('\n').find((line) => line.startsWith(`| \`${name}\` |`))
  if (!row) return null
  return row.split('|')[2] || ''
}

test('every rate limiter in server.mjs has a row in the doc', () => {
  const missing = [...new Set(limiterDefinitions().values())].filter((name) => endpointCell(name) === null)
  assert.deepEqual(missing, [], `limiters with no row in docs/RATE_LIMITS.md: ${missing.join(', ')}`)
})

test('every route a limiter guards is listed in that limiter row', () => {
  const problems = []
  for (const [name, routes] of routesByLimiter()) {
    const cell = endpointCell(name)
    if (cell === null) continue
    const listed = new Set([...cell.matchAll(/`((?:GET|POST|PATCH|PUT|DELETE) [^`]+)`/g)].map((m) => normalize(m[1])))
    for (const route of routes) {
      if (!listed.has(normalize(route))) problems.push(`${name} is missing ${route}`)
    }
  }
  assert.deepEqual(problems, [], `docs/RATE_LIMITS.md is behind server.mjs:\n${problems.join('\n')}`)
})

test('every route the doc names is a route the server serves', () => {
  const served = new Set(
    [...server.matchAll(/^app\.(get|post|patch|put|delete)\('([^']+)'/gm)].map((m) =>
      normalize(`${m[1].toUpperCase()} ${m[2]}`),
    ),
  )
  const claimed = [...doc.matchAll(/`((?:GET|POST|PATCH|PUT|DELETE) \/[^`]+)`/g)]
    .map((m) => m[1])
    // `GET /api/...` in the prose is a wildcard, not a claim about one route.
    .filter((route) => !route.includes('...'))
  const ghosts = [...new Set(claimed.filter((route) => !served.has(normalize(route))))]
  assert.deepEqual(ghosts, [], `docs/RATE_LIMITS.md names routes server.mjs does not serve: ${ghosts.join(', ')}`)
})

test('the guard notices a row that goes stale', () => {
  // Deleting board-write's reply route from the cell has to be caught, otherwise
  // the check above is decorative.
  const cell = endpointCell('board-write')
  assert.ok(cell, 'board-write should have a row')
  const withoutOne = cell.replace('`POST /api/board/posts/:id/reply`, ', '')
  const listed = new Set([...withoutOne.matchAll(/`((?:GET|POST|PATCH|PUT|DELETE) [^`]+)`/g)].map((m) => normalize(m[1])))
  assert.ok(!listed.has(normalize('POST /api/board/posts/:id/reply')), 'the fixture did not remove the row')
  assert.ok(
    routesByLimiter().get('board-write').includes('POST /api/board/posts/:id/reply'),
    'server.mjs should still attach board-write to the reply route',
  )
})
