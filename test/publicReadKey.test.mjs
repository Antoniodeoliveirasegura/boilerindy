import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
// checked as text, the way test/rateLimitDocs.test.mjs reads it.
const server = readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8')
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

test('every public read is registered before the session middleware', () => {
  const sessionAt = server.indexOf('app.use(\n  session({')
  assert.ok(sessionAt > 0, 'session middleware not found')
  for (const path of PUBLIC_READS) {
    const at = server.indexOf(`app.get('${path}',`)
    assert.ok(at > 0, `${path} is not registered with app.get`)
    assert.ok(at < sessionAt, `${path} is registered after the session middleware, so its responses would set the cookie`)
    assert.equal(server.indexOf(`app.get('${path}',`, at + 1), -1, `${path} is registered twice`)
  }
})

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
    const start = server.indexOf(`function ${handler}(`)
    assert.ok(start > 0, `${handler} not found`)
    const end = server.indexOf('\n}\n', start)
    const body = server.slice(start, end)
    assert.ok(body.includes(`res.set('Cache-Control', ${header})`), `${handler} does not set Cache-Control ${header}`)
  }
})
