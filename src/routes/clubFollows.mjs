import express from 'express'
import { clubForOrganizationKey, followedClubs } from '../clubFollows.mjs'
import { DB_FEATURES, respondDbError } from '../dbErrors.mjs'
import { parseOrganizationKey } from '../sharedEvents.mjs'
import { CLUB_FOLLOWS_CAP_MESSAGE, MAX_CLUB_FOLLOWS, exceedsCap } from '../userWriteCaps.mjs'

// Following a club (issue #16): the clubs a student follows from /clubs, kept
// in club_follows (db/supabase-club-follows.sql, README step 48) so they follow
// the student to every device. A club is named by its organization key,
// `boilerlink:<Id>` (src/clubFollows.mjs). The Events and Free Food read marks
// the followed clubs' events (src/campusEventsFeed.mjs). docs/clubs.md has the
// contract the website and the native app code against.
//
// Every answer that is not a 200 uses the standard envelope with a code
// (docs/api-error-codes.md): a malformed key, a club the directory does not
// list, the cap, a directory that has never loaded, and a missing table.

const DB = DB_FEATURES.club_follows

function refuse(res, status, code, message) {
  return res.status(status).json({ error: { message, code, status } })
}

function badKey(res) {
  return refuse(res, 400, 'club_follows_bad_key', 'That is not a club the app knows.')
}

/**
 * The follow routes, mounted by server.mjs behind the session. The two writes
 * share the per-user write limiter; the read has none, like the other
 * per-student reads.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase            the Supabase client
 * @param {Function} deps.requireAuth         loads req.currentUser or answers 401
 * @param {Function} deps.userWriteRateLimit  the shared per-user write limiter, on PUT and DELETE
 * @param {object}   deps.clubDirectoryCache  server.mjs's BoilerLink directory cache
 *   (src/boilerlinkClubs.mjs): a new follow must name a club it lists
 */
export function createClubFollowsRouter({ supabase, requireAuth, userWriteRateLimit, clubDirectoryCache }) {
  const router = express.Router()

  // { follows: [organizationKey, ...] } oldest first, plus the followed clubs
  // the directory lists, in its name order, for the Following view. A club
  // that left BoilerLink stays in `follows`, so it can still be unfollowed.
  router.get('/api/me/club-follows', requireAuth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('club_follows')
        .select('organization_key')
        .eq('user_id', req.currentUser.id)
        .order('created_at', { ascending: true })
        .order('organization_key', { ascending: true })
      if (error) return respondDbError(res, error, DB)
      const follows = (data ?? []).map((row) => row.organization_key)
      const { directory } = await clubDirectoryCache.get()
      res.json({ follows, clubs: directory?.ok ? followedClubs(directory, follows) : [] })
    } catch (error) {
      respondDbError(res, error, DB)
    }
  })

  // Idempotent: following a club already followed answers the same 200 and
  // keeps the first created_at. The cap counts the other clubs, so a repeat
  // at the cap still goes through.
  router.put('/api/me/club-follows/:organizationKey', userWriteRateLimit, requireAuth, async (req, res) => {
    const parsed = parseOrganizationKey(req.params.organizationKey)
    if (!parsed) return badKey(res)
    const userId = req.currentUser.id
    try {
      const { directory } = await clubDirectoryCache.get()
      if (!directory?.ok) {
        return refuse(res, 503, 'club_follows_directory_unavailable', 'The club directory is not available right now. Please try again in a few minutes.')
      }
      if (!clubForOrganizationKey(directory, parsed.key)) {
        return refuse(res, 404, 'club_follows_unknown_club', 'That club is not in the club directory.')
      }
      // A read of the keys rather than a HEAD count: a HEAD answer has no
      // body, so a missing table would read as a failed count, not as 503.
      const { data, error: readError } = await supabase.from('club_follows').select('organization_key').eq('user_id', userId)
      if (readError) return respondDbError(res, readError, DB)
      const keys = (data ?? []).map((row) => row.organization_key)
      if (!keys.includes(parsed.key) && exceedsCap(keys.length, MAX_CLUB_FOLLOWS)) {
        return refuse(res, 409, 'club_follows_limit', CLUB_FOLLOWS_CAP_MESSAGE)
      }
      const { error } = await supabase
        .from('club_follows')
        .upsert({ user_id: userId, organization_key: parsed.key }, { onConflict: 'user_id,organization_key', ignoreDuplicates: true })
      if (error) return respondDbError(res, error, DB)
      res.json({ ok: true, organizationKey: parsed.key, following: true })
    } catch (error) {
      respondDbError(res, error, DB)
    }
  })

  // Idempotent too, and it needs no directory: a club that left BoilerLink
  // can still be unfollowed.
  router.delete('/api/me/club-follows/:organizationKey', userWriteRateLimit, requireAuth, async (req, res) => {
    const parsed = parseOrganizationKey(req.params.organizationKey)
    if (!parsed) return badKey(res)
    try {
      const { error } = await supabase.from('club_follows').delete().eq('user_id', req.currentUser.id).eq('organization_key', parsed.key)
      if (error) return respondDbError(res, error, DB)
      res.json({ ok: true, organizationKey: parsed.key, following: false })
    } catch (error) {
      respondDbError(res, error, DB)
    }
  })

  return router
}
