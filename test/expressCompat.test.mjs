import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { apiNotFound } from '../src/apiNotFound.mjs'

// Issue #291: the Express 4 to 5 migration. Two behaviours server.mjs depends
// on changed in the major, and neither is visible to the rest of the suite,
// because server.mjs starts listening on import and cannot be imported here,
// and the Playwright suite mocks the backend at the network layer and never
// starts Express at all. So this file boots a small app with the same parser
// chain and the same 404 handler and pins them directly.
//
// It also replaces test/asyncRoutes.test.mjs: Express 5 forwards rejected
// promises to the error middleware natively, so the hand-rolled wrapper that
// did that under Express 4 is gone and what matters now is that the framework
// really does it.

function buildApp() {
  const app = express()
  const seen = []

  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  // The same default server.mjs installs, for the same reason.
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {}
    next()
  })

  // Reads req.body the way the real routes do: destructure first, then answer
  // the route's own 400. Under Express 5 without the default above, the
  // destructure throws and the client gets a 500 instead.
  app.post('/api/sign-in', (req, res) => {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: { message: 'Email and password are required.', status: 400 } })
    }
    res.json({ ok: true, email })
  })

  app.get('/api/boom', async () => {
    await new Promise((r) => setTimeout(r, 1))
    throw new Error('after await')
  })

  app.get('/api/sync-boom', () => {
    throw new Error('sync throw')
  })

  app.use('/api', apiNotFound)

  app.use((err, _req, res, _next) => {
    seen.push(err.message)
    if (res.headersSent) return
    res.status(500).json({ error: { message: 'Internal server error.', status: 500 } })
  })

  return { app, seen }
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

test('a POST with no body and no content-type still gets the route 400, not a 500', async () => {
  const { app, seen } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/sign-in`, { method: 'POST' })
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), {
      error: { message: 'Email and password are required.', status: 400 },
    })
  })
  assert.deepEqual(seen, [], 'nothing reached the error middleware')
})

test('a POST with a content-type no parser claims behaves the same', async () => {
  const { app } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'email=a@b.c',
    })
    assert.equal(res.status, 400)
  })
})

test('a well-formed JSON body still reaches the handler', async () => {
  const { app } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'student@purdue.edu', password: 'x' }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, email: 'student@purdue.edu' })
  })
})

test('a rejection after an await reaches the error middleware with no wrapper', async () => {
  const { app, seen } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/boom`)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), {
      error: { message: 'Internal server error.', status: 500 },
    })
  })
  assert.deepEqual(seen, ['after await'])
})

test('a synchronous throw reaches the error middleware too', async () => {
  const { app, seen } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/sync-boom`)
    assert.equal(res.status, 500)
  })
  assert.deepEqual(seen, ['sync throw'])
})

test('an unknown /api path keeps the JSON 404 shape', async () => {
  const { app } = buildApp()
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/nope`)
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
    assert.deepEqual(await res.json(), { error: { message: 'Not found.', status: 404 } })
  })
})
