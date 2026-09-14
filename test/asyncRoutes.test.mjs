import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { wrapAsync, wrapAsyncRoutes } from '../src/asyncRoutes.mjs'

// Issue #197: a handler that throws after an await must answer the generic 500
// within the request instead of hanging it (and, without Sentry, killing the
// process). Runs a real Express app on an ephemeral port.

function buildApp() {
  const app = express()
  const seen = []
  const asyncGate = async (req, _res, next) => {
    await new Promise((r) => setTimeout(r, 1))
    if (req.query.gate === 'fail') throw new Error('gate exploded')
    next()
  }
  app.get('/ok', async (_req, res) => {
    await new Promise((r) => setTimeout(r, 1))
    res.json({ ok: true })
  })
  app.get('/boom', asyncGate, async () => {
    await new Promise((r) => setTimeout(r, 1))
    throw new Error('after await')
  })
  app.get('/sync-boom', () => {
    throw new Error('sync throw')
  })
  app.get('/gated', asyncGate, (_req, res) => res.json({ passed: true }))
  const errorMiddleware = (err, _req, res, _next) => {
    seen.push(err.message)
    res.status(500).json({ error: { message: 'Internal server error.', status: 500 } })
  }
  const wrapped = wrapAsyncRoutes(app)
  app.use(errorMiddleware)
  return { app, seen, wrapped }
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('wrapAsync forwards rejections and sync throws to next, leaves error middleware alone', async () => {
  const errors = []
  const next = (e) => errors.push(e?.message)
  await wrapAsync(async () => { throw new Error('a') })({}, {}, next)
  await new Promise((r) => setImmediate(r))
  wrapAsync(() => { throw new Error('b') })({}, {}, next)
  assert.deepEqual(errors, ['a', 'b'])

  const errorMw = (err, req, res, next) => next(err)
  assert.equal(wrapAsync(errorMw), errorMw, 'four-argument middleware is not wrapped')
  const once = wrapAsync(async () => {})
  assert.equal(wrapAsync(once), once, 'idempotent')
  assert.equal(wrapAsync('not a function'), 'not a function')
})

test('a rejection after an await answers the generic 500 within the request', async () => {
  const { app, seen, wrapped } = buildApp()
  assert.ok(wrapped >= 5, `wrapped ${wrapped} handlers`)
  await withServer(app, async (base) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 3000)
    try {
      const res = await fetch(`${base}/boom`, { signal: ac.signal })
      assert.equal(res.status, 500)
      assert.deepEqual(await res.json(), { error: { message: 'Internal server error.', status: 500 } })
    } finally {
      clearTimeout(timer)
    }
    assert.deepEqual(seen, ['after await'])

    // The process is still serving normally afterwards.
    const ok = await fetch(`${base}/ok`)
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { ok: true })
  })
})

test('async route-level middleware (the requireAuth shape) is covered too, and sync throws still work', async () => {
  const { app, seen } = buildApp()
  await withServer(app, async (base) => {
    const gated = await fetch(`${base}/gated?gate=fail`)
    assert.equal(gated.status, 500)
    const passed = await fetch(`${base}/gated`)
    assert.deepEqual(await passed.json(), { passed: true })
    const sync = await fetch(`${base}/sync-boom`)
    assert.equal(sync.status, 500)
    assert.deepEqual(seen, ['gate exploded', 'sync throw'])
  })
})

test('wrapAsyncRoutes is idempotent and tolerates an app with no router', () => {
  const app = express()
  app.get('/a', async () => {})
  assert.equal(wrapAsyncRoutes(app), 1)
  assert.equal(wrapAsyncRoutes(app), 0)
  assert.equal(wrapAsyncRoutes({}), 0)
})
