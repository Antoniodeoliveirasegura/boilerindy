// Following a club (issue #16): a student follows BoilerLink organizations
// from the /clubs page, the follows live in club_follows
// (db/supabase-club-follows.sql, README step 48), and the shared campus events
// the followed clubs listed come back marked `followed: true` on the Events and
// Free Food read (src/campusEventsFeed.mjs). A club is named by its
// organization key, `boilerlink:<Id>` (organizationKeyFor and
// parseOrganizationKey in src/sharedEvents.mjs), the same key the ingest
// stores on each event as campus_events.organization_key.
//
// The routes are in src/routes/clubFollows.mjs; docs/clubs.md#following-a-club
// is the contract.

import { DB_FEATURES, isSchemaMissingError, logRouteError, logSchemaMissingOnce } from './dbErrors.mjs'
import { parseOrganizationKey } from './sharedEvents.mjs'

/** The Engage sources whose clubs can be followed: the ones with a club directory. */
export const FOLLOWABLE_SOURCES = Object.freeze(['boilerlink'])

// The directory's clubs by id, with their place in its name order, built once
// per directory object (the cache swaps the object on each refresh).
const indexes = new WeakMap()
function clubIndex(directory) {
  let index = indexes.get(directory)
  if (!index) {
    index = new Map((directory?.clubs ?? []).map((club, order) => [String(club.id), { club, order }]))
    indexes.set(directory, index)
  }
  return index
}

/**
 * The club an organization key names in the club directory
 * (src/boilerlinkClubs.mjs), or null: a key that is not one, a source with no
 * directory (TheSpot), or an id the directory does not list.
 * @param {{ clubs?: object[] } | null | undefined} directory
 * @param {unknown} key
 * @returns {object | null}
 */
export function clubForOrganizationKey(directory, key) {
  const parsed = parseOrganizationKey(key)
  if (!parsed || !FOLLOWABLE_SOURCES.includes(parsed.sourceKey) || !directory) return null
  return clubIndex(directory).get(parsed.id)?.club ?? null
}

/**
 * The followed clubs the directory still lists, in its name order, each the
 * directory's club with its `organizationKey`. A follow whose club left
 * BoilerLink is left out here and kept in `follows`, so it can be unfollowed.
 * @param {{ clubs?: object[] } | null | undefined} directory
 * @param {Iterable<string>} keys
 */
export function followedClubs(directory, keys) {
  if (!directory) return []
  const found = []
  for (const key of new Set(keys)) {
    const parsed = parseOrganizationKey(key)
    if (!parsed || !FOLLOWABLE_SOURCES.includes(parsed.sourceKey)) continue
    const entry = clubIndex(directory).get(parsed.id)
    if (entry) found.push({ ...entry, key })
  }
  return found.sort((a, b) => a.order - b.order).map(({ club, key }) => ({ ...club, organizationKey: key }))
}

/**
 * The organization keys one student follows, for the Events and Free Food
 * read, or null when they cannot be read. Never throws: the followed marks
 * only add to that read, so a missing table (README step 48 not run) logs the
 * file to run once and any other failure logs on every read, and both answer
 * null, which leaves the rows unmarked rather than marked "not followed".
 * @param {object} supabase the Supabase client
 * @param {string} userId
 * @returns {Promise<Set<string> | null>}
 */
export async function readFollowedKeys(supabase, userId) {
  try {
    const { data, error } = await supabase.from('club_follows').select('organization_key').eq('user_id', userId)
    if (error) {
      if (isSchemaMissingError(error)) logSchemaMissingOnce(DB_FEATURES.club_follows, error)
      else logRouteError('club_follows read', error)
      return null
    }
    return new Set((data ?? []).map((row) => row.organization_key).filter((key) => typeof key === 'string'))
  } catch (error) {
    logRouteError('club_follows read', error)
    return null
  }
}
