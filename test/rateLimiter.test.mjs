import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../src/rateLimiter.mjs'

// Minimal Express req/res doubles so we can exercise the middleware directly.
function mockReqRes({ ip = '1.2.3.4', userId } = {}) {
  const req = {
    ip,
    method: 'POST',
    path: '/api/test',
    session: userId ? { userId } : undefined,
  }
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
  return { req, res }
}

/** Run the middleware once; return whether next() was called (i.e. allowed). */
function pass(limiter, ctx) {
  let nextCalled = false
  limiter(ctx.req, ctx.res, () => {
    nextCalled = true
  })
  return nextCalled
}

test('allows requests up to the limit, then blocks with 429', () => {
  const limiter = createRateLimiter({ name: 'test-allow', windowMs: 60_000, max: 3, keyBy: 'ip' })
  const ctx = mockReqRes({ ip: '10.0.0.1' })

  assert.equal(pass(limiter, ctx), true, '1st request allowed')
  assert.equal(pass(limiter, ctx), true, '2nd request allowed')
  assert.equal(pass(limiter, ctx), true, '3rd request allowed')

  assert.equal(pass(limiter, ctx), false, '4th request blocked')
  assert.equal(ctx.res.statusCode, 429)
  assert.equal(ctx.res.body.error.status, 429)
  assert.ok(ctx.res.headers['Retry-After'], 'sends Retry-After header')
  assert.ok(ctx.res.body.error.retryAfterSeconds > 0)
})

test('reports RateLimit-Limit and RateLimit-Remaining headers', () => {
  const limiter = createRateLimiter({ name: 'test-headers', windowMs: 60_000, max: 5, keyBy: 'ip' })
  const ctx = mockReqRes({ ip: '10.0.0.2' })

  pass(limiter, ctx)
  assert.equal(ctx.res.headers['RateLimit-Limit'], '5')
  assert.equal(ctx.res.headers['RateLimit-Remaining'], '4')
})

test('keeps separate buckets per signed-in user', () => {
  const limiter = createRateLimiter({ name: 'test-user', windowMs: 60_000, max: 1 })
  const userA = mockReqRes({ userId: 'user-a' })
  const userB = mockReqRes({ userId: 'user-b' })

  assert.equal(pass(limiter, userA), true, 'user A first request allowed')
  assert.equal(pass(limiter, userA), false, 'user A second request blocked')
  assert.equal(pass(limiter, userB), true, 'user B is an independent bucket')
})

test('falls back to IP bucket when there is no session', () => {
  const limiter = createRateLimiter({ name: 'test-ip-fallback', windowMs: 60_000, max: 1 })
  const ctx = mockReqRes({ ip: '10.0.0.9' })

  assert.equal(pass(limiter, ctx), true)
  assert.equal(pass(limiter, ctx), false, 'same IP blocked after the limit')
})

test('honors the RATE_LIMIT_<NAME>_MAX env override', () => {
  process.env.RATE_LIMIT_TEST_ENV_MAX = '2'
  const limiter = createRateLimiter({ name: 'test-env', windowMs: 60_000, max: 100, keyBy: 'ip' })
  const ctx = mockReqRes({ ip: '10.0.0.10' })

  assert.equal(pass(limiter, ctx), true, '1st allowed')
  assert.equal(pass(limiter, ctx), true, '2nd allowed')
  assert.equal(pass(limiter, ctx), false, '3rd blocked — limit overridden to 2')

  delete process.env.RATE_LIMIT_TEST_ENV_MAX
})
