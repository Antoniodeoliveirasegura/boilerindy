import test from 'node:test'
import assert from 'node:assert/strict'
import { PUSH_CHANNEL_TABLES, forgetPushChannels } from '../src/pushChannels.mjs'
import { fakeSupabase, hasCall, operation } from './routes/fakeSupabase.mjs'

// A password change ends every push channel of the account (src/pushChannels.mjs):
// both tables, by user_id, and never an error that would fail the change.

const quiet = async (run) => {
  const realError = console.error
  const logged = []
  console.error = (...args) => logged.push(args.join(' '))
  try {
    return { result: await run(), logged }
  } finally {
    console.error = realError
  }
}

test("forgetPushChannels deletes the account's browsers and phones, and reports how many", async () => {
  assert.deepEqual(PUSH_CHANNEL_TABLES, ['push_subscriptions', 'push_devices'])
  const supabase = fakeSupabase({
    push_subscriptions: () => ({ data: [{ id: 's1' }, { id: 's2' }], error: null }),
    push_devices: () => ({ data: [{ id: 'd1' }], error: null }),
  })
  assert.deepEqual(await forgetPushChannels(supabase, 'user-1'), { push_subscriptions: 2, push_devices: 1 })
  for (const table of PUSH_CHANNEL_TABLES) {
    const [query] = supabase.queriesOf(table)
    assert.equal(operation(query.chain), 'delete')
    assert.ok(hasCall(query.chain, 'eq', 'user_id', 'user-1'))
  }
})

test('a table not installed yet has nothing to delete; any other failure is logged, the other table still cleared, and nothing throws', async () => {
  const missing = fakeSupabase({
    push_subscriptions: () => ({ data: null, error: { code: '42P01', message: 'relation "push_subscriptions" does not exist' } }),
    push_devices: () => ({ data: [{ id: 'd1' }], error: null }),
  })
  const quietRun = await quiet(() => forgetPushChannels(missing, 'user-1'))
  assert.deepEqual(quietRun.result, { push_subscriptions: 0, push_devices: 1 })
  assert.deepEqual(quietRun.logged, [])

  const failing = fakeSupabase({
    push_subscriptions: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }),
    push_devices: () => {
      throw new Error('socket hang up')
    },
  })
  const loud = await quiet(() => forgetPushChannels(failing, 'user-1'))
  assert.deepEqual(loud.result, { push_subscriptions: 0, push_devices: 0 })
  assert.equal(loud.logged.length, 2)
  assert.match(loud.logged[0], /push_subscriptions not cleared for user=user-1/)
  assert.match(loud.logged[1], /push_devices not cleared for user=user-1: socket hang up/)
})
