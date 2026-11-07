import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { format } from 'node:util'
import express from 'express'
import { createCrossSiteWriteGuard } from '../src/crossSiteWrites.mjs'

// The guard in front of every route (src/crossSiteWrites.mjs): a browser's
// write from another site gets 403, while same-origin pages, the native app,
// cron jobs and other callers without browser headers pass.

const CLIENT = 'https://www.example.test'
const BACKEND = 'https://api.example.test/'

async function withGuard(run) {
  const app = express()
  app.use(createCrossSiteWriteGuard({ trustedOrigins: [`${CLIENT}/settings`, BACKEND] }))
  app.all('/api/thing', (_req, res) => res.json({ ok: true }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(format(...args))
  try {
    await run(async (method, headers = {}) => {
      const res = await fetch(`${base}/api/thing`, { method, headers })
      return { status: res.status, body: await res.json() }
    }, { base, warnings })
  } finally {
    console.warn = warn
    await new Promise((resolve) => server.close(resolve))
  }
}

const REFUSED = { error: { message: 'Cross-site request refused.', status: 403, code: 'cross_site_request' } }

test('writes from another site are refused, whatever the method', async () => {
  await withGuard(async (send, { warnings }) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const site of ['cross-site', 'same-site', 'Cross-Site']) {
        const res = await send(method, { 'Sec-Fetch-Site': site, Origin: 'https://other.example' })
        assert.equal(res.status, 403, `${method} ${site}`)
        assert.deepEqual(res.body, REFUSED)
      }
    }
    assert.equal(warnings.length, 12)
    assert.match(warnings[0], /^\[cross-site\] refused POST \/api\/thing \(sec-fetch-site=cross-site, origin=https:\/\/other\.example\)$/)
  })
})

test('Sec-Fetch-Site decides when it is sent, even against a trusted Origin', async () => {
  await withGuard(async (send) => {
    assert.equal((await send('POST', { 'Sec-Fetch-Site': 'same-origin' })).status, 200)
    assert.equal((await send('POST', { 'Sec-Fetch-Site': 'none' })).status, 200)
    assert.equal((await send('POST', { 'Sec-Fetch-Site': 'cross-site', Origin: CLIENT })).status, 403)
  })
})

test('without Sec-Fetch-Site, Origin decides', async (t) => {
  await withGuard(async (send, { base }) => {
    await t.test('a trusted origin passes, whatever path its setting had', async () => {
      assert.equal((await send('POST', { Origin: CLIENT })).status, 200)
      assert.equal((await send('POST', { Origin: 'https://api.example.test' })).status, 200)
    })
    await t.test('the request\'s own host passes', async () => {
      assert.equal((await send('POST', { Origin: base })).status, 200)
    })
    await t.test('any other origin, an opaque one or a malformed one is refused', async () => {
      for (const origin of ['https://other.example', 'http://www.example.test', 'null', 'not a url', 'file://x']) {
        const res = await send('POST', { Origin: origin })
        assert.equal(res.status, 403, origin)
      }
    })
  })
})

test('requests with no browser headers pass, as from the app, cron jobs and tests', async () => {
  await withGuard(async (send, { warnings }) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await send(method)).status, 200, method)
    }
    assert.deepEqual(warnings, [])
  })
})

test('reads pass even from another site', async () => {
  await withGuard(async (send) => {
    for (const method of ['GET', 'OPTIONS']) {
      assert.equal((await send(method, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://other.example' })).status, 200, method)
    }
  })
})

test('server.mjs mounts the guard ahead of the JSON parser and parses no form bodies', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const guard = source.indexOf('app.use(createCrossSiteWriteGuard(')
  const json = source.indexOf('app.use(express.json())')
  assert.ok(guard > 0, 'the guard is mounted')
  assert.ok(json > guard, 'before the JSON parser and so before every route')
  assert.equal(source.includes('express.urlencoded('), false)
})
