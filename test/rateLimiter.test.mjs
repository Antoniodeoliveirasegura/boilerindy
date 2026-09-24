import test from 'node:test'
import assert from 'node:assert/strict'
import { bucketKey, createRateLimiter, createRateWindow } from '../src/rateLimiter.mjs'

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
  assert.equal(pass(limiter, ctx), false, '3rd blocked - limit overridden to 2')

  delete process.env.RATE_LIMIT_TEST_ENV_MAX
})

// ── Function-valued keyBy (#215, #217) ───────────────────────────────────────

test('a keyBy function picks the bucket and null falls back to the client IP', () => {
  const byHeader = (req) => (req.headers?.['x-actor'] ? `actor:${req.headers['x-actor']}` : null)
  assert.equal(bucketKey({ ip: '10.0.0.9', headers: { 'x-actor': 'a1' } }, byHeader), 'k:actor:a1')
  assert.equal(bucketKey({ ip: '10.0.0.9', headers: {} }, byHeader), 'ip:10.0.0.9')
  // A throwing key function never breaks the request: IP bucket.
  assert.equal(bucketKey({ ip: '10.0.0.9' }, () => { throw new Error('boom') }), 'ip:10.0.0.9')
  // Built-in strategies are unchanged.
  assert.equal(bucketKey({ ip: '1.1.1.1', session: { userId: 'u9' } }, 'userOrIp'), 'u:u9')
  assert.equal(bucketKey({ ip: '1.1.1.1', session: { userId: 'u9' } }, 'ip'), 'ip:1.1.1.1')
  assert.equal(bucketKey({ ip: '1.1.1.1' }), 'ip:1.1.1.1')
})

test('two actors behind one IP get separate buckets with a keyBy function', () => {
  const limiter = createRateLimiter({ name: 'test-keyfn', windowMs: 60_000, max: 2, keyBy: (req) => req.headers?.['x-actor'] || null })
  const a = mockReqRes({ ip: '10.0.0.7' })
  const b = mockReqRes({ ip: '10.0.0.7' })
  a.req.headers = { 'x-actor': 'alice' }
  b.req.headers = { 'x-actor': 'bob' }
  assert.equal(pass(limiter, a), true)
  assert.equal(pass(limiter, a), true)
  assert.equal(pass(limiter, a), false, 'alice is out of budget')
  assert.equal(pass(limiter, b), true, 'bob still has his own budget behind the same IP')
})

test('a keyBy returning adv:<id> buckets separately from the IP bucket on the same address (#202)', () => {
  const byAdvertiser = (req) => (req.session?.advertiserId ? `adv:${req.session.advertiserId}` : null)
  const limiter = createRateLimiter({ name: 'test-keyfn-adv', windowMs: 60_000, max: 1, keyBy: byAdvertiser })
  const advertiser = mockReqRes({ ip: '10.0.0.8' })
  advertiser.req.session = { advertiserId: 'x' }
  const anonymous = mockReqRes({ ip: '10.0.0.8' })

  assert.equal(bucketKey(advertiser.req, byAdvertiser), 'k:adv:x')
  assert.equal(bucketKey(anonymous.req, byAdvertiser), 'ip:10.0.0.8')

  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(pass(limiter, advertiser), true)
    assert.equal(pass(limiter, advertiser), false, 'adv:x is out of budget')
    assert.equal(pass(limiter, anonymous), true, 'the IP bucket behind the same address is untouched')
    assert.equal(pass(limiter, anonymous), false, 'and runs out on its own count')
  } finally {
    console.warn = warn
  }
})

// ── onLimit (#293) ───────────────────────────────────────────────────────────

test('onLimit answers a blocked request in place of the JSON 429', () => {
  const calls = []
  const limiter = createRateLimiter({
    name: 'test-on-limit',
    windowMs: 60_000,
    max: 1,
    keyBy: 'ip',
    onLimit: (req, res, info) => {
      calls.push({ path: req.path, retryAfterSeconds: info.retryAfterSeconds })
      res.statusCode = 302
    },
  })
  const ctx = mockReqRes({ ip: '10.0.0.30' })

  assert.equal(pass(limiter, ctx), true)
  assert.equal(calls.length, 0, 'not called while under the limit')

  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(pass(limiter, ctx), false, 'still blocked')
  } finally {
    console.warn = warn
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/test')
  assert.ok(calls[0].retryAfterSeconds > 0)
  assert.equal(ctx.res.statusCode, 302, 'the hook chose the response')
  assert.equal(ctx.res.body, undefined, 'no JSON body was written')
  assert.ok(ctx.res.headers['Retry-After'], 'headers are set before the hook runs')
  assert.equal(ctx.res.headers['RateLimit-Remaining'], '0')
})

// Issue #191 - the window without the HTTP layer, for the board auto-tagger.
test('createRateWindow counts hits per key and resets after the window', () => {
  const window = createRateWindow({ name: 'test-window', windowMs: 1000, max: 2 })
  assert.equal(window.limit, 2)
  assert.equal(window.windowMs, 1000)
  const t0 = 1_000_000
  assert.equal(window.hit('a', t0).allowed, true)
  assert.equal(window.hit('a', t0 + 10).allowed, true)
  const third = window.hit('a', t0 + 20)
  assert.equal(third.allowed, false)
  assert.equal(third.count, 3)
  assert.equal(third.resetAt, t0 + 1000)
  // Another key has its own budget; the first key is fresh again after the window.
  assert.equal(window.hit('b', t0 + 20).allowed, true)
  assert.equal(window.hit('a', t0 + 1000).allowed, true)
})

test('createRateWindow honours the RATE_LIMIT_<NAME>_MAX override', () => {
  process.env.RATE_LIMIT_TEST_WINDOW_ENV_MAX = '1'
  try {
    const window = createRateWindow({ name: 'test-window-env', windowMs: 1000, max: 5 })
    assert.equal(window.limit, 1)
    assert.equal(window.hit('a').allowed, true)
    assert.equal(window.hit('a').allowed, false)
  } finally {
    delete process.env.RATE_LIMIT_TEST_WINDOW_ENV_MAX
  }
})

test('a skip predicate lets a request through without touching a bucket or setting headers', () => {
  let metered = false
  const limiter = createRateLimiter({ name: 'skip-test', windowMs: 60_000, max: 1, skip: () => !metered })
  const ctx = mockReqRes()
  assert.equal(pass(limiter, ctx), true)
  assert.equal(pass(limiter, ctx), true)
  assert.equal(ctx.res.headers['RateLimit-Limit'], undefined, 'a skipped request gets no RateLimit headers')
  metered = true
  assert.equal(pass(limiter, ctx), true, 'the skipped requests did not count')
  assert.equal(pass(limiter, ctx), false)
  assert.equal(ctx.res.statusCode, 429)
})
