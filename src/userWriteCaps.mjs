// Row caps and the advertiser bucket key for the authenticated write routes
// (issue #202).
//
// A signed-in script could create manual tasks, grades, dining favorites and
// draft campaigns without limit. Those tables are read back without a limit on
// every dashboard or portal load, and a flood of campaigns pushed real
// submissions out of the admin review list. The user-write and
// advertiser-write limiters in server.mjs slow the flood; these caps bound the
// rows a caller keeps. The draft campaign cap counts drafts only, so it does
// not bound campaigns submitted for review: an advertiser who submits or ends
// each draft frees its slot, and advertiser-write is all that slows that loop
// (docs/RATE_LIMITS.md).
//
// Each create route counts the caller's rows with a HEAD count before the
// insert and answers 409 at the cap. The count is not atomic with the insert:
// parallel requests that all count before any of them inserts each get
// through, so one burst can overshoot a cap by up to the write limiter's
// remaining budget, and the first request after it is refused. That race is
// accepted.

export const MAX_MANUAL_TASKS = 500
export const MAX_GRADES = 500
export const MAX_DINING_FAVORITES = 300
export const MAX_DRAFT_CAMPAIGNS = 20

export const MANUAL_TASKS_CAP_MESSAGE = `You can keep up to ${MAX_MANUAL_TASKS} tasks. Delete some you no longer need to add more.`
export const GRADES_CAP_MESSAGE = `You can track up to ${MAX_GRADES} courses. Remove some to add more.`
export const DINING_FAVORITES_CAP_MESSAGE = `You can save up to ${MAX_DINING_FAVORITES} favorites. Remove some to add more.`
export const DRAFT_CAMPAIGNS_CAP_MESSAGE = `You can keep up to ${MAX_DRAFT_CAMPAIGNS} draft campaigns. Submit or end a draft before creating another.`

/**
 * True when a caller who already owns `count` rows may not add another, i.e.
 * the insert would take them past `cap`. A count that is not a finite number
 * (the count query came back without one) never blocks: the route fails open
 * rather than locking the user out of their own data.
 *
 * @param {unknown} count rows the caller owns now
 * @param {number} cap the most rows they may own
 * @returns {boolean}
 */
export function exceedsCap(count, cap) {
  if (typeof count !== 'number' || !Number.isFinite(count)) return false
  return count >= cap
}

/**
 * Reads the supabase-js result of a create route's HEAD count query
 * (`{ count, error, status }`). `blocked` is true when the caller already owns
 * `cap` rows. A failed count query fails open like a missing count: the write
 * limiter still bounds a flood, and if the database really is down the insert
 * fails with its own error. `failure` is then a line for the route to log,
 * otherwise null. A HEAD response has no body, so supabase-js reports a 5xx as
 * `{ message: '' }` and the HTTP status (0 when no response came back) is the
 * only clue to what went wrong.
 *
 * @param {{ count?: unknown, error?: unknown, status?: unknown } | null | undefined} result
 * @param {number} cap the most rows the caller may own
 * @returns {{ blocked: boolean, failure: string | null }}
 */
export function capCheck(result, cap) {
  if (result?.error) {
    const status = typeof result.status === 'number' && result.status > 0 ? `status ${result.status}` : 'no response'
    return { blocked: false, failure: `row cap count query failed (${status}), allowing the write` }
  }
  return { blocked: exceedsCap(result?.count, cap), failure: null }
}

/**
 * Bucket key for the advertiser-write limiter. Advertiser portal sessions carry
 * `req.session.advertiserId` (set at advertiser sign-in, read by
 * requireAdvertiserAuth) and no student `userId`, so the default userOrIp
 * strategy would key every advertiser by IP. Null falls back to the IP bucket,
 * which is where a request with no advertiser session belongs.
 *
 * @param {{ session?: { advertiserId?: unknown } }} req
 * @returns {string|null}
 */
export function advertiserWriteBucketKey(req) {
  const advertiserId = req?.session?.advertiserId
  return typeof advertiserId === 'string' && advertiserId ? `adv:${advertiserId}` : null
}
