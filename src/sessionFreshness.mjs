// Session freshness for password-change invalidation (#132).
//
// A server session records when it was established (`authAt`). When a user changes
// their password we stamp `users.password_changed_at`. Any session established
// before that stamp is treated as stale by getCurrentUser and rejected, so a
// stolen session dies the moment the real owner changes their password.
//
// The advertiser portal follows the same rule with
// `advertisers.password_changed_at` (db/supabase-advertiser-password-changed-at.sql):
// requireAdvertiserAuth refuses a session older than the stamp.

export const ADVERTISER_PASSWORD_CHANGED_SQL_FILE = 'db/supabase-advertiser-password-changed-at.sql'

/**
 * @param {string|null|undefined} passwordChangedAt - users.password_changed_at (ISO / Postgres timestamptz)
 * @param {string|null|undefined} sessionAuthAt - the session's establishment time (ISO)
 * @returns {boolean} true when the session predates the last password change
 */
export function isSessionStale(passwordChangedAt, sessionAuthAt) {
  // No recorded password change (or the column isn't migrated yet): never stale.
  if (!passwordChangedAt) return false
  // The password changed but this session never recorded an establishment time -
  // it was minted before this feature existed, so it is older than the change.
  if (!sessionAuthAt) return true
  // Compare as parsed dates: the two strings can be in different formats (server
  // nowIso() vs Postgres timestamptz), so a string compare would be wrong.
  const changed = new Date(passwordChangedAt).getTime()
  const authed = new Date(sessionAuthAt).getTime()
  // Unparseable input: fail open (don't lock the user out over a bad value).
  if (Number.isNaN(changed) || Number.isNaN(authed)) return false
  return changed > authed
}

/**
 * Stamps an advertiser's `password_changed_at` with `now`, ending every portal
 * session signed in before it. A guarded write, as the students' stamp is: the
 * password has already changed, so a failure is logged and the change stands,
 * and before the column exists nothing is stamped and older sessions keep
 * working, as before.
 *
 * @param {object} supabase the Supabase client
 * @param {string} advertiserId advertisers.id
 * @param {{ now?: string, log?: { warn: Function } }} [options]
 * @returns {Promise<boolean>} whether the stamp was written
 */
export async function stampAdvertiserPasswordChange(supabase, advertiserId, { now = new Date().toISOString(), log = console } = {}) {
  const { error } = await supabase.from('advertisers').update({ password_changed_at: now }).eq('id', advertiserId)
  if (error) {
    log.warn(`[advertiser] password_changed_at not set (run ${ADVERTISER_PASSWORD_CHANGED_SQL_FILE}): ${error.message}`)
    return false
  }
  return true
}
