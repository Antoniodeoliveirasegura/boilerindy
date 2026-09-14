import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_RETRY_MS,
  UpstreamError,
  createStaleCache,
  fetchUpstream,
  fetchUpstreamJson,
} from '../src/upstreamFetch.mjs'

// Issue #205: every outbound call gets a deadline and an ok-check, and the
// TTL cache shares in-flight fills and serves the last good value on failure.

const okJson = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) })

test('fetchUpstreamJson returns the parsed body for a 2xx reply and sends a signal', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return okJson({ vehicles: 3 })
  }
  const data = await fetchUpstreamJson('TransLoc', 'https://x/vehicles', { fetchImpl, timeoutMs: 500 })
  assert.deepEqual(data, { vehicles: 3 })
  assert.equal(seen.url, 'https://x/vehicles')
  assert.ok(seen.init.signal instanceof AbortSignal, 'a deadline signal is attached')
})

test('a stalled upstream is abandoned at the deadline with kind timeout', async () => {
  // A fake that never answers but honours the abort signal, like real fetch.
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
  // AbortSignal.timeout's timer is unref'd, and unlike a real fetch this fake
  // holds no socket, so keep the event loop alive until the deadline fires.
  const keepAlive = setTimeout(() => {}, 5000)
  const started = Date.now()
  try {
    await assert.rejects(
      () => fetchUpstream('TransLoc', 'https://x/slow', { fetchImpl, timeoutMs: 30 }),
      (err) => err instanceof UpstreamError && err.kind === 'timeout' && /timed out/.test(err.message),
    )
  } finally {
    clearTimeout(keepAlive)
  }
  assert.ok(Date.now() - started < 2000, 'did not wait for the upstream')
})

test('a connection failure is kind network, a non-2xx is kind status with a trimmed body', async () => {
  await assert.rejects(
    () => fetchUpstream('GoTrue', 'https://x', { fetchImpl: async () => { throw new TypeError('fetch failed') } }),
    (err) => err instanceof UpstreamError && err.kind === 'network' && err.cause instanceof TypeError,
  )
  const html = '<html>' + 'x'.repeat(1000)
  await assert.rejects(
    () => fetchUpstreamJson('TransLoc', 'https://x', { fetchImpl: async () => ({ ok: false, status: 502, text: async () => html, json: async () => ({}) }) }),
    (err) => err instanceof UpstreamError && err.kind === 'status' && err.status === 502 && err.body.length === 300,
  )
})

test('an unparseable 2xx body is reported as a status failure, not a bare parse exception', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') }, text: async () => '<html>' })
  await assert.rejects(
    () => fetchUpstreamJson('TransLoc', 'https://x', { fetchImpl }),
    (err) => err instanceof UpstreamError && err.kind === 'status' && err.body === 'invalid JSON body',
  )
})

test('acceptStatus lets an expected non-2xx (wrong password) through as a Response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }), text: async () => '' })
  const resp = await fetchUpstream('GoTrue', 'https://x', { fetchImpl, acceptStatus: (s) => s === 400 })
  assert.equal(resp.status, 400)
  await assert.rejects(() => fetchUpstream('GoTrue', 'https://x', { fetchImpl, acceptStatus: (s) => s === 401 }))
})

// ── createStaleCache ────────────────────────────────────────────────────────

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, tick: (ms) => { t += ms } }
}

test('concurrent misses share one producer call; hits within the TTL never call it', async () => {
  const c = clock()
  const cache = createStaleCache({ now: c.now, log: { warn() {} } })
  let calls = 0
  const producer = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { n: calls } }

  const [a, b, d] = await Promise.all([cache.get('k', 5000, producer), cache.get('k', 5000, producer), cache.get('k', 5000, producer)])
  assert.equal(calls, 1)
  assert.deepEqual([a, b, d], [{ n: 1 }, { n: 1 }, { n: 1 }])

  c.tick(4000)
  assert.deepEqual(await cache.get('k', 5000, producer), { n: 1 })
  assert.equal(calls, 1)

  c.tick(2000) // past the TTL
  assert.deepEqual(await cache.get('k', 5000, producer), { n: 2 })
  assert.equal(calls, 2)
})

test('a failed refresh serves the last good value and backs off before retrying', async () => {
  const c = clock()
  const warnings = []
  const cache = createStaleCache({ now: c.now, log: { warn: (m) => warnings.push(m) } })
  let fail = false
  let calls = 0
  const producer = async () => { calls += 1; if (fail) throw new UpstreamError('TransLoc', 'timeout'); return { at: calls } }

  assert.deepEqual(await cache.get('v', 5000, producer), { at: 1 })
  c.tick(6000)
  fail = true
  assert.deepEqual(await cache.get('v', 5000, producer), { at: 1 }, 'stale value served')
  assert.equal(calls, 2)
  assert.match(warnings[0], /refresh failed .*serving the last good value/)

  c.tick(1000) // inside the retry grace: no new upstream call
  assert.deepEqual(await cache.get('v', 5000, producer), { at: 1 })
  assert.equal(calls, 2)

  c.tick(STALE_RETRY_MS) // grace over: retried, still failing, still stale
  assert.deepEqual(await cache.get('v', 5000, producer), { at: 1 })
  assert.equal(calls, 3)

  fail = false
  c.tick(STALE_RETRY_MS)
  assert.deepEqual(await cache.get('v', 5000, producer), { at: 4 }, 'fresh value once the upstream recovers')
})

test('a failure with no previous value propagates and the next caller retries', async () => {
  const cache = createStaleCache({ log: { warn() {} } })
  let calls = 0
  const producer = async () => { calls += 1; if (calls === 1) throw new Error('down'); return 'up' }
  await assert.rejects(() => cache.get('p', 1000, producer), /down/)
  assert.equal(cache.peek('p'), undefined)
  assert.equal(await cache.get('p', 1000, producer), 'up')
  assert.equal(calls, 2)
})
