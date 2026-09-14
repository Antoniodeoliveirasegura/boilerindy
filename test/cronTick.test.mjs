// Transient-failure handling for the cron routes (issue #242): what counts as
// transient, how a failed PostgREST result becomes an Error that keeps its
// status, and the run / retry / report loop, all without a network or a timer.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RETRY_DELAY_MS, SupabaseQueryError, describeFailure, isTransientFailure, queryError, runCronTick } from '../src/cronTick.mjs'
import { UpstreamError } from '../src/upstreamFetch.mjs'

function fakeLog() {
  const lines = { log: [], warn: [], error: [] }
  return {
    lines,
    log: (...args) => lines.log.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
  }
}

const gateway504 = () => queryError({ data: null, error: { message: 'Gateway Timeout' }, status: 504 }, 'push_settings select')

test('queryError keeps the HTTP status and code of a failed PostgREST result', () => {
  const err = gateway504()
  assert.ok(err instanceof SupabaseQueryError)
  assert.ok(err instanceof Error)
  assert.equal(err.message, 'push_settings select: Gateway Timeout (HTTP 504)')
  assert.equal(err.status, 504)
  assert.equal(err.code, null)

  const pg = queryError(
    { error: { code: '23505', message: 'duplicate key value violates unique constraint', details: 'Key (user_id, item_key) already exists.' }, status: 409 },
    'push_deliveries insert',
  )
  assert.equal(pg.code, '23505')
  assert.equal(pg.status, 409)
  assert.equal(pg.details, 'Key (user_id, item_key) already exists.')

  // A fetch failure: supabase-js reports status 0 and a "TypeError: ..." message.
  const net = queryError({ error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }, 'linked_sources select')
  assert.equal(net.message, 'linked_sources select: TypeError: fetch failed')
  assert.equal(net.status, 0)
  assert.equal(net.code, null)

  assert.equal(queryError({ error: null }, 'q').message, 'q: unknown error')
})

test('isTransientFailure: gateway statuses, pool and connection codes, timeouts; not query or data errors', () => {
  assert.equal(isTransientFailure(gateway504()), true)
  assert.equal(isTransientFailure(queryError({ error: { message: 'Bad Gateway' }, status: 502 }, 'q')), true)
  assert.equal(isTransientFailure(queryError({ error: { message: 'Too Many Requests' }, status: 429 }, 'q')), true)
  assert.equal(isTransientFailure(queryError({ error: { code: 'PGRST003', message: 'Timed out acquiring connection from connection pool' }, status: 504 }, 'q')), true)
  assert.equal(isTransientFailure(queryError({ error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 }, 'q')), true)
  assert.equal(isTransientFailure(queryError({ error: { code: '53300', message: 'too many connections' }, status: 500 }, 'q')), true)
  assert.equal(isTransientFailure(queryError({ error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }, 'q')), true)
  // The bare object supabase-js hands back, thrown as-is by an older code path.
  assert.equal(isTransientFailure({ message: 'Gateway Timeout' }), true)
  assert.equal(isTransientFailure(new UpstreamError('TransLoc', 'timeout')), true)
  assert.equal(isTransientFailure(new UpstreamError('TransLoc', 'network', { cause: new Error('fetch failed') })), true)
  assert.equal(isTransientFailure(new UpstreamError('Resend', 'status', { status: 503 })), true)
  assert.equal(isTransientFailure(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), true)
  assert.equal(isTransientFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), true)
  assert.equal(isTransientFailure(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })), true)

  assert.equal(isTransientFailure(queryError({ error: { code: '23505', message: 'duplicate key' }, status: 409 }, 'q')), false)
  assert.equal(isTransientFailure(queryError({ error: { code: 'PGRST205', message: "Could not find the table 'public.push_settings' in the schema cache" }, status: 404 }, 'q')), false)
  assert.equal(isTransientFailure(queryError({ error: { code: '22P02', message: 'invalid input syntax for type uuid' }, status: 400 }, 'q')), false)
  assert.equal(isTransientFailure(queryError({ error: { code: '42501', message: 'permission denied for table push_settings' }, status: 401 }, 'q')), false)
  assert.equal(isTransientFailure(queryError({ error: { message: 'Internal Server Error' }, status: 500 }, 'q')), false)
  assert.equal(isTransientFailure(new UpstreamError('Resend', 'status', { status: 422 })), false)
  assert.equal(isTransientFailure(new TypeError("Cannot read properties of undefined (reading 'id')")), false)
  assert.equal(isTransientFailure(new Error('Calendar access denied. The feed URL may have expired')), false)
  assert.equal(isTransientFailure(null), false)
  assert.equal(isTransientFailure(undefined), false)
})

test('describeFailure gives a short, stable label for grouping', () => {
  assert.equal(describeFailure(gateway504()), 'Supabase 504')
  assert.equal(describeFailure(queryError({ error: { code: 'PGRST003', message: 'pool' }, status: 504 }, 'q')), 'Supabase 504')
  assert.equal(describeFailure(queryError({ error: { code: '57014', message: 'statement timeout' }, status: 500 }, 'q')), 'Supabase 500')
  assert.equal(describeFailure(queryError({ error: { code: '08006', message: 'connection failure' } }, 'q')), 'Supabase 08006')
  assert.equal(describeFailure(queryError({ error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }, 'q')), 'Supabase unreachable')
  assert.equal(describeFailure(new UpstreamError('TransLoc', 'timeout')), 'TransLoc timeout')
  assert.equal(describeFailure(new UpstreamError('Resend', 'status', { status: 503 })), 'Resend 503')
  assert.equal(describeFailure(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timeout')
  assert.equal(describeFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), 'Error ECONNREFUSED')
  assert.equal(describeFailure(new TypeError('boom')), 'TypeError')
  assert.equal(describeFailure(null), 'unknown failure')
})

test('runCronTick retries a transient failure once, after the delay, and reports the retry', async () => {
  let calls = 0
  const sleeps = []
  const log = fakeLog()
  const tick = async () => {
    calls += 1
    if (calls === 1) throw gateway504()
    return { ok: true, sent: 2 }
  }
  const outcome = await runCronTick('run-reminders', tick, { log, sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(outcome, { ok: true, summary: { ok: true, sent: 2 }, retried: true })
  assert.equal(calls, 2)
  assert.equal(RETRY_DELAY_MS, 1500)
  assert.deepEqual(sleeps, [RETRY_DELAY_MS])
  assert.deepEqual(log.lines.warn, [])
  assert.deepEqual(log.lines.error, [])
  assert.equal(log.lines.log.length, 1)
  assert.match(log.lines.log[0], /^\[cron\] run-reminders: Supabase 504 \(push_settings select: Gateway Timeout \(HTTP 504\)\); retrying once in 1500 ms$/)
})

test('runCronTick gives up after a second transient failure and says it was transient', async () => {
  let calls = 0
  const tick = async () => {
    calls += 1
    throw gateway504()
  }
  const outcome = await runCronTick('run-reminders', tick, { log: fakeLog(), sleep: async () => {} })
  assert.equal(calls, 2)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.transient, true)
  assert.equal(outcome.retried, true)
  assert.equal(outcome.error.status, 504)
})

test('runCronTick does not retry a failure that is not transient', async () => {
  let calls = 0
  const sleeps = []
  const log = fakeLog()
  const boom = new TypeError("Cannot read properties of undefined (reading 'id')")
  const tick = async () => {
    calls += 1
    throw boom
  }
  const outcome = await runCronTick('resync', tick, { log, sleep: async (ms) => { sleeps.push(ms) } })
  assert.equal(calls, 1)
  assert.deepEqual(sleeps, [])
  assert.deepEqual(log.lines.log, [])
  assert.deepEqual(outcome, { ok: false, transient: false, error: boom, retried: false })

  // A transient first failure followed by a real one is reported as the real one.
  let n = 0
  const mixed = async () => {
    n += 1
    if (n === 1) throw queryError({ error: { message: 'Bad Gateway' }, status: 502 }, 'linked_sources select')
    throw boom
  }
  const second = await runCronTick('resync', mixed, { log: fakeLog(), sleep: async () => {} })
  assert.equal(n, 2)
  assert.equal(second.ok, false)
  assert.equal(second.transient, false)
  assert.equal(second.retried, true)
  assert.equal(second.error, boom)
})

test('runCronTick passes a successful first attempt straight through', async () => {
  const log = fakeLog()
  const outcome = await runCronTick('resync', async () => ({ ok: true, due: 0 }), {
    log,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.deepEqual(outcome, { ok: true, summary: { ok: true, due: 0 }, retried: false })
  assert.deepEqual(log.lines.log, [])
})

test('runCronTick waits for real with the default sleep', async () => {
  let calls = 0
  const started = Date.now()
  const outcome = await runCronTick(
    'resync',
    async () => {
      calls += 1
      if (calls === 1) throw gateway504()
      return { ok: true }
    },
    { log: fakeLog(), retryDelayMs: 20 },
  )
  assert.equal(outcome.retried, true)
  assert.ok(Date.now() - started >= 15, 'the retry waited for the delay')
})
