import test from 'node:test'
import assert from 'node:assert/strict'
import { createPurdueLinkHandoff } from '../src/purdueLinkHandoff.mjs'
import {
  PURDUE_LINK_FLOW_MAX,
  PURDUE_LINK_FLOW_WINDOW_MS,
  THROTTLED_NATIVE_MESSAGE,
  createPurdueLinkFlowRateLimit,
  linkHandoffToken,
  purdueLinkFlowKey,
} from '../src/purdueLinkThrottle.mjs'

// Issue #293: GET /auth/purdue/connect, POST /auth/purdue/dev/link and
// GET /auth/purdue/callback share one limiter, and a blocked caller is
// redirected in its own shape instead of getting a JSON 429.

const SECRET = 'x'.repeat(48)
const USER = '4f2a5c6e-1b2c-4d3e-9f8a-7b6c5d4e3f2a'
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const CLIENT = 'https://app.example.test'

function makeHandoff() {
  let current = Date.UTC(2026, 8, 16, 12, 0, 0)
  const handoff = createPurdueLinkHandoff({ secret: SECRET, now: () => current })
  return { handoff, tick: (ms) => { current += ms } }
}

function mockReqRes({ ip = '10.1.0.1', query = {}, body = {}, userId } = {}) {
  const req = {
    ip,
    method: 'GET',
    path: '/auth/purdue/callback',
    query,
    body,
    session: userId ? { userId } : undefined,
  }
  const res = {
    statusCode: 200,
    headers: {},
    location: undefined,
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
    redirect(url) {
      this.statusCode = 302
      this.location = url
      return this
    },
  }
  return { req, res }
}

/** Run the middleware once; true when the request was let through. */
function pass(limiter, ctx) {
  let nextCalled = false
  limiter(ctx.req, ctx.res, () => {
    nextCalled = true
  })
  return nextCalled
}

// Quiet the limiter's one-per-window console.warn while a test exhausts a bucket.
function quietly(fn) {
  const warn = console.warn
  console.warn = () => {}
  try {
    return fn()
  } finally {
    console.warn = warn
  }
}

test('the budget is 30 attempts per 15 minutes', () => {
  assert.equal(PURDUE_LINK_FLOW_MAX, 30)
  assert.equal(PURDUE_LINK_FLOW_WINDOW_MS, 15 * 60 * 1000)
})

test('linkHandoffToken reads ?t= first, then the form body, and only strings', () => {
  assert.equal(linkHandoffToken({ query: { t: 'q' }, body: { t: 'b' } }), 'q')
  assert.equal(linkHandoffToken({ query: {}, body: { t: 'b' } }), 'b')
  assert.equal(linkHandoffToken({ query: { t: ['a', 'b'] } }), '')
  assert.equal(linkHandoffToken({ query: {} }), '')
  assert.equal(linkHandoffToken({}), '')
})

test('a live handoff token is its own bucket and never appears in the key', () => {
  const { handoff } = makeHandoff()
  const verify = (token) => handoff.verify(token)
  const a = handoff.issue(USER).token
  const b = handoff.issue(USER).token

  const keyA = purdueLinkFlowKey({ query: { t: a } }, verify)
  assert.match(keyA, /^pl:[A-Za-z0-9_-]{16}$/)
  assert.equal(keyA.includes(a.slice(0, 16)), false, 'hashed, not a prefix of the token')
  assert.equal(purdueLinkFlowKey({ query: { t: a } }, verify), keyA, 'stable across steps')
  assert.equal(purdueLinkFlowKey({ query: {}, body: { t: a } }, verify), keyA, 'the mock form posts the token')
  assert.notEqual(purdueLinkFlowKey({ query: { t: b } }, verify), keyA)
})

test('a forged, expired or spent token does not get a bucket of its own', () => {
  const { handoff, tick } = makeHandoff()
  const verify = (token) => handoff.verify(token)

  assert.equal(purdueLinkFlowKey({ query: { t: 'forged.token' } }, verify), null, 'anonymous: IP')
  assert.equal(purdueLinkFlowKey({ query: { t: 'forged.token' }, session: { userId: USER } }, verify), `u:${USER}`)

  const spent = handoff.issue(USER).token
  handoff.consume(spent)
  assert.equal(purdueLinkFlowKey({ query: { t: spent } }, verify), null)

  const expiring = handoff.issue(USER).token
  tick(10 * 60 * 1000)
  assert.equal(purdueLinkFlowKey({ query: { t: expiring } }, verify), null)
})

test('the website flow is keyed by the session user, and nothing else falls back to IP', () => {
  const verify = () => {
    throw new Error('not called without a token')
  }
  assert.equal(purdueLinkFlowKey({ query: {}, session: { userId: USER } }, verify), `u:${USER}`)
  assert.equal(purdueLinkFlowKey({ query: {} }, verify), null)
  assert.equal(purdueLinkFlowKey({ query: {}, session: {} }, verify), null)
})

test('a throttled native request is redirected back to the app with reason rate-limited', () => {
  const { handoff } = makeHandoff()
  const limiter = createPurdueLinkFlowRateLimit({ handoff, clientAppUrl: CLIENT, max: 2 })
  const token = handoff.issue(USER).token

  assert.equal(pass(limiter, mockReqRes({ query: { t: token } })), true)
  assert.equal(pass(limiter, mockReqRes({ query: { t: token, ticket: 'ST-1' } })), true)

  const blocked = mockReqRes({ query: { t: token, ticket: 'ST-2' } })
  assert.equal(quietly(() => pass(limiter, blocked)), false)
  assert.equal(blocked.res.statusCode, 302)
  assert.equal(blocked.res.body, undefined, 'no JSON body')
  const url = new URL(blocked.res.location)
  assert.equal(`${url.protocol}//${url.host}`, 'boilerindyapp://purdue-linked')
  assert.equal(url.searchParams.get('status'), 'error')
  assert.equal(url.searchParams.get('reason'), 'rate-limited')
  assert.equal(url.searchParams.get('message'), THROTTLED_NATIVE_MESSAGE)
  assert.ok(blocked.res.headers['Retry-After'], 'Retry-After is still set')
})

test('a throttled website request is redirected to Settings', () => {
  const { handoff } = makeHandoff()
  const limiter = createPurdueLinkFlowRateLimit({ handoff, clientAppUrl: CLIENT, max: 1 })

  assert.equal(pass(limiter, mockReqRes({ userId: USER })), true)
  const blocked = mockReqRes({ userId: USER, query: { state: 'x', ticket: 'ST-1' } })
  assert.equal(quietly(() => pass(limiter, blocked)), false)
  assert.equal(blocked.res.statusCode, 302)
  assert.equal(blocked.res.location, `${CLIENT}/settings?error=purdue-link-throttled`)
})

test('forged tokens from one address share that address budget', () => {
  const { handoff } = makeHandoff()
  const limiter = createPurdueLinkFlowRateLimit({ handoff, clientAppUrl: CLIENT, max: 3 })
  const ip = '10.9.9.9'

  for (let i = 0; i < 3; i += 1) {
    assert.equal(pass(limiter, mockReqRes({ ip, query: { t: `forged-${i}.sig` } })), true)
  }
  const blocked = mockReqRes({ ip, query: { t: 'forged-new.sig' } })
  assert.equal(quietly(() => pass(limiter, blocked)), false, 'a new forged value does not buy a new budget')
  assert.equal(new URL(blocked.res.location).searchParams.get('reason'), 'rate-limited')
})

test('students behind one campus address keep separate budgets', () => {
  const { handoff } = makeHandoff()
  const limiter = createPurdueLinkFlowRateLimit({ handoff, clientAppUrl: CLIENT, max: 1 })
  const ip = '10.2.2.2'

  assert.equal(pass(limiter, mockReqRes({ ip, query: { t: handoff.issue(USER).token } })), true)
  assert.equal(pass(limiter, mockReqRes({ ip, query: { t: handoff.issue(OTHER).token } })), true, 'another app user')
  assert.equal(pass(limiter, mockReqRes({ ip, userId: USER })), true, 'a website user')
  assert.equal(pass(limiter, mockReqRes({ ip, userId: OTHER })), true, 'another website user')
})
