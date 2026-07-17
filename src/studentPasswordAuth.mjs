// Student password policy: Supabase Auth is the single source of truth for
// passwords. The scrypt hash in public.users.password_hash is LEGACY ONLY - it
// exists so accounts created before the Supabase migration can sign in once
// more and be migrated forward; nothing may write new hashes to it.
//
// Like advertiserAuth.mjs, this module is the functional core: all Supabase
// calls are injected so the security-critical ordering can be unit-tested
// (see studentPasswordAuth.test.mjs). server.mjs supplies the real deps.

import { verifyPassword } from './passwordHash.mjs'

/** True when the row still carries a legacy `<salt>:<hash>` scrypt password. */
export function hasLegacyHash(userRow) {
  return Boolean(userRow?.password_hash && userRow.password_hash.includes(':'))
}

/**
 * Decide a sign-in attempt. Supabase Auth is asked first and its verdict is
 * final for any email it knows; the legacy scrypt hash only wins for accounts
 * that do not exist in Supabase Auth yet, in which case they are migrated.
 *
 * @param {{
 *   verifySupabasePassword: (email: string, password: string) => Promise<object|null>,
 *   getUserByEmail: (email: string) => Promise<object|null>,
 *   ensureUserRow: (authUser: object, email: string) => Promise<object|null>,
 *   migrateLegacyUser: (userRow: object, password: string) => Promise<boolean>,
 * }} deps
 * @returns {Promise<{ ok: true, user: object } | { ok: false }>}
 */
export async function resolveSignIn(deps, email, password) {
  if (!email || !password) return { ok: false }

  const authUser = await deps.verifySupabasePassword(email, password)
  if (authUser) {
    const user = await deps.ensureUserRow(authUser, email)
    return user ? { ok: true, user } : { ok: false }
  }

  // Legacy fallback. migrateLegacyUser returns false when the email already
  // exists in Supabase Auth - then Supabase's rejection above stands, so a
  // stale local hash can never resurrect an old password.
  const userRow = await deps.getUserByEmail(email)
  if (!hasLegacyHash(userRow) || !verifyPassword(password, userRow.password_hash)) {
    return { ok: false }
  }
  const migrated = await deps.migrateLegacyUser(userRow, password)
  return migrated ? { ok: true, user: userRow } : { ok: false }
}

/**
 * Apply a password change for a signed-in user. Verifies the current password
 * (Supabase Auth first, legacy hash as migration fallback) and writes the new
 * password to Supabase Auth only.
 *
 * @param {{
 *   verifySupabasePassword: (email: string, password: string) => Promise<object|null>,
 *   setSupabasePassword: (authUserId: string, newPassword: string) => Promise<void>,
 *   migrateLegacyUser: (userRow: object, password: string) => Promise<boolean>,
 * }} deps
 * @throws {Error} with a user-facing message when the change is rejected
 */
export async function applyPasswordChange(deps, userRow, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters.')
  }
  if (newPassword.length > 128) {
    throw new Error('New password must be at most 128 characters.')
  }

  const authUser = await deps.verifySupabasePassword(userRow.email, currentPassword || '')
  if (authUser) {
    await deps.setSupabasePassword(authUser.id, newPassword)
    return
  }

  if (!hasLegacyHash(userRow) || !verifyPassword(currentPassword || '', userRow.password_hash)) {
    throw new Error('Current password is incorrect.')
  }
  // Legacy account: create it in Supabase Auth with the NEW password. If the
  // email already exists there, Supabase's rejection of currentPassword is
  // authoritative and the change is refused.
  const migrated = await deps.migrateLegacyUser(userRow, newPassword)
  if (!migrated) {
    throw new Error('Current password is incorrect.')
  }
}

/**
 * Verify a signed-in user's current password WITHOUT changing it, using the same
 * Supabase-Auth-first / legacy-hash-fallback rules as applyPasswordChange. Gates
 * account-takeover-sensitive changes (e.g. an email change) behind re-auth.
 *
 * @param {{ verifySupabasePassword: (email: string, password: string) => Promise<object|null> }} deps
 * @throws {Error} when the current password is wrong.
 */
export async function verifyCurrentPassword(deps, userRow, currentPassword) {
  const authUser = await deps.verifySupabasePassword(userRow.email, currentPassword || '')
  if (authUser) return
  if (!hasLegacyHash(userRow) || !verifyPassword(currentPassword || '', userRow.password_hash)) {
    throw new Error('Current password is incorrect.')
  }
}
