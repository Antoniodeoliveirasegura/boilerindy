import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabaseHealth, PROBE_TABLE } from '../src/databaseHealth.mjs'

// GET /api/health/db (2026-11-03): one row id read, shared by every caller for
// 10 s. The fake mimics supabase-js's builder: from().select().limit().abortSignal()
// resolves to { data, error }.
function fakeSupabase(answer) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table }
      calls.push(call)
      return {
        select: () => ({
          limit: () => ({
            abortSignal: (signal) => {
              call.signal = signal
              return typeof answer === 'function' ? answer(signal) : Promise.resolve(answer)
            },
          }),
        }),
      }
    },
  }
}

test('a row id read answers 200 { ok: true }', async () => {
  const supabase = fakeSupabase({ data: [{ id: 'u1' }], error: null })
  const result = await createDatabaseHealth({ supabase })()
  assert.deepEqual(result, { ok: true, status: 200, body: { ok: true } })
  assert.equal(supabase.calls[0].table, PROBE_TABLE)
  assert.ok(supabase.calls[0].signal instanceof AbortSignal)
})

test('a database that cannot be reached answers 503 database_unavailable', async () => {
  const supabase = fakeSupabase({ data: null, error: { message: '<title>supabase.co | 522: Connection timed out</title>' } })
  const result = await createDatabaseHealth({ supabase })()
  assert.equal(result.status, 503)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'database_unavailable')
  assert.equal(result.what, 'Supabase 522 Connection timed out')
})

test('no answer within the timeout is unavailable too', async (t) => {
  // AbortSignal.timeout's timer does not hold the event loop open (the server's
  // listening socket does), so the test holds it while it waits.
  const hold = setTimeout(() => {}, 5_000)
  t.after(() => clearTimeout(hold))
  const supabase = fakeSupabase(
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ data: null, error: { message: 'AbortError: This operation was aborted', details: '', hint: '', code: '20' } }))
      }),
  )
  const result = await createDatabaseHealth({ supabase, timeoutMs: 20 })()
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'database_unavailable')
  assert.equal(result.what, 'no answer in 20 ms')
})

test('any other database error answers 503 database_error, without its message', async () => {
  const supabase = fakeSupabase({ data: null, error: { code: '42501', message: 'permission denied for table users', details: null, hint: null } })
  const result = await createDatabaseHealth({ supabase })()
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'database_error')
  assert.doesNotMatch(JSON.stringify(result.body), /permission denied/)
})

test('a probe that throws is an answer, not a rejection', async () => {
  const supabase = {
    from() {
      throw new Error('client misconfigured')
    },
  }
  const result = await createDatabaseHealth({ supabase })()
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'database_error')
})

test('one probe serves every caller for the ttl, and callers in flight share it', async () => {
  let clock = 0
  let release
  const supabase = fakeSupabase(() => new Promise((resolve) => (release = () => resolve({ data: [], error: null }))))
  const check = createDatabaseHealth({ supabase, ttlMs: 10_000, now: () => clock })
  const first = check()
  const second = check()
  release()
  assert.deepEqual(await first, await second)
  assert.equal(supabase.calls.length, 1)
  clock = 9_000
  await check()
  assert.equal(supabase.calls.length, 1)
  clock = 10_000
  const third = check()
  release()
  await third
  assert.equal(supabase.calls.length, 2)
})
