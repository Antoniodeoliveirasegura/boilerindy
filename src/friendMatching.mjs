// Friend Matching (issue #17). Connect students who share courses. Reuses the
// course-code normalizer from Study Group Finder (#33). Pure validation +
// ranking helpers kept here so they are unit-testable without DB/HTTP; the
// connection-request gate takes the Supabase client as an argument for the
// same reason.
import { isUuid } from './httpGuards.mjs'

export { normalizeCourseCode, coursesFromClassItems } from './studyGroups.mjs'

export const MAX_BIO = 300
export const MAX_INTERESTS = 10
export const MAX_INTEREST_LEN = 40

/**
 * Validate + coerce a profile body (bio, interests, discoverable).
 * @returns {{ value: object } | { error: string }}
 */
export function validateProfileInput(body) {
  const bio = String(body?.bio ?? '').trim()
  if (bio.length > MAX_BIO) return { error: `Bio must be ${MAX_BIO} characters or fewer` }

  let interests = []
  if (body?.interests !== undefined) {
    const raw = Array.isArray(body.interests)
      ? body.interests
      : String(body.interests).split(',')
    interests = raw
      .map((s) => String(s).trim().slice(0, MAX_INTEREST_LEN))
      .filter(Boolean)
    // De-dupe case-insensitively while keeping first-seen casing.
    const seen = new Set()
    interests = interests.filter((i) => {
      const k = i.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    if (interests.length > MAX_INTERESTS) {
      return { error: `Add at most ${MAX_INTERESTS} interests` }
    }
  }

  const discoverable = body?.discoverable === true || body?.discoverable === 'true'

  return { value: { bio, interests, discoverable } }
}

/**
 * Rank candidate users by how many courses they share with the current user.
 * @param {Iterable<string>} myCourses - my normalized course codes
 * @param {Array<{ userId: string, courses: string[] }>} candidates
 * @returns {Array<{ userId: string, sharedCourses: string[], sharedCount: number }>}
 *   candidates sharing >=1 course, sorted by overlap desc
 */
export function rankMatches(myCourses, candidates) {
  const mine = myCourses instanceof Set ? myCourses : new Set(myCourses || [])
  if (mine.size === 0 || !Array.isArray(candidates)) return []
  return candidates
    .map((c) => {
      const shared = (c.courses || []).filter((code) => mine.has(code))
      return { userId: c.userId, sharedCourses: shared, sharedCount: shared.length }
    })
    .filter((c) => c.sharedCount > 0)
    .sort((a, b) => b.sharedCount - a.sharedCount)
}

/**
 * Public match card - only non-sensitive fields before a connection is accepted.
 */
export function mapMatchCard(user, sharedCount) {
  return {
    userId: user.id,
    displayName: user.display_name || 'Student',
    interests: Array.isArray(user.interests) ? user.interests : [],
    sharedCount,
  }
}

/**
 * Whether a user may receive a connection request (#203). Matching is opt-in,
 * so only discoverable profiles qualify; a missing row (unknown user) does not.
 * Kept tiny so #192 can add blocked users here.
 * @param {{ discoverable?: boolean } | null | undefined} profileRow - user_profiles row
 */
export function canReceiveFriendRequest(profileRow) {
  return Boolean(profileRow?.discoverable)
}

/**
 * POST /api/connections (#203). A malformed or self id is a 400. An unknown,
 * non-discoverable or previously declining addressee gets the same pending
 * answer as a real request but no row, so the response is not an oracle for
 * who exists or who opted in. Only a discoverable addressee gets an upsert.
 * @param {object} supabase - service-role client
 * @param {string} userId - the requester (req.currentUser.id)
 * @param {unknown} rawAddresseeId - req.body.addresseeId as sent
 * @param {{ nowIso?: () => string }} [options]
 * @returns {Promise<{ status: number, body: object }>} throws the Supabase error on a DB failure
 */
export async function sendConnectionRequest(supabase, userId, rawAddresseeId, { nowIso = () => new Date().toISOString() } = {}) {
  // Lowercased so an uppercase copy of my own id cannot slip past the self check.
  const addresseeId = String(rawAddresseeId || '').trim().toLowerCase()
  if (!isUuid(addresseeId) || addresseeId === String(userId).toLowerCase()) {
    return { status: 400, body: { error: { message: 'A valid recipient is required.', status: 400 } } }
  }
  const pending = { status: 200, body: { ok: true, status: 'pending' } }

  const target = await supabase.from('user_profiles').select('discoverable').eq('user_id', addresseeId).maybeSingle()
  if (target.error) throw target.error
  if (!canReceiveFriendRequest(target.data)) return pending

  // If the addressee previously declined me, silently no-op (requester sees pending).
  const prior = await supabase
    .from('connections')
    .select('status')
    .eq('requester_id', userId)
    .eq('addressee_id', addresseeId)
    .maybeSingle()
  if (prior.data?.status === 'declined') return pending

  const { error } = await supabase
    .from('connections')
    .upsert(
      { requester_id: userId, addressee_id: addresseeId, status: 'pending', created_at: nowIso() },
      { onConflict: 'requester_id,addressee_id' },
    )
  if (error) throw error
  return pending
}
