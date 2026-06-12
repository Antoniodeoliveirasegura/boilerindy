import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword } from './passwordHash.mjs'
import { hasLegacyHash, resolveSignIn, applyPasswordChange } from './studentPasswordAuth.mjs'

const AUTH_USER = { id: 'auth-1', email: 'student@purdue.edu' }
const ROW = { id: 'row-1', email: 'student@purdue.edu', display_name: 'Student', password_hash: '' }

function deps(overrides = {}) {
  return {
    verifySupabasePassword: async () => null,
    getUserByEmail: async () => null,
    ensureUserRow: async () => ROW,
    migrateLegacyUser: async () => {
      throw new Error('migrateLegacyUser should not be called')
    },
    setSupabasePassword: async () => {
      throw new Error('setSupabasePassword should not be called')
    },
    ...overrides,
  }
}

test('hasLegacyHash detects the salt:hash format only', () => {
  assert.equal(hasLegacyHash({ password_hash: hashPassword('secret123') }), true)
  assert.equal(hasLegacyHash({ password_hash: '' }), false)
  assert.equal(hasLegacyHash({ password_hash: 'no-colon' }), false)
  assert.equal(hasLegacyHash(null), false)
})

test('resolveSignIn verifies against Supabase Auth first', async () => {
  const calls = []
  const result = await resolveSignIn(
    deps({
      verifySupabasePassword: async (email, password) => {
        calls.push(['verify', email, password])
        return AUTH_USER
      },
      ensureUserRow: async (authUser, email) => {
        calls.push(['ensure', authUser.id, email])
        return ROW
      },
    }),
    'student@purdue.edu',
    'current-pass',
  )
  assert.deepEqual(result, { ok: true, user: ROW })
  assert.deepEqual(calls, [
    ['verify', 'student@purdue.edu', 'current-pass'],
    ['ensure', 'auth-1', 'student@purdue.edu'],
  ])
})

test('resolveSignIn rejects when Supabase rejects and no legacy hash exists', async () => {
  const result = await resolveSignIn(
    deps({ getUserByEmail: async () => ({ ...ROW, password_hash: '' }) }),
    'student@purdue.edu',
    'wrong-pass',
  )
  assert.deepEqual(result, { ok: false })
})

// Regression: before the cleanup, a stale local hash let an OLD password keep
// signing in after the Supabase password changed. The legacy fallback must lose
// whenever the email already exists in Supabase Auth (migrate returns false).
test('resolveSignIn rejects a stale legacy hash when the account exists in Supabase Auth', async () => {
  const oldPassword = 'old-password-1'
  const result = await resolveSignIn(
    deps({
      getUserByEmail: async () => ({ ...ROW, password_hash: hashPassword(oldPassword) }),
      migrateLegacyUser: async () => false, // email_exists in Supabase Auth
    }),
    'student@purdue.edu',
    oldPassword,
  )
  assert.deepEqual(result, { ok: false })
})

test('resolveSignIn migrates a pre-Supabase legacy account and signs it in', async () => {
  const legacyRow = { ...ROW, password_hash: hashPassword('legacy-pass-9') }
  let migratedWith = null
  const result = await resolveSignIn(
    deps({
      getUserByEmail: async () => legacyRow,
      migrateLegacyUser: async (row, password) => {
        migratedWith = [row.id, password]
        return true
      },
    }),
    'student@purdue.edu',
    'legacy-pass-9',
  )
  assert.deepEqual(result, { ok: true, user: legacyRow })
  assert.deepEqual(migratedWith, ['row-1', 'legacy-pass-9'])
})

test('resolveSignIn rejects empty credentials without touching dependencies', async () => {
  const result = await resolveSignIn(
    deps({
      verifySupabasePassword: async () => {
        throw new Error('should not be called')
      },
    }),
    '',
    '',
  )
  assert.deepEqual(result, { ok: false })
})

test('applyPasswordChange enforces the minimum new-password length', async () => {
  await assert.rejects(
    applyPasswordChange(deps(), ROW, 'current', 'short'),
    /at least 8 characters/,
  )
})

test('applyPasswordChange updates Supabase Auth when the current password verifies there', async () => {
  let setWith = null
  await applyPasswordChange(
    deps({
      verifySupabasePassword: async () => AUTH_USER,
      setSupabasePassword: async (authUserId, password) => {
        setWith = [authUserId, password]
      },
    }),
    ROW,
    'current-pass',
    'new-password-1',
  )
  assert.deepEqual(setWith, ['auth-1', 'new-password-1'])
})

test('applyPasswordChange rejects a wrong current password', async () => {
  await assert.rejects(
    applyPasswordChange(deps(), { ...ROW, password_hash: '' }, 'wrong', 'new-password-1'),
    /Current password is incorrect/,
  )
})

test('applyPasswordChange migrates a legacy account with the new password', async () => {
  let migratedWith = null
  const legacyRow = { ...ROW, password_hash: hashPassword('legacy-pass-9') }
  await applyPasswordChange(
    deps({
      migrateLegacyUser: async (row, password) => {
        migratedWith = [row.id, password]
        return true
      },
    }),
    legacyRow,
    'legacy-pass-9',
    'new-password-1',
  )
  assert.deepEqual(migratedWith, ['row-1', 'new-password-1'])
})

test('applyPasswordChange rejects when the legacy hash matches but Supabase Auth owns the email', async () => {
  const legacyRow = { ...ROW, password_hash: hashPassword('stale-old-pass') }
  await assert.rejects(
    applyPasswordChange(
      deps({ migrateLegacyUser: async () => false }),
      legacyRow,
      'stale-old-pass',
      'new-password-1',
    ),
    /Current password is incorrect/,
  )
})
