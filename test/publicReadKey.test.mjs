import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SESSION_COOKIE_NAME, publicReadBucketKey, readCookie } from '../src/publicReadKey.mjs'

// Issue #250: the public reads run before the session middleware so their
// responses never set a cookie and the Vercel edge can cache them. Their rate
// limiter keys on a hash of the session cookie instead of req.session.

const req = (cookie) => ({ headers: cookie === undefined ? {} : { cookie } })
const RAW = 's%3AabcDEF123.signature-part'

test('readCookie finds a cookie by exact name among others', () => {
  assert.equal(readCookie(`theme=dark; ${SESSION_COOKIE_NAME}=${RAW}; other=1`, SESSION_COOKIE_NAME), RAW)
  assert.equal(readCookie(`${SESSION_COOKIE_NAME}=${RAW}`, SESSION_COOKIE_NAME), RAW)
  assert.equal(readCookie(`x${SESSION_COOKIE_NAME}=${RAW}`, SESSION_COOKIE_NAME), null)
  assert.equal(readCookie(`${SESSION_COOKIE_NAME}=`, SESSION_COOKIE_NAME), null)
  assert.equal(readCookie('', SESSION_COOKIE_NAME), null)
  assert.equal(readCookie(undefined, SESSION_COOKIE_NAME), null)
})

test('no session cookie means no key, so the limiter falls back to the IP', () => {
  assert.equal(publicReadBucketKey(req()), null)
  assert.equal(publicReadBucketKey(req('theme=dark')), null)
  assert.equal(publicReadBucketKey({}), null)
  assert.equal(publicReadBucketKey(undefined), null)
})

test('a session cookie yields a stable sid: key with a 16 hex character hash prefix', () => {
  const key = publicReadBucketKey(req(`${SESSION_COOKIE_NAME}=${RAW}`))
  assert.match(key, /^sid:[0-9a-f]{16}$/)
  assert.equal(publicReadBucketKey(req(`a=b; ${SESSION_COOKIE_NAME}=${RAW}`)), key)
})

test('different cookies land in different buckets and the raw value never leaks into the key', () => {
  const a = publicReadBucketKey(req(`${SESSION_COOKIE_NAME}=${RAW}`))
  const b = publicReadBucketKey(req(`${SESSION_COOKIE_NAME}=${RAW}x`))
  assert.notEqual(a, b)
  assert.ok(!a.includes('abcDEF123'))
  assert.ok(!a.includes('signature'))
})

// server.mjs starts listening on import, so the ordering it must keep is
// checked as text, the way test/rateLimitDocs.test.mjs reads it, across
// server.mjs and the feature routers under src/routes/ (issue #191).
const server = readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8')
const routesDir = new URL('../src/routes/', import.meta.url)
const routers = readdirSync(fileURLToPath(routesDir))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => ({ file: `src/routes/${name}`, source: readFileSync(new URL(name, routesDir), 'utf8') }))
const PUBLIC_READS = [
  '/api/transit/vehicles',
  '/api/transit/stops',
  '/api/transit/routes',
  '/api/parking/garages',
  '/api/clubs',
  '/api/push/config',
  '/api/dining',
]

test('the session middleware uses the exported cookie name', () => {
  assert.match(server, /session\(\{\n\s+name: SESSION_COOKIE_NAME,/)
  assert.ok(!server.includes(`'${SESSION_COOKIE_NAME}'`), 'server.mjs spells the cookie name through the constant')
})

// Where a public read is registered: an app.get line in server.mjs, or a
// router.get line inside a router factory, in which case what has to come
// before the session middleware is the line in server.mjs that mounts it.
function publicReadRegistrations(path) {
  const found = []
  for (let at = server.indexOf(`app.get('${path}',`); at >= 0; at = server.indexOf(`app.get('${path}',`, at + 1)) {
    found.push({ where: 'server.mjs', at })
  }
  for (const { file, source } of routers) {
    for (let at = source.indexOf(`router.get('${path}',`); at >= 0; at = source.indexOf(`router.get('${path}',`, at + 1)) {
      const factory = [...source.slice(0, at).matchAll(/export function (create\w+Router)\(/g)].pop()?.[1]
      found.push({ where: `${file} ${factory}`, factory, at: server.indexOf(`app.use(${factory}(`) })
    }
  }
  return found
}

test('every public read is registered before the session middleware', () => {
  const sessionAt = server.indexOf('app.use(\n  session({')
  assert.ok(sessionAt > 0, 'session middleware not found')
  for (const path of PUBLIC_READS) {
    const found = publicReadRegistrations(path)
    assert.equal(found.length, 1, `${path} is registered ${found.length} times (${found.map((f) => f.where).join(', ')})`)
    const [{ where, factory, at }] = found
    if (factory) {
      assert.ok(at > 0, `${where} is never mounted with app.use(${factory}(...))`)
      assert.equal(server.indexOf(`app.use(${factory}(`, at + 1), -1, `${factory} is mounted twice`)
    }
    assert.ok(at < sessionAt, `${path} (${where}) is registered after the session middleware, so its responses would set the cookie`)
  }
})

// A handler's source, from server.mjs or a router, up to its closing brace at
// the indentation it was declared with.
function handlerSource(name) {
  for (const source of [server, ...routers.map((r) => r.source)]) {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) continue
    const indent = source.slice(source.lastIndexOf('\n', start) + 1, start).match(/^\s*/)[0]
    return source.slice(start, source.indexOf(`\n${indent}}\n`, start))
  }
  return null
}

test('every public read answers with the cache header the edge needs', () => {
  const expected = {
    handleTransitVehicles: "'public, max-age=10, s-maxage=10, stale-while-revalidate=20'",
    handleTransitStops: "'public, max-age=60, s-maxage=600, stale-while-revalidate=600'",
    handleTransitRoutes: "'public, max-age=60, s-maxage=600, stale-while-revalidate=600'",
    handleParkingGarages: "'public, max-age=15, s-maxage=30'",
    handleClubs: "'public, max-age=300'",
    handlePushConfig: "'no-store'",
    handleDining: "'public, max-age=120, s-maxage=300'",
  }
  for (const [handler, header] of Object.entries(expected)) {
    const body = handlerSource(handler)
    assert.ok(body, `${handler} not found`)
    assert.ok(body.includes(`res.set('Cache-Control', ${header})`), `${handler} does not set Cache-Control ${header}`)
  }
})

test('a dining outage answer and a forced refresh are never stored', () => {
  const body = handlerSource('handleDining')
  assert.ok(body, 'handleDining not found')
  assert.ok(
    body.includes("if (data.ok && !forceRefresh) res.set('Cache-Control', 'public, max-age=120, s-maxage=300')"),
    'the public header is not limited to a good, unforced snapshot',
  )
  assert.ok(body.includes("else res.set('Cache-Control', 'no-store')"), 'the outage and forced-refresh answers are not marked no-store')
})
