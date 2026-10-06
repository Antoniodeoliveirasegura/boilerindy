// purdueIdentity.mjs
//
// Linking a Purdue identity onto a student's users row, and clearing one
// (issue #191). The auth router links through it from the CAS and mock flows,
// the purdueEmail router from a verified email code (issue #181), and the
// admin router clears a link with it (POST /api/admin/purdue-links/clear).
// server.mjs builds one instance with createPurdueIdentity({ supabase,
// getUserById }) and hands the functions to all three. Moved out of
// server.mjs with the functions unchanged apart from nowIso() inlined.

import { LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE } from './purdueEmailVerification.mjs'
import { normalizeEmail } from './userFields.mjs'

/**
 * @param {object}   deps
 * @param {object}   deps.supabase     the Supabase client (the users table and auth.admin.getUserById)
 * @param {Function} deps.getUserById  a users row by id, or null (server.mjs's session core)
 * @returns {{ linkPurdueIdentity: Function, clearPurdueLinkOnUser: Function }}
 *   linkPurdueIdentity(userId, { email }) resolves to the updated users row, or
 *   throws an Error whose message is meant for the student;
 *   clearPurdueLinkOnUser(userId) empties the three Purdue columns.
 */
export function createPurdueIdentity({ supabase, getUserById }) {
  async function authUserExists(userId) {
    if (!userId) return false
    const { data, error } = await supabase.auth.admin.getUserById(userId)
    return Boolean(data?.user) && !error
  }

  async function clearPurdueLinkOnUser(userId) {
    const { error } = await supabase
      .from('users')
      .update({
        purdue_email: null,
        purdue_username: null,
        purdue_linked_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
    if (error) throw new Error(error.message)
  }

  async function linkPurdueIdentity(userId, { email }) {
    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail || !normalizedEmail.endsWith('@purdue.edu')) {
      throw new Error('Please use a valid @purdue.edu account.')
    }

    const currentUser = await getUserById(userId)
    const currentPurdueEmail = normalizeEmail(currentUser?.purdue_email)
    if (currentPurdueEmail === normalizedEmail) {
      return currentUser
    }
    // Never swap one Purdue identity for another silently (#293). Only an admin
    // can release a link today (POST /api/admin/purdue-links/clear), so the
    // message sends the student to support. The address stays out of the text:
    // the website carries this message in a redirect URL.
    if (currentPurdueEmail) {
      throw new Error(LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE)
    }

    const { data: existingRows } = await supabase
      .from('users')
      .select('id, email')
      .eq('purdue_email', normalizedEmail)
      .neq('id', userId)

    const existing = existingRows?.[0]
    if (existing) {
      const holderEmail = normalizeEmail(existing.email)
      const currentEmail = normalizeEmail(currentUser?.email)

      // Account recovery: Supabase Auth was reset but public.users still holds the
      // Purdue link on an older profile row for the same login email.
      if (holderEmail && currentEmail && holderEmail === currentEmail) {
        await clearPurdueLinkOnUser(existing.id)
      } else if (!(await authUserExists(existing.id))) {
        // Orphan profile row (Auth user deleted, public.users row left behind).
        await clearPurdueLinkOnUser(existing.id)
      } else {
        throw new Error(
          'That Purdue account is already linked to another BoilerIndy profile. '
          + 'Sign in with the email you used before, or contact support to release the link.',
        )
      }
    }

    const username = normalizedEmail.split('@')[0]
    const timestamp = new Date().toISOString()

    const { data, error } = await supabase
      .from('users')
      .update({
        purdue_email: normalizedEmail,
        purdue_username: username,
        purdue_linked_at: timestamp,
        updated_at: timestamp
      })
      .eq('id', userId)
      .select()
      .single()

    if (error) {
      if (String(error.message || '').includes('users_purdue_email_key') || error.code === '23505') {
        throw new Error(
          'That Purdue email is already linked to another account. Contact support if you recently reset your profile.',
        )
      }
      throw new Error(error.message)
    }
    return data
  }

  return { linkPurdueIdentity, clearPurdueLinkOnUser }
}
