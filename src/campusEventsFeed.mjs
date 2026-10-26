// campusEventsFeed.mjs
//
// The read side of the shared campus events (issue #30, rollout step 4 in
// docs/shared-campus-events.md): which campus_events rows a student's calendar
// read lists, and in what shape. The ingest (src/campusEventsIngest.mjs) fills
// the table every 6 hours from Purdue's and IU's public events calendars, and
// with CAMPUS_EVENTS_DOWNTOWN on from White River State Park's, whose rows are
// labeled Downtown and listed only while that switch is on (applyDowntownSwitch);
// listCalendarItems (src/calendarReads.mjs) merges what this module reads with
// the student's own calendar_items rows. The signed-out Free Food page reads
// the free-food rows alone through GET /api/campus-events/free-food
// (src/routes/campusEvents.mjs, issue #366), with no session and so no
// student's rows. Behind CAMPUS_EVENTS_FEED, off by default: server.mjs builds
// the calendar reads and the public router with the switch, and with it off
// nothing here runs. docs/campus-events-feed.md is the operator's view.
//
// Every row says which club listed it (`organizationKey`), and on a student's
// read whether the student follows that club (`followed`, issue #16,
// src/clubFollows.mjs). Both come from README step 48: until it runs every
// `organizationKey` is null and no row carries `followed`.

import { readFollowedKeys } from './clubFollows.mjs'
import { DB_FEATURES, isSchemaMissingError, logRouteError, logSchemaMissingOnce } from './dbErrors.mjs'
import { isMissingColumnError } from './moderation.mjs'
import { selectUpTo } from './pagedSelect.mjs'
import { DOWNTOWN_SOURCE_KEYS, campusDay, duplicateReason, httpUrlOrNull } from './sharedEvents.mjs'

/** The calendar categories a shared row is listed under: Purdue's official dates are deadlines, the rest campus events. */
export const SHARED_CALENDAR_CATEGORIES = Object.freeze(['campus_event', 'deadline'])

// venue_kind values a student here cannot get to on foot: a West Lafayette
// listing (Purdue's group carries Mackey Arena) or one in another city (an
// Indianapolis club's away game).
export const HIDDEN_VENUE_KINDS = Object.freeze(['elsewhere', 'west_lafayette'])

// The ingest stamps last_seen_at on every row it writes, every 6 hours, and
// sweeps a source only after a complete fetch of it. A row no run has written
// for 26 hours (four missed runs and two hours' grace) belongs to a source that
// has been failing for a day, or to a listing nothing sweeps any more, so it is
// treated as gone: it may have been cancelled or moved since.
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000

// A cap on one read, well past today's volumes (299 rows with Engage off,
// about 1,300 with it on); selectUpTo pages it past PostgREST's max-rows.
export const SHARED_EVENTS_MAX_ROWS = 3000

// A cap on the signed-out free-food read (issue #366), well past today's
// volumes (5 listed rows with free food on 2026-10-17), in one page.
export const PUBLIC_FREE_FOOD_MAX_ROWS = 500

// Where a row comes from, in the words the page shows. IU Indianapolis's own
// listings say so: whether they are open to Purdue students is the owner's
// call on #30, so they read as IU events until it is made. IU Indy athletics'
// home games read as the Jaguars'. White River State Park's read as Downtown,
// so a museum night never reads as a campus event.
export const SOURCE_LABELS = Object.freeze({
  purdue_events: 'Purdue event',
  iu_events: 'IU event',
  boilerlink: 'BoilerLink',
  thespot: 'TheSpot (IU)',
  iu_athletics: 'Jaguars (IU)',
  wrsp_events: 'Downtown',
})

/**
 * The shared items a read lists under CAMPUS_EVENTS_DOWNTOWN: all of them
 * while it is on; with it off none from a downtown source, so every read
 * answers what it did before that source existed, rows a run wrote while the
 * switch was on included. Pure.
 * @param {object[]} items shared calendar items (toSharedCalendarItem)
 * @param {boolean} downtownEnabled
 * @returns {object[]}
 */
export function applyDowntownSwitch(items, downtownEnabled) {
  return downtownEnabled ? items : items.filter((item) => !DOWNTOWN_SOURCE_KEYS.includes(item.sourceKey))
}

// A calendar item as duplicateReason reads it.
function itemView(item) {
  return {
    title: item.title,
    startsAt: new Date(item.startTime).toISOString(),
    allDay: Boolean(item.allDay),
    location: item.location,
    deadline: item.category === 'deadline',
  }
}

/**
 * The student's own rows and the shared rows a calendar read lists beside
 * them, without a shared row that is one event with one of the student's
 * (duplicateReason in src/sharedEvents.mjs, the rule the ingest collapses its
 * sources by): a career fair the student imported from a club's feed shows
 * once. The student's row stays, since it is theirs and the other readers of
 * the calendar see it, and takes the shared row's free food, so the Free Food
 * page still lists the event. Only rows of one campus day are compared. Pure.
 * @param {object[]} own the student's calendar items
 * @param {object[]} shared shared calendar items (toSharedCalendarItem)
 * @returns {{ own: object[], shared: object[] }}
 */
export function withoutOwnDuplicates(own, shared) {
  if (own.length === 0 || shared.length === 0) return { own, shared }
  const ownByDay = new Map()
  own.forEach((item, index) => {
    if (Number.isNaN(Date.parse(item.startTime))) return
    const view = itemView(item)
    const day = campusDay(view.startsAt)
    if (!ownByDay.has(day)) ownByDay.set(day, [])
    ownByDay.get(day).push({ index, view })
  })
  const freeFood = new Set()
  const listed = []
  for (const item of shared) {
    const view = Number.isNaN(Date.parse(item.startTime)) ? null : itemView(item)
    const match = view && (ownByDay.get(campusDay(view.startsAt)) ?? []).find((entry) => duplicateReason(entry.view, view))
    if (!match) {
      listed.push(item)
      continue
    }
    if (item.freeFood) freeFood.add(match.index)
  }
  if (listed.length === shared.length) return { own, shared }
  return {
    own: own.map((item, index) => (freeFood.has(index) && !item.freeFood ? { ...item, freeFood: true } : item)),
    shared: listed,
  }
}

const COLUMNS =
  'id, title, description, starts_at, ends_at, location, all_day, source_key, source_url, category, free_food, venue_kind, open_to_all, series_key, last_seen_at'
// organization_key is README step 48's (db/supabase-club-follows.sql); the
// reads ask for it and fall back to COLUMNS while it is missing.
const COLUMNS_WITH_ORGANIZATION = `${COLUMNS}, organization_key`
const DAY_MS = 24 * 60 * 60 * 1000

/** The calendar category a campus_events category is listed under. */
export function sharedCalendarCategory(category) {
  return category === 'deadline' ? 'deadline' : 'campus_event'
}

/**
 * The shared categories a calendar read with this filter asks for, with the
 * precedence listCalendarItems gives its own filter: `category` wins over
 * `categories`, and a read with neither asks for both.
 * @param {{ category?: string | null, categories?: string[] | null }} [filter]
 * @returns {string[]}
 */
export function sharedCategoriesFor({ category = null, categories = null } = {}) {
  const asked = category ? [category] : categories?.length ? categories : null
  return SHARED_CALENDAR_CATEGORIES.filter((key) => !asked || asked.includes(key))
}

// When a row stops being worth listing: its end; an all-day row with no end
// runs to the end of its day (the ingest's endOf); any other row, its start.
function endMs(row) {
  if (row.ends_at) return Date.parse(row.ends_at)
  const start = Date.parse(row.starts_at)
  return row.all_day ? start + DAY_MS : start
}

function byStartThenId(a, b) {
  return Date.parse(a.starts_at) - Date.parse(b.starts_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * One campus_events row in the client shape of listCalendarItems, marked
 * `shared: true`, plus where it came from: `sourceKey`, the label the page
 * shows (SOURCE_LABELS), the listing to link out to, http(s) only, and the
 * club that listed it (`organizationKey`, null for the Purdue and IU
 * calendars). The id is prefixed so it can never be taken for one of the
 * student's calendar_items, the only rows a task can be marked done on.
 *
 * With `followedKeys`, the organization keys a student follows, the row also
 * says whether it is one of theirs (`followed`). Without them, on the
 * signed-out read or when the follows could not be read (README step 48 not
 * run), the row carries no `followed` at all, so a client can tell "not
 * followed" from "not known". Fields are only ever added here: the native app
 * reads these rows too.
 * @param {object} row a campus_events row
 * @param {{ followedKeys?: Set<string> | null }} [options]
 */
export function toSharedCalendarItem(row, { followedKeys = null } = {}) {
  const organizationKey = typeof row.organization_key === 'string' && row.organization_key ? row.organization_key : null
  return {
    id: `campus:${row.id}`,
    sourceId: null,
    title: row.title,
    description: row.description ?? null,
    startTime: row.starts_at,
    endTime: row.ends_at ?? null,
    location: row.location ?? null,
    category: sharedCalendarCategory(row.category),
    externalUid: null,
    sourceType: 'campus',
    allDay: Boolean(row.all_day),
    freeFood: Boolean(row.free_food),
    shared: true,
    sourceKey: row.source_key,
    sourceLabel: SOURCE_LABELS[row.source_key] || 'Campus calendar',
    sourceUrl: httpUrlOrNull(row.source_url),
    organizationKey,
    ...(followedKeys ? { followed: organizationKey !== null && followedKeys.has(organizationKey) } : {}),
  }
}

/**
 * The shared rows a calendar read lists, as calendar items, soonest first:
 *
 *   - written by the ingest within STALE_AFTER_MS of `now`;
 *   - not over by `since` (now, or a later `from`), so a row still running,
 *     such as a gallery exhibit open for weeks, is listed;
 *   - not at a venue in HIDDEN_VENUE_KINDS, and not a members-only session
 *     (open_to_all false: a practice, a rehearsal, an officer meeting);
 *   - under one of `categories`, as sharedCalendarCategory maps them;
 *   - one per series_key, its next occurrence, so a weekly class shows once.
 *
 * `followedKeys` marks the rows of the clubs a student follows
 * (toSharedCalendarItem); it never changes which rows are listed.
 *
 * Pure: listSharedCalendarItems reads the rows and passes the clock.
 * @param {object[]} rows campus_events rows
 * @param {{ now?: Date, since?: Date, categories?: readonly string[], followedKeys?: Set<string> | null }} [options]
 */
export function planSharedCalendarItems(
  rows,
  { now = new Date(), since = now, categories = SHARED_CALENDAR_CATEGORIES, followedKeys = null } = {},
) {
  const freshFrom = now.getTime() - STALE_AFTER_MS
  const notOverBy = Math.max(now.getTime(), since.getTime())
  const listed = (rows || []).filter(
    (row) =>
      Date.parse(row.last_seen_at) >= freshFrom &&
      endMs(row) >= notOverBy &&
      !HIDDEN_VENUE_KINDS.includes(row.venue_kind) &&
      row.open_to_all !== false &&
      categories.includes(sharedCalendarCategory(row.category)),
  )
  const bySeries = new Map()
  for (const row of listed.sort(byStartThenId)) {
    const key = row.series_key || `row:${row.id}`
    if (!bySeries.has(key)) bySeries.set(key, row)
  }
  return [...bySeries.values()].map((row) => toSharedCalendarItem(row, { followedKeys }))
}

// The rows a read may list, narrowed in the database by the rules the plan
// applies again: fresh, no hidden venue, no members-only session, and an end
// from now on or a start within the last day (an all-day row with no end).
function listableRowsQuery(supabase, now, columns) {
  return supabase
    .from('campus_events')
    .select(columns)
    .gte('last_seen_at', new Date(now.getTime() - STALE_AFTER_MS).toISOString())
    .or(`ends_at.gte.${now.toISOString()},starts_at.gte.${new Date(now.getTime() - DAY_MS).toISOString()}`)
    .not('venue_kind', 'in', `(${HIDDEN_VENUE_KINDS.join(',')})`)
    .not('open_to_all', 'is', false)
}

/**
 * selectUpTo over `buildQuery(columns)` with organization_key, and again
 * without it while README step 48 has not added the column, the log naming
 * db/supabase-club-follows.sql once. Every row then reads as listed by no club.
 */
async function selectListableRows(buildQuery, maxRows) {
  const result = await selectUpTo(() => buildQuery(COLUMNS_WITH_ORGANIZATION), maxRows)
  if (!result.error || !isMissingColumnError(result.error, 'organization_key')) return result
  logSchemaMissingOnce(DB_FEATURES.club_follows, result.error)
  return selectUpTo(() => buildQuery(COLUMNS), maxRows)
}

/**
 * Read the shared rows for one calendar read and plan them
 * (planSharedCalendarItems). The query narrows by the same rules, so the read
 * stays small: fresh rows, no hidden venue, no members-only session, and an
 * end from now on or a start within the last day (an all-day row with no end).
 *
 * Never throws. Shared rows add to a student's own calendar, so a failed read
 * answers [] and the calendar shows the student's rows alone. A missing table
 * (README step 43 not run yet) is logged once with the file to run, any other
 * failure on every read.
 *
 * With `userId`, the clubs that student follows are read alongside
 * (readFollowedKeys) and every row says whether it is one of theirs
 * (`followed`); without the follows (README step 48 not run, a failed read)
 * no row carries `followed`.
 *
 * @param {object} supabase the Supabase client
 * @param {{ categories?: readonly string[], from?: string | null, now?: Date, userId?: string | null }} [options]
 *   from: the read's own lower bound; a later one than now also drops the shared rows over by then
 * @returns {Promise<object[]>}
 */
export async function listSharedCalendarItems(
  supabase,
  { categories = SHARED_CALENDAR_CATEGORIES, from = null, now = new Date(), userId = null } = {},
) {
  if (!categories.length) return []
  const buildQuery = (columns) =>
    listableRowsQuery(supabase, now, columns).order('starts_at', { ascending: true }).order('id', { ascending: true })
  const [{ data, error }, followedKeys] = await Promise.all([
    selectListableRows(buildQuery, SHARED_EVENTS_MAX_ROWS),
    userId ? readFollowedKeys(supabase, userId) : null,
  ])
  if (error) {
    if (isSchemaMissingError(error)) logSchemaMissingOnce(DB_FEATURES.campus_events, error)
    else logRouteError('campus_events read', error)
    return []
  }
  const fromMs = from ? Date.parse(from) : NaN
  const since = fromMs > now.getTime() ? new Date(fromMs) : now
  return planSharedCalendarItems(data, { now, since, categories, followedKeys })
}

// ── The signed-out free-food read (issue #366) ──────────────────────────────

/**
 * What GET /api/campus-events/free-food lists, as calendar items: the rows
 * with free_food true, planned by the rules of the signed-in read
 * (planSharedCalendarItems: fresh, not over, reachable, open to all, once per
 * series), both categories, as the Free Food window asks. A row without free
 * food never comes back, whatever the rows hold. Pure.
 * @param {object[]} rows campus_events rows
 * @param {{ now?: Date }} [options]
 */
export function planPublicFreeFoodItems(rows, { now = new Date() } = {}) {
  return planSharedCalendarItems((rows || []).filter((row) => row.free_food === true), { now })
}

/**
 * Read the rows for GET /api/campus-events/free-food: listSharedCalendarItems's
 * query narrowed to free_food = true. It reads campus_events alone, never a
 * student's calendar_items, and unlike that read it throws on a failure: an
 * empty answer would tell every visitor, and the edge cache, that there is no
 * free food when the read had failed. The rows are planned per request
 * (planPublicFreeFoodItems), so a cached copy still drops what is over.
 * @param {object} supabase the Supabase client
 * @param {{ now?: Date }} [options]
 * @returns {Promise<object[]>} campus_events rows
 */
export async function readPublicFreeFoodRows(supabase, { now = new Date() } = {}) {
  const buildQuery = (columns) =>
    listableRowsQuery(supabase, now, columns).eq('free_food', true).order('starts_at', { ascending: true }).order('id', { ascending: true })
  const { data, error } = await selectListableRows(buildQuery, PUBLIC_FREE_FOOD_MAX_ROWS)
  if (error) throw error
  return data || []
}
