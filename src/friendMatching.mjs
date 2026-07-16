// Friend Matching (issue #17). Connect students who share courses. Reuses the
// course-code normalizer from Study Group Finder (#33). Pure validation +
// ranking helpers kept here so they are unit-testable without DB/HTTP.
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
