import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import * as Sentry from '@sentry/node'
import { clientErrorStatus, createFinalErrorHandler } from '../src/finalErrorHandler.mjs'
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
