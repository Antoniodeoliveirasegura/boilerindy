import test from 'node:test'
import assert from 'node:assert/strict'
import { createPurdueIdentity } from '../src/purdueIdentity.mjs'
import { LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE } from '../src/purdueEmailVerification.mjs'
import { fakeSupabase, hasCall, operation } from './routes/fakeSupabase.mjs'

// Issue #191: linkPurdueIdentity and clearPurdueLinkOnUser moved out of
// server.mjs into src/purdueIdentity.mjs. The users table answers from rows
// held here; auth.admin.getUserById answers from the live Auth user ids.

const ME = '11111111-1111-4111-8111-111111111111'
const HOLDER = '22222222-2222-4222-8222-222222222222'
const STUDENT = { id: ME, email: 'pete@example.com', purdue_email: null, purdue_username: null }
const isRecent = (iso) => Math.abs(Date.parse(iso) - Date.now()) < 60 * 1000

/**
 * @param {object} options
 * @param {object} options.me          the current user's row (getUserById answers it)
 * @param {object[]} [options.holders] rows the purdue_email lookup returns
 * @param {string[]} [options.liveAuthIds] Auth user ids that still exist
 * @param {object} [options.updateError] what the linking update answers with
 */
function setup({ me = STUDENT, holders = [], liveAuthIds = [], updateError = null, clearError = null } = {}) {
  const authLookups = []
  const supabase = fakeSupabase({
    users: (chain) => {
      if (operation(chain) === 'select') return { data: holders, error: null }
      const patch = chain.find((c) => c.method === 'update').args[0]
      if (patch.purdue_email === null) return { data: null, error: clearError }
      if (updateError) return { data: null, error: updateError }
      return { data: { ...me, ...patch }, error: null }
    },
  })
  supabase.auth = {
    admin: {
      async getUserById(id) {
        authLookups.push(id)
        return liveAuthIds.includes(id)
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { code: 'user_not_found', message: 'User not found' } }
      },
    },
  }
  const getUserById = async (id) => (id === me.id ? { ...me } : null)
  return { supabase, authLookups, ...createPurdueIdentity({ supabase, getUserById }) }
}

const updates = (supabase) => supabase.queriesOf('users').filter((q) => operation(q.chain) === 'update')
const patchOf = (query) => query.chain.find((c) => c.method === 'update').args[0]

test('a non-Purdue address is refused before any query', async () => {
  const { supabase, linkPurdueIdentity } = setup()
  for (const email of ['pete@gmail.com', '', 'pete@purdue.edu.evil.example', undefined]) {
    await assert.rejects(linkPurdueIdentity(ME, { email }), { message: 'Please use a valid @purdue.edu account.' })
  }
  assert.equal(supabase.queries.length, 0)
})

test('the address the profile already holds returns the user unwritten', async () => {
  const me = { ...STUDENT, purdue_email: 'pete@purdue.edu' }
  const { supabase, linkPurdueIdentity } = setup({ me })
  assert.deepEqual(await linkPurdueIdentity(ME, { email: '  PETE@Purdue.edu ' }), me)
  assert.equal(supabase.queries.length, 0)
})

test('a profile holding another Purdue address is refused with the shared message, unwritten', async () => {
  const { supabase, linkPurdueIdentity } = setup({ me: { ...STUDENT, purdue_email: 'old@purdue.edu' } })
  await assert.rejects(linkPurdueIdentity(ME, { email: 'new@purdue.edu' }), { message: LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE })
  assert.equal(supabase.queries.length, 0)
})

test('a free address is linked: the update writes the three columns on this user only', async () => {
  const { supabase, linkPurdueIdentity } = setup()
  const row = await linkPurdueIdentity(ME, { email: 'PPete@Purdue.edu' })
  assert.equal(row.purdue_email, 'ppete@purdue.edu')
  const [lookup] = supabase.queriesOf('users')
  assert.ok(hasCall(lookup.chain, 'select', 'id, email'))
  assert.ok(hasCall(lookup.chain, 'eq', 'purdue_email', 'ppete@purdue.edu'))
  assert.ok(hasCall(lookup.chain, 'neq', 'id', ME))
  const [link] = updates(supabase)
  const patch = patchOf(link)
  assert.deepEqual(Object.keys(patch).sort(), ['purdue_email', 'purdue_linked_at', 'purdue_username', 'updated_at'])
  assert.equal(patch.purdue_email, 'ppete@purdue.edu')
  assert.equal(patch.purdue_username, 'ppete')
  assert.ok(isRecent(patch.purdue_linked_at))
  assert.equal(patch.updated_at, patch.purdue_linked_at)
  assert.ok(hasCall(link.chain, 'eq', 'id', ME))
  assert.ok(hasCall(link.chain, 'single'))
})

test('an address held by an older row of the same login email is cleared from it, then linked', async () => {
  const holders = [{ id: HOLDER, email: 'PETE@example.com' }]
  const { supabase, authLookups, linkPurdueIdentity } = setup({ holders, liveAuthIds: [HOLDER] })
  await linkPurdueIdentity(ME, { email: 'pete@purdue.edu' })
  const [clear, link] = updates(supabase)
  assert.deepEqual(Object.keys(patchOf(clear)).sort(), ['purdue_email', 'purdue_linked_at', 'purdue_username', 'updated_at'])
  assert.equal(patchOf(clear).purdue_email, null)
  assert.equal(patchOf(clear).purdue_username, null)
  assert.equal(patchOf(clear).purdue_linked_at, null)
  assert.ok(isRecent(patchOf(clear).updated_at))
  assert.ok(hasCall(clear.chain, 'eq', 'id', HOLDER))
  assert.ok(hasCall(link.chain, 'eq', 'id', ME))
  // The same login email settles it: no Auth lookup.
  assert.deepEqual(authLookups, [])
})

test('an address held by an orphan row (its Auth user deleted) is cleared, then linked', async () => {
  const holders = [{ id: HOLDER, email: 'someone@example.com' }]
  const { supabase, authLookups, linkPurdueIdentity } = setup({ holders, liveAuthIds: [] })
  await linkPurdueIdentity(ME, { email: 'pete@purdue.edu' })
  assert.deepEqual(authLookups, [HOLDER])
  const [clear, link] = updates(supabase)
  assert.ok(hasCall(clear.chain, 'eq', 'id', HOLDER))
  assert.equal(patchOf(clear).purdue_email, null)
  assert.ok(hasCall(link.chain, 'eq', 'id', ME))
})

test('an address held by a live profile is refused, with nothing written', async () => {
  const holders = [{ id: HOLDER, email: 'someone@example.com' }]
  const { supabase, authLookups, linkPurdueIdentity } = setup({ holders, liveAuthIds: [HOLDER] })
  await assert.rejects(linkPurdueIdentity(ME, { email: 'pete@purdue.edu' }), {
    message: 'That Purdue account is already linked to another BoilerIndy profile. '
      + 'Sign in with the email you used before, or contact support to release the link.',
  })
  assert.deepEqual(authLookups, [HOLDER])
  assert.deepEqual(updates(supabase), [])
})

test('a unique violation on the update gives its own message; another error passes its message on', async () => {
  const unique = setup({ updateError: { code: '23505', message: 'duplicate key value violates unique constraint "users_purdue_email_key"' } })
  await assert.rejects(unique.linkPurdueIdentity(ME, { email: 'pete@purdue.edu' }), {
    message: 'That Purdue email is already linked to another account. Contact support if you recently reset your profile.',
  })
  const other = setup({ updateError: { code: 'XX000', message: 'connection reset' } })
  await assert.rejects(other.linkPurdueIdentity(ME, { email: 'pete@purdue.edu' }), { message: 'connection reset' })
})

test('clearPurdueLinkOnUser empties the three columns on that user and throws the database message', async () => {
  const { supabase, clearPurdueLinkOnUser } = setup()
  await clearPurdueLinkOnUser(HOLDER)
  const [clear] = updates(supabase)
  assert.ok(hasCall(clear.chain, 'eq', 'id', HOLDER))
  assert.equal(patchOf(clear).purdue_email, null)
  const failing = setup({ clearError: { message: 'permission denied' } })
  await assert.rejects(failing.clearPurdueLinkOnUser(HOLDER), { message: 'permission denied' })
})
