import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import * as Sentry from '@sentry/node'
import { clientErrorStatus, createDatabaseOutageHandler, createFinalErrorHandler } from '../src/finalErrorHandler.mjs'
import { UpstreamError } from '../src/upstreamFetch.mjs'

// The final error handler (Sentry BOILERINDY-API-7). server.mjs listens on
// import, so like expressCompat.test.mjs this boots a small app with the same
// parser and the same two error middlewares in the same order: Sentry's real
// Express handler (no DSN, so it captures nothing, but it still decides what it
// would capture and sets res.sentry exactly as in production) and then ours.

function fakeLog() {
  const lines = { warn: [], error: [] }
  return {
    lines,
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
  }
}

function buildApp({ withSentry = true } = {}) {
  const app = express()
  const log = fakeLog()
  app.use(express.json())
  app.post('/api/echo', (req, res) => res.json({ ok: true, keys: Object.keys(req.body) }))
  app.get('/api/boom', () => {
    throw new Error('route threw')
  })
  // An escaped upstream failure whose `status` is the upstream's, not ours.
  app.get('/api/upstream', () => {
    throw new UpstreamError('TransLoc', 'status', { status: 404 })
  })
  if (withSentry) app.use(Sentry.expressErrorHandler())
  app.use(createFinalErrorHandler({ log }))
  return { app, log }
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('an escaped 5xx the Express handler captured is a warning, not a second Sentry event', async () => {
  const { app, log } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/boom`)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: { message: 'Internal server error.', status: 500 } })
  })
  assert.deepEqual(log.lines.warn, ['[unhandled] route threw'])
  assert.deepEqual(log.lines.error, [])
})

test('without Sentry the same error stays a console.error', async () => {
  const { app, log } = buildApp({ withSentry: false })
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/boom`)
    assert.equal(res.status, 500)
  })
  assert.deepEqual(log.lines.error, ['[unhandled] route threw'])
  assert.deepEqual(log.lines.warn, [])
})

test('a malformed JSON body answers 400 and is a warning', async () => {
  const { app, log } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title": ',
    })
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { error: { message: 'Invalid request.', status: 400 } })
  })
  assert.equal(log.lines.warn.length, 1)
  assert.match(log.lines.warn[0], /^\[unhandled\] /)
  assert.deepEqual(log.lines.error, [])
})

test('a body over the 100 kB limit answers 413, not 500, and is a warning', async () => {
  const { app, log } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(200 * 1024) }),
    })
    assert.equal(res.status, 413)
    assert.deepEqual(await res.json(), { error: { message: 'Invalid request.', status: 413 } })
  })
  assert.deepEqual(log.lines.warn, ['[unhandled] request entity too large'])
  assert.deepEqual(log.lines.error, [])
})

test('an escaped error carrying an upstream 4xx status still reaches Sentry through console.error', async () => {
  // The Express handler reads err.status (404 here) and skips it, so this
  // console.error is the only report it gets.
  const { app, log } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/upstream`)
    assert.equal(res.status, 500)
  })
  assert.deepEqual(log.lines.error, ['[unhandled] TransLoc responded 404'])
  assert.deepEqual(log.lines.warn, [])
})

test('a well-formed body never reaches the error handlers', async () => {
  const { app, log } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ok' }),
    })
    assert.equal(res.status, 200)
  })
  assert.deepEqual(log.lines, { warn: [], error: [] })
})

// 2026-11-03: the session store's read failed on every signed-in request while
// the database was down; each one logged [unhandled] with Cloudflare's page and
// filed a Sentry event. The outage handler, ahead of Sentry's, answers first.
function buildOutageApp() {
  const app = express()
  const log = fakeLog()
  const noted = []
  const seen = {}
  app.get('/api/me/calendar/:token', (_req, _res, next) => {
    next({ message: '<!DOCTYPE html>\n<title>supabase.co | 522: Connection timed out</title>\n<body>Error code 522</body>' })
  })
  app.get('/api/boom', () => {
    throw new Error('route threw')
  })
  app.use(createDatabaseOutageHandler({ noteOutage: (_err, where) => noted.push(where) }))
  app.use(Sentry.expressErrorHandler())
  app.use((err, _req, res, next) => {
    seen.passed = true
    seen.sentry = res.sentry
    next(err)
  })
  app.use(createFinalErrorHandler({ log }))
  return { app, log, noted, seen }
}

test('a database outage answers 503 database_unavailable before Sentry, with no [unhandled] line', async () => {
  const { app, log, noted, seen } = buildOutageApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/me/calendar/secret-token`)
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('retry-after'), '30')
    const body = await res.json()
    assert.equal(body.error.code, 'database_unavailable')
    assert.equal(body.error.status, 503)
  })
  assert.deepEqual(log.lines, { warn: [], error: [] })
  assert.equal(seen.passed, undefined, 'Sentry and the final handler never saw it')
  // Method and the first two path segments: never an id or a feed token.
  assert.deepEqual(noted, ['GET /api/me'])
})

test('any other error passes the outage handler and Sentry still captures it', async () => {
  const { app, log, noted, seen } = buildOutageApp()
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/boom`)).status, 500)
  })
  assert.ok(seen.sentry, 'the Express handler should have set res.sentry')
  assert.deepEqual(log.lines.warn, ['[unhandled] route threw'])
  assert.deepEqual(noted, [])
})

test('an outage that reaches the final handler logs its label, not the error page', () => {
  const log = fakeLog()
  const res = { headersSent: true, status: () => res, json: () => res }
  createFinalErrorHandler({ log })({ message: '<!DOCTYPE html>\n<title>supabase.co | 521: Web server is down</title>' }, {}, res, () => {})
  assert.deepEqual(log.lines.error, ['[unhandled] Supabase 521 Web server is down'])
})

test('clientErrorStatus takes only an exposed 4xx', () => {
  assert.equal(clientErrorStatus({ status: 400, expose: true, type: 'entity.parse.failed' }), 400)
  assert.equal(clientErrorStatus({ statusCode: 413, expose: true }), 413)
  assert.equal(clientErrorStatus({ status: 404 }), null) // an upstream's status, not exposed
  assert.equal(clientErrorStatus({ status: 500, expose: false }), null)
  assert.equal(clientErrorStatus(new Error('plain')), null)
  assert.equal(clientErrorStatus(null), null)
})

test('an error after the headers went out is logged and not answered twice', () => {
  const log = fakeLog()
  let answered = false
  const res = {
    headersSent: true,
    status() {
      answered = true
      return this
    },
    json() {
      answered = true
      return this
    },
  }
  createFinalErrorHandler({ log })(new Error('late'), {}, res, () => {})
  assert.equal(answered, false)
  assert.deepEqual(log.lines.error, ['[unhandled] late'])
})
