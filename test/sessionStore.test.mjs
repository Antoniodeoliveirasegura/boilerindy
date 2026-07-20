import test from 'node:test'
import assert from 'node:assert/strict'
import { SupabaseSessionStore, createSessionStore, expiryFrom } from '../src/sessionStore.mjs'

// Fake Supabase query builder. Methods chain and the builder itself is a
// thenable, which is how supabase-js behaves: the request fires when awaited.
// `handlers` maps operation kind -> result (or a function of the recorded op),
// and every operation is pushed to `client.calls` so tests can assert on what
// actually reached the database.
function makeClient(handlers = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const op = { table, kind: null, payload: null, filters: {} }
      calls.push(op)
      const builder = {
        select(cols) {
          op.kind = 'select'
          op.cols = cols
          return builder
        },
        upsert(row, opts) {
          op.kind = 'upsert'
          op.payload = row
          op.opts = opts
          return builder
        },
        update(row) {
          op.kind = 'update'
          op.payload = row
          return builder
        },
        delete() {
          op.kind = 'delete'
          return builder
        },
        eq(col, value) {
          op.filters[col] = value
          return builder
        },
        limit(n) {
          op.limit = n
          return builder
        },
        maybeSingle() {
          op.single = true
          return builder
        },
        then(resolve, reject) {
          const handler = handlers[op.kind]
          const result =
            typeof handler === 'function' ? handler(op) : (handler ?? { data: null, error: null })
          return Promise.resolve(result).then(resolve, reject)
        },
      }
      return builder
    },
  }
}

// The Store API is callback-based; promisify so the tests read linearly.
const promisify = (fn) =>
  new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))))

const FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'

test('get returns null for an unknown sid', async () => {
  const client = makeClient({ select: { data: null, error: null } })
  const store = new SupabaseSessionStore(client)
  assert.equal(await promisify((cb) => store.get('nope', cb)), null)
})

test('get returns the stored session for a live row', async () => {
  const sess = { cookie: { expires: FUTURE }, userId: 'user-1' }
  const client = makeClient({ select: { data: { sess, expire: FUTURE }, error: null } })
  const store = new SupabaseSessionStore(client)
  assert.deepEqual(await promisify((cb) => store.get('sid-live', cb)), sess)
})

test('get parses a session stored as a JSON string', async () => {
  const sess = { cookie: { expires: FUTURE }, userId: 'user-1' }
  const client = makeClient({
    select: { data: { sess: JSON.stringify(sess), expire: FUTURE }, error: null },
  })
  const store = new SupabaseSessionStore(client)
  assert.deepEqual(await promisify((cb) => store.get('sid-live', cb)), sess)
})

// The dangerous failure would be handing an expired row back as a live session.
test('get treats an expired row as absent and deletes it', async () => {
  const client = makeClient({
    select: { data: { sess: { userId: 'user-1' }, expire: PAST }, error: null },
    delete: { error: null },
  })
  const store = new SupabaseSessionStore(client)

  assert.equal(await promisify((cb) => store.get('sid-expired', cb)), null)

  const deletes = client.calls.filter((c) => c.kind === 'delete')
  assert.equal(deletes.length, 1, 'expired row should be deleted on read')
  assert.equal(deletes[0].filters.sid, 'sid-expired')
})

test('get surfaces a database error instead of silently signing the user out', async () => {
  const client = makeClient({ select: { data: null, error: new Error('connection reset') } })
  const store = new SupabaseSessionStore(client)
  await assert.rejects(() => promisify((cb) => store.get('sid', cb)), /connection reset/)
})

test('set upserts on sid with an expiry derived from the cookie', async () => {
  const client = makeClient({ upsert: { error: null } })
  const store = new SupabaseSessionStore(client)
  const sess = { cookie: { expires: FUTURE }, userId: 'user-1' }

  await promisify((cb) => store.set('sid-1', sess, cb))

  const [op] = client.calls
  assert.equal(op.kind, 'upsert')
  assert.equal(op.table, 'user_sessions')
  assert.equal(op.opts.onConflict, 'sid')
  assert.equal(op.payload.sid, 'sid-1')
  assert.deepEqual(op.payload.sess, sess)
  assert.equal(op.payload.expire, FUTURE)
})

test('destroy deletes the row for that sid only', async () => {
  const client = makeClient({ delete: { error: null } })
  const store = new SupabaseSessionStore(client)

  await promisify((cb) => store.destroy('sid-1', cb))

  const [op] = client.calls
  assert.equal(op.kind, 'delete')
  assert.deepEqual(op.filters, { sid: 'sid-1' })
})

// rolling:true touches on every response. Without the throttle this would be a
// database write per request, which is what #111 is trying to get away from.
test('touch writes once, then is throttled until the window passes', async () => {
  const client = makeClient({ update: { error: null }, upsert: { error: null } })
  const store = new SupabaseSessionStore(client, { touchThrottleMs: 60_000 })
  const sess = { cookie: { expires: FUTURE } }

  await promisify((cb) => store.touch('sid-1', sess, cb))
  await promisify((cb) => store.touch('sid-1', sess, cb))
  await promisify((cb) => store.touch('sid-1', sess, cb))

  assert.equal(
    client.calls.filter((c) => c.kind === 'update').length,
    1,
    'repeat touches inside the window must not reach the database',
  )

  // Simulate the window elapsing rather than sleeping through it.
  store.lastTouchedAt.set('sid-1', Date.now() - 61_000)
  await promisify((cb) => store.touch('sid-1', sess, cb))

  assert.equal(client.calls.filter((c) => c.kind === 'update').length, 2)
})

test('touch throttle is per sid, not global', async () => {
  const client = makeClient({ update: { error: null } })
  const store = new SupabaseSessionStore(client, { touchThrottleMs: 60_000 })
  const sess = { cookie: { expires: FUTURE } }

  await promisify((cb) => store.touch('sid-a', sess, cb))
  await promisify((cb) => store.touch('sid-b', sess, cb))

  assert.equal(client.calls.filter((c) => c.kind === 'update').length, 2)
})

test('set records the touch so an immediate touch is throttled', async () => {
  const client = makeClient({ upsert: { error: null }, update: { error: null } })
  const store = new SupabaseSessionStore(client, { touchThrottleMs: 60_000 })
  const sess = { cookie: { expires: FUTURE } }

  await promisify((cb) => store.set('sid-1', sess, cb))
  await promisify((cb) => store.touch('sid-1', sess, cb))

  assert.equal(
    client.calls.filter((c) => c.kind === 'update').length,
    0,
    'a fresh write already set the expiry; touching again immediately is waste',
  )
})

test('expiryFrom prefers cookie.expires, falls back to maxAge, then to a bounded default', () => {
  assert.equal(expiryFrom({ cookie: { expires: FUTURE } }).toISOString(), FUTURE)

  const viaMaxAge = expiryFrom({ cookie: { originalMaxAge: 60_000 } }).getTime()
  assert.ok(Math.abs(viaMaxAge - (Date.now() + 60_000)) < 5_000)

  // Never write a row with no expiry - it would never be reclaimed.
  const fallback = expiryFrom({ cookie: {} }).getTime()
  assert.ok(fallback > Date.now(), 'fallback expiry must be in the future')
  assert.ok(fallback <= Date.now() + 24 * 60 * 60 * 1000 + 5_000)
})

test('expiryFrom ignores an unparseable cookie.expires', () => {
  const at = expiryFrom({ cookie: { expires: 'not-a-date', originalMaxAge: 60_000 } }).getTime()
  assert.ok(Math.abs(at - (Date.now() + 60_000)) < 5_000)
})

// The owner runs db/*.sql by hand. A missing table must degrade to the old
// behaviour, never crash the boot.
test('createSessionStore returns null when the table is missing', async () => {
  const client = makeClient({
    select: { data: null, error: { message: 'relation does not exist' } },
  })
  assert.equal(await createSessionStore(client), null)
})

test('createSessionStore returns a store when the table is reachable', async () => {
  const client = makeClient({ select: { data: [], error: null } })
  assert.ok((await createSessionStore(client)) instanceof SupabaseSessionStore)
})

test('createSessionStore returns null when the client throws outright', async () => {
  const client = {
    from() {
      throw new Error('network down')
    },
  }
  assert.equal(await createSessionStore(client), null)
})
