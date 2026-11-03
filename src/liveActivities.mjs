// Track this bus (boilerindy-app#173, item 5; issue #550, "Later"): the Live
// Activity's server half. The app starts a Live Activity for a bus coming to a
// stop, signed in or not (decision 4 of the notifications build), and reports
// its APNs push token at POST /api/live-activities (src/routes/push.mjs), which
// keeps it in live_activities (README step 58) with a 30-minute life. The
// fast tick (POST /api/internal/push/fast-tick) reads each open
// activity's stop through the widgets' 15-second arrivals cache, so it never
// adds a request to TransLoc, and sends what changed over APNs
// (src/apnsLiveActivity.mjs):
//
// - The first reading after a start is pushed, so the phone, which started the
//   activity from the arrivals it had, and this server agree from then on.
// - After that an update goes only when the ETA moves by a minute or more, and
//   at most once a minute, at priority 5. The phone counts down to the time it
//   was sent by itself, so the passing minutes need no push.
// - "Arriving", once the bus is due within a minute, goes at priority 10 with
//   an alert, once.
// - Every update sets the stale date 3 minutes ahead: if the updates stop
//   (APNs or TransLoc down), the activity dims instead of showing a wrong time.
// - It ends, with an `end` push, once the bus has come (after Arriving, the
//   bus is no longer due), after its 30 minutes, at the end of service (no bus
//   coming and the route past its hours), or when its stop is gone from
//   TransLoc. It ends without one when the student ends it (DELETE) or APNs
//   answers that the token is gone (410).
//
// The activity follows one bus: the soonest on its route (any route, without
// one), then that vehicle while TransLoc names it, so a second bus on the
// route does not take its place.
//
// What the phone gets, `content-state` (the app's ActivityKit ContentState
// decodes it):
//
//   { phase, arrivesAt, routeNum, routeName, color }
//
// phase is 'due' or 'arriving' while it runs, and at the end the reason it
// ended: 'arrived', 'expired', 'no-service' or 'stop-gone'. arrivesAt is when
// the bus is due, in seconds since 2001-01-01T00:00:00Z, the number Swift's
// Codable reads as a Date, null at the end. The route is the bus's, null when
// unknown.
//
// Claim before send, as everywhere in push: the push is claimed by changing
// last_state from the value the tick read (and setting ended_at for an end), so
// overlapping ticks or a second instance never send twice. A push APNs could
// not take because it is busy or down gets its claim back, and the tick stops
// there: the next one tries again. See docs/push-notifications.md, "Track this
// bus: the Live Activity".

import { liveActivityPayload, normalizeApnsToken } from './apnsLiveActivity.mjs'
import { queryError } from './cronTick.mjs'
import { DB_FEATURES, logSchemaMissingOnce } from './dbErrors.mjs'
import { CAMPUS_TIME_ZONE, minutesInZone } from './diningMeals.mjs'
import { isUuid } from './httpGuards.mjs'
import { notificationKind } from './notificationKinds.mjs'
import { isMissingTableError } from './pushReminders.mjs'
import { normalizePlaceKey } from './transitPlaces.mjs'

export const LIVE_ACTIVITY_KIND = 'bus-live-activity'
const KIND = notificationKind(LIVE_ACTIVITY_KIND)
// The registry's 30-minute life, and the 60 seconds an update is worth keeping.
export const LIFE_MINUTES = KIND.lifeMinutes
export const UPDATE_TTL_SECONDS = KIND.ttl.seconds
// An end is true for as long as anyone could see it, so APNs keeps it an hour.
export const END_TTL_SECONDS = 60 * 60
export const ARRIVING_SECONDS = 60
export const MOVE_SECONDS = 60
export const PUSH_GAP_SECONDS = 60
export const STALE_SECONDS = 3 * 60
// An ended activity stays on the Lock Screen this long with its last word.
export const DISMISS_SECONDS = 2 * 60
// The pass of a bus the activity follows: due no later than this after the
// time last sent. Later, the same vehicle is on its next trip around.
export const FOLLOW_SECONDS = 5 * 60
// An arrivals reading this old is the cache serving its last copy while
// TransLoc is down: nothing is pushed from it.
export const READING_MAX_AGE_MS = 60 * 1000
// The open activities one tick reads, and how many pushes are in flight at once.
export const MAX_OPEN = 1000
export const SEND_CONCURRENCY = 8
// Swift's reference date, 2001-01-01T00:00:00Z, in Unix seconds.
export const APPLE_EPOCH_SECONDS = 978307200

const PRIORITY = { update: 5, arriving: 10, end: 5 }
const COLUMNS = 'activity_id, push_token, apns_env, stop_key, route_id, ends_at, last_state, last_pushed_at'
const NOTHING = Object.freeze({ action: 'none' })

/**
 * Whether Track this bus runs: an APNs sender (APNS_KEY_P8, APNS_KEY_ID and
 * APNS_TEAM_ID set), the VAPID keys, which gate every push, and the kind not
 * stopped by PUSH_KINDS_OFF.
 */
export function liveActivitiesEnabled({ send, vapidKeys, kindsOff = new Set() }) {
  return Boolean(send) && Boolean(vapidKeys) && !kindsOff.has(LIVE_ACTIVITY_KIND)
}

/** An activity id as ActivityKit makes it, a UUID, lowercased; null for anything else. */
export function parseActivityId(value) {
  return isUuid(value) ? value.toLowerCase() : null
}

const invalid = (error) => ({ ok: false, error })

/**
 * POST /api/live-activities' body, { activityId, token, env, stop, routeId? }:
 * the activity's id, its push token in hex, the APNs host its build uses
 * ('production' for TestFlight and the App Store, 'development' for a build
 * run from Xcode), the place key from GET /api/transit/places, and the route
 * it follows (none: the next bus of any route there). Returns { ok: true,
 * activity } or { ok: false, error }.
 */
export function parseLiveActivityStart(body) {
  const input = body && typeof body === 'object' ? body : {}
  const activityId = parseActivityId(input.activityId)
  if (!activityId) return invalid('activityId must be the Live Activity id.')
  const token = normalizeApnsToken(input.token)
  if (!token) return invalid('token must be the Live Activity push token, in hex.')
  if (input.env !== 'production' && input.env !== 'development') return invalid("env must be 'production' or 'development'.")
  const stop = normalizePlaceKey(input.stop)
  if (!stop) return invalid('stop must be a place key from GET /api/transit/places.')
  const routeId = input.routeId ?? null
  if (routeId !== null && !(Number.isInteger(routeId) && routeId > 0 && routeId <= 2_147_483_647)) {
    return invalid('routeId must be a route id from that place, or left out.')
  }
  return { ok: true, activity: { activityId, token, env: input.env, stop, routeId } }
}

/**
 * What the phone was last sent, as last_state holds it: "due|<at>|<vehicle>|<route>"
 * or "arriving|..." while it runs (at in Unix seconds, "-" for none), and
 * "ended|<reason>". Plain text, so the claim compares it as it was read.
 */
export function formatState({ phase, at = null, vehicle = null, route = null, reason = null }) {
  if (phase === 'ended') return `ended|${reason}`
  return [phase, at, vehicle, route].map((value) => (value == null ? '-' : String(value))).join('|')
}

/** formatState's text back: { phase, at, vehicle, route } or { phase: 'ended', reason }; null for none or anything else. */
export function parseState(text) {
  if (typeof text !== 'string' || !text) return null
  const [phase, ...rest] = text.split('|')
  if (phase === 'ended') return { phase, reason: rest[0] || null }
  if (phase !== 'due' && phase !== 'arriving') return null
  const number = (value) => (value && value !== '-' && Number.isFinite(Number(value)) ? Number(value) : null)
  const state = { phase, at: number(rest[0]), vehicle: number(rest[1]), route: number(rest[2]) }
  return state.at === null ? null : state
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: CAMPUS_TIME_ZONE, weekday: 'short' })
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const clockMinutes = (clock) => {
  const [hours, minutes] = String(clock).split(':').map(Number)
  return hours * 60 + minutes
}

// Whether a route runs at `nowMs` by its hours (src/transitHours.mjs): on one
// of its days, from its start to its end on the campus clock, an end of
// "00:00" being the midnight that ends the day.
function runsAt(hours, nowMs) {
  const date = new Date(nowMs)
  if (!hours.days.includes(DAYS.indexOf(WEEKDAY.format(date)))) return false
  const minute = minutesInZone(date)
  const end = hours.end === '00:00' ? 24 * 60 : clockMinutes(hours.end)
  return minute >= clockMinutes(hours.start) && minute < end
}

/**
 * Whether service is over at the place for the activity: every route it
 * follows (`routeId`, or all of the place's) is past its hours, or the route
 * no longer stops there. A route whose hours are not on file never counts as
 * over: only its 30 minutes end the activity then.
 */
export function serviceOver(place, routeId, nowMs) {
  const routes = (place?.routes ?? []).filter((route) => routeId == null || route.routeId === routeId)
  return routes.every((route) => route.hours && !runsAt(route.hours, nowMs))
}

// The reading's arrivals for the activity's route (any route without one),
// soonest first, `at` in Unix seconds.
function arrivalsFor(reading, routeId) {
  return (reading.arrivals ?? [])
    .filter((arrival) => routeId == null || arrival.routeId === routeId)
    .map((arrival) => ({ ...arrival, at: Math.floor(Date.parse(arrival.at) / 1000) }))
    .filter((arrival) => Number.isFinite(arrival.at))
    .sort((a, b) => a.at - b.at)
}

// The bus the activity follows this tick: { bus }, or { arrived: true } once the
// bus it followed has come. With nothing sent yet, the soonest. Then the same
// pass of the bus last sent (that vehicle when TransLoc names one, due no
// later than FOLLOW_SECONDS after the time last sent). That pass gone, the bus
// came if it was Arriving or due within two minutes; otherwise the soonest bus
// takes its place.
function follow(candidates, prev, nowS) {
  if (!prev) return { bus: candidates[0] ?? null }
  const pool = prev.vehicle !== null ? candidates.filter((arrival) => arrival.vehicleId === prev.vehicle) : candidates
  const pass = pool.find((arrival) => arrival.at <= prev.at + FOLLOW_SECONDS)
  if (pass) return { bus: pass }
  if (prev.phase === 'arriving' || prev.at - nowS <= 2 * ARRIVING_SECONDS) return { arrived: true }
  return { bus: candidates[0] ?? null }
}

/**
 * The content state a push carries (the module comment has its shape). `bus`
 * is an arrival from the reading while the activity runs; `route` gives an
 * end the route it last showed.
 */
export function contentState(phase, { bus = null, route = null } = {}) {
  const shown = bus ?? route
  return {
    phase,
    arrivesAt: bus ? bus.at - APPLE_EPOCH_SECONDS : null,
    routeNum: shown?.routeNum ?? null,
    routeName: shown?.routeName ?? null,
    color: shown?.color ?? null,
  }
}

// "Route 5 Purple", or as much of it as the route has.
function routeLabel(route) {
  if (route?.routeNum && route?.routeName) return `Route ${route.routeNum} ${route.routeName}`
  if (route?.routeNum) return `Route ${route.routeNum}`
  return route?.routeName || 'Your bus'
}

/**
 * What one tick does for one open activity: { action: 'none' }, or { action:
 * 'push' | 'end', state, priority, payload, expiration } with the state to
 * claim, the APNs priority, the body and the expiration in Unix seconds; an
 * end also names its `reason`. Pure.
 *
 * `reading` is the stop's arrivals answer (GET /api/transit/arrivals' shape),
 * { gone: true } when no place has the stop's key any more, or null when there
 * is no current one: then nothing is pushed, though the 30 minutes still end it.
 */
export function planLiveActivity(row, reading, nowMs) {
  const sent = parseState(row.last_state)
  const prev = sent?.phase === 'ended' ? null : sent
  const nowS = Math.floor(nowMs / 1000)
  const lastRoute = () => (prev && reading?.place ? reading.place.routes?.find((route) => route.routeId === prev.route) : null)
  const end = (reason) => ({
    action: 'end',
    reason,
    state: { phase: 'ended', reason },
    priority: PRIORITY.end,
    payload: liveActivityPayload({
      event: 'end',
      contentState: contentState(reason, { route: lastRoute() }),
      now: nowMs,
      dismissAt: nowMs + DISMISS_SECONDS * 1000,
    }),
    expiration: nowS + END_TTL_SECONDS,
  })

  if (nowMs >= Date.parse(row.ends_at)) return end('expired')
  if (!reading) return NOTHING
  if (reading.gone) return end('stop-gone')

  const followed = follow(arrivalsFor(reading, row.route_id), prev, nowS)
  if (followed.arrived) return end('arrived')
  const bus = followed.bus
  if (!bus) return serviceOver(reading.place, row.route_id, nowMs) ? end('no-service') : NOTHING
  // Arriving went out: the end comes once the bus has gone.
  if (prev?.phase === 'arriving') return NOTHING

  const state = { phase: bus.at - nowS <= ARRIVING_SECONDS ? 'arriving' : 'due', at: bus.at, vehicle: bus.vehicleId ?? null, route: bus.routeId }
  if (state.phase === 'due' && prev) {
    const moved = Math.abs(state.at - prev.at) >= MOVE_SECONDS || state.route !== prev.route
    const rested = !row.last_pushed_at || nowMs - Date.parse(row.last_pushed_at) >= PUSH_GAP_SECONDS * 1000
    if (!moved || !rested) return NOTHING
  }
  const arriving = state.phase === 'arriving'
  return {
    action: 'push',
    state,
    priority: arriving ? PRIORITY.arriving : PRIORITY.update,
    payload: liveActivityPayload({
      event: 'update',
      contentState: contentState(state.phase, { bus }),
      now: nowMs,
      staleAt: nowMs + STALE_SECONDS * 1000,
      alert: arriving ? { title: `${routeLabel(bus)} is arriving`, body: `At ${reading.place.name}`, sound: 'default' } : null,
    }),
    expiration: nowS + UPDATE_TTL_SECONDS,
  }
}

// Claim a push: last_state from the value read to the plan's (and ended_at
// for an end), unless another run changed it first. True when this run did.
async function claim(client, row, plan, now) {
  const patch = { last_state: formatState(plan.state), last_pushed_at: now.toISOString() }
  if (plan.action === 'end') patch.ended_at = now.toISOString()
  const query = client.from('live_activities').update(patch).eq('activity_id', row.activity_id).is('ended_at', null)
  const res = await (row.last_state == null ? query.is('last_state', null) : query.eq('last_state', row.last_state)).select('activity_id')
  if (res.error) throw queryError(res, 'live_activities update (claim)')
  return (res.data || []).length > 0
}

// Give a claim back after APNs did not take the push, so the next tick sends
// it again. A failure here only means that push waits for the next change.
async function release(client, row, plan, log) {
  const res = await client
    .from('live_activities')
    .update({ last_state: row.last_state, last_pushed_at: row.last_pushed_at, ended_at: null })
    .eq('activity_id', row.activity_id)
    .eq('last_state', formatState(plan.state))
  if (res.error) log.warn(`[push] live activity: a claim was not given back (${res.error.code ?? 'error'})`)
}

async function endWithoutPush(client, activityId, reason, now) {
  const res = await client
    .from('live_activities')
    .update({ ended_at: now.toISOString(), last_state: formatState({ phase: 'ended', reason }) })
    .eq('activity_id', activityId)
  if (res.error) throw queryError(res, 'live_activities update (end)')
}

async function eachLimit(items, limit, run) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * One tick for every open Live Activity: read each stop's arrivals once, plan,
 * claim and send. Returns a summary for the cron log: how many were open, the
 * updates and Arriving pushes APNs took, the ends by reason, the pushes it did
 * not take with APNs' reason codes, and `stopped` when APNs was down or
 * refused the key and the tick stopped early. Never a token or an activity id.
 * Throws a SupabaseQueryError on a database error other than the table
 * missing, so the route can tell a hiccup worth one retry from a bug.
 *
 * `send` is the APNs sender's (createApnsSender in src/apnsLiveActivity.mjs);
 * `readArrivals(stopKey)` resolves with the stop's arrivals answer through the
 * widgets' cache, or null when no place has the key, and throws when TransLoc
 * gives nothing.
 */
export async function runLiveActivities({ client, send, readArrivals, now = new Date(), log = console, maxOpen = MAX_OPEN }) {
  const summary = { ok: true, ranAt: now.toISOString(), open: 0, updates: 0, arriving: 0, ended: {}, failed: 0 }
  const res = await client.from('live_activities').select(COLUMNS).is('ended_at', null).order('ends_at', { ascending: true }).limit(maxOpen)
  if (res.error) {
    if (isMissingTableError(res.error)) {
      logSchemaMissingOnce(DB_FEATURES.live_activities, res.error)
      return { ...summary, ok: false, reason: 'not_configured' }
    }
    throw queryError(res, 'live_activities select')
  }
  const rows = res.data || []
  summary.open = rows.length

  const nowMs = now.getTime()
  const readings = new Map()
  const readingAt = (stopKey) => {
    if (!readings.has(stopKey)) {
      readings.set(
        stopKey,
        Promise.resolve()
          .then(() => readArrivals(stopKey))
          .then(
            (answer) => {
              if (answer == null) return { gone: true }
              const age = nowMs - Date.parse(answer.fetchedAt)
              return age <= READING_MAX_AGE_MS ? answer : null
            },
            () => null,
          ),
      )
    }
    return readings.get(stopKey)
  }

  const ended = (reason) => {
    summary.ended[reason] = (summary.ended[reason] ?? 0) + 1
  }
  const refusals = {}
  await eachLimit(rows, SEND_CONCURRENCY, async (row) => {
    if (summary.stopped) return
    const expired = nowMs >= Date.parse(row.ends_at)
    const plan = planLiveActivity(row, expired ? null : await readingAt(row.stop_key), nowMs)
    if (plan.action === 'none' || summary.stopped) return
    if (!(await claim(client, row, plan, now))) return
    const result = await send({ token: row.push_token, env: row.apns_env, payload: plan.payload, priority: plan.priority, expiration: plan.expiration })
    if (result.ok) {
      if (plan.action === 'end') ended(plan.reason)
      else if (plan.state.phase === 'arriving') summary.arriving += 1
      else summary.updates += 1
      return
    }
    summary.failed += 1
    refusals[result.reason] = (refusals[result.reason] ?? 0) + 1
    if (result.retry || result.status === 403) {
      // APNs is busy or down, or refuses the key: every other push would
      // fail the same way, so the tick stops and the next one sends again.
      await release(client, row, plan, log)
      summary.stopped = result.retry ? 'apns_unavailable' : 'apns_refused'
      return
    }
    // The token is gone (the app was removed, the activity ended on the
    // phone), or APNs refused this push for good: the activity is over. An end
    // claimed its row already, and counts under the reason it was sent for.
    if (plan.action === 'end') {
      ended(plan.reason)
      return
    }
    const reason = result.gone ? 'gone' : 'refused'
    await endWithoutPush(client, row.activity_id, reason, now)
    ended(reason)
  })
  if (summary.failed) summary.apns = refusals
  return summary
}

/**
 * POST /api/live-activities' write: a row with its 30-minute end, or, when the
 * app sends an activity it already registered (a retry, or a new token after a
 * relaunch) and it is still open, its token, host, stop and route replaced and
 * its end kept. Resolves with { status: 'started' | 'refreshed', endsAt } or {
 * status: 'ended' } for one already over; rejects with the database error.
 */
export async function startLiveActivity(client, activity, { userId = null, now = new Date() } = {}) {
  const fields = { push_token: activity.token, apns_env: activity.env, stop_key: activity.stop, route_id: activity.routeId }
  const endsAt = new Date(now.getTime() + LIFE_MINUTES * 60_000).toISOString()
  const inserted = await client
    .from('live_activities')
    .insert({ activity_id: activity.activityId, user_id: userId, ...fields, ends_at: endsAt })
    .select('ends_at')
    .single()
  if (!inserted.error) return { status: 'started', endsAt: inserted.data?.ends_at ?? endsAt }
  if (inserted.error.code !== '23505') throw inserted.error
  const refreshed = await client.from('live_activities').update(fields).eq('activity_id', activity.activityId).is('ended_at', null).select('ends_at')
  if (refreshed.error) throw refreshed.error
  const row = (refreshed.data || [])[0]
  return row ? { status: 'refreshed', endsAt: row.ends_at } : { status: 'ended' }
}

/**
 * PATCH /api/live-activities/:activityId's write: the open activity's new push
 * token (ActivityKit can hand the app one while the activity runs). Resolves
 * with { endsAt }, or null when no open activity has the id.
 */
export async function updateLiveActivityToken(client, activityId, token) {
  const res = await client.from('live_activities').update({ push_token: token }).eq('activity_id', activityId).is('ended_at', null).select('ends_at')
  if (res.error) throw res.error
  const row = (res.data || [])[0]
  return row ? { endsAt: row.ends_at } : null
}

/**
 * DELETE /api/live-activities/:activityId's write: the student ended it on the
 * phone, so no more pushes. Resolves with true when an open activity ended.
 */
export async function endLiveActivity(client, activityId, { now = new Date() } = {}) {
  const res = await client
    .from('live_activities')
    .update({ ended_at: now.toISOString(), last_state: formatState({ phase: 'ended', reason: 'student' }) })
    .eq('activity_id', activityId)
    .is('ended_at', null)
    .select('activity_id')
  if (res.error) throw res.error
  return (res.data || []).length > 0
}
