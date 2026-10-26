// Shared campus events ingest (issue #30): the shell around src/sharedEvents.mjs.
//
// One run fetches every enabled source a page at a time, with a second between
// pages and one retry for a page that fails transiently, and plans the rows
// with the pure core. Unless it is a dry run, it then upserts them into
// campus_events on dedupe_key and sweeps each completely fetched source of the
// rows it did not write this time. A dry run touches no database at all, so it
// works before db/supabase-campus-events.sql has run.
//
// POST /api/internal/campus-events/ingest (src/routes/campusEvents.mjs) calls
// it from the pg_cron job in db/supabase-campus-events-ingest.sql. See
// docs/campus-events-ingest.md.
//
// The downtown sources (White River State Park) are read only with
// CAMPUS_EVENTS_DOWNTOWN on, and a real run before README step 49 leaves them
// out with one log line (leaveOutDowntownWithoutStep49).

import ical from 'node-ical'
import { queryError, retryOnceIfTransient } from './cronTick.mjs'
import { DB_FEATURES, logSchemaMissingOnce } from './dbErrors.mjs'
import { isMissingColumnError } from './moderation.mjs'
import { icalText } from './scheduleSync.mjs'
import { SOURCES, campusWallClockToIso, enabledEngageSources, engageOrgLookup, planCampusEvents, summarizeRows } from './sharedEvents.mjs'
import { fetchUpstream, fetchUpstreamJson } from './upstreamFetch.mjs'

export const PAGE_SIZE = 100
// Purdue's robots.txt asks for a one-second crawl delay; every source gets it.
export const PAGE_DELAY_MS = 1000
export const PAGE_TIMEOUT_MS = 20_000
// Today's volumes are 1, 7 and 13 pages (Localist, LiveWhale, BoilerLink).
// The Events Calendar is read as its one robots-allowed page (tribePageUrl),
// and a calendar file is one file.
export const MAX_PAGES = Object.freeze({ localist: 10, livewhale: 20, engage: 30, tribe: 1, ics: 1 })
export const UPSERT_BATCH_SIZE = 500
const USER_AGENT = 'BoilerIndy campus app (+https://www.boilerindy.app)'
const CAMPUS_TIME_ZONE = 'America/Indiana/Indianapolis'
const DAY_MS = 24 * 60 * 60 * 1000

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** YYYY-MM-DD on the campus calendar, so "today" starts at local midnight. */
export function campusYmd(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (type) => parts.find((p) => p.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

// ── Page URLs, as verified on 2026-10-17, LiveWhale's on 2026-10-26 ─────────
// (docs/shared-campus-events.md)

export function localistPageUrl(source, page) {
  const url = new URL('/api/2/events', source.origin)
  url.searchParams.set('group_id', source.groupId)
  url.searchParams.set('days', String(source.days))
  url.searchParams.set('pp', String(PAGE_SIZE))
  url.searchParams.set('distinct', 'true')
  url.searchParams.set('page', String(page))
  return url.toString()
}

/**
 * The whole "IU Indianapolis" category, with no distance filter: LiveWhale's
 * `near_location` drops every listing without coordinates, which on
 * 2026-10-26 was 304 of the 647 in the window (every athletics listing among
 * them). The Indianapolis rules in src/sharedEvents.mjs place each listing
 * instead.
 */
export function liveWhalePageUrl(source, page, now) {
  const path = [
    'live/json/events',
    'category', encodeURIComponent(source.category),
    'start_date', campusYmd(now),
    'end_date', campusYmd(new Date(now.getTime() + source.days * DAY_MS)),
    'response_fields', 'location,tags,summary,group_title,event_types',
  ].join('/')
  return `${source.origin}/${path}?page=${page}`
}

export function engagePageUrl(source, skip, now) {
  const url = new URL('/api/discovery/event/search', source.origin)
  url.searchParams.set('endsAfter', now.toISOString())
  url.searchParams.set('orderByField', 'endsOn')
  url.searchParams.set('orderByDirection', 'ascending')
  url.searchParams.set('status', 'Approved')
  url.searchParams.set('take', String(PAGE_SIZE))
  url.searchParams.set('skip', String(skip))
  url.searchParams.set('query', '')
  return url.toString()
}

/**
 * The Events Calendar's event list, with no query string: White River State
 * Park's robots.txt disallows every URL with one (`Disallow: /*?`). Without
 * one the site answers its defaults, every upcoming listing for two years, 50
 * a page (27 on one page on 2026-10-24), and the ingest keeps its own window
 * (inTribeWindow).
 */
export function tribePageUrl(source) {
  return new URL('/wp-json/tribe/events/v1/events', source.origin).toString()
}

/**
 * Whether a listing of The Events Calendar is in the window a query string
 * would have asked for (`start_date=<today>&end_date=<today + days>`): not
 * over before today on the campus calendar, and starting within the source's
 * `days`. Its dates are campus wall-clock times ("2026-11-21 00:00:00"), so
 * they compare as text. One without a readable start is kept, for the plan to
 * count it as skipped.
 */
export function inTribeWindow(raw, source, now) {
  const start = String(raw?.start_date ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return true
  const end = String(raw?.end_date || start).slice(0, 10)
  return end >= campusYmd(now) && start <= campusYmd(new Date(now.getTime() + source.days * DAY_MS))
}

/** A calendar file's URL: the source's own path on its origin. */
export function icsPageUrl(source) {
  return new URL(source.path, source.origin).toString()
}

const pad2 = (value) => String(value).padStart(2, '0')

// node-ical builds a date-only value (DTSTART;VALUE=DATE) at local midnight of
// the process's own time zone, which is UTC on Render, so its local parts are
// the date as written: that date's midnight on the campus clock.
function icsInstant(date, allDay) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  if (!allDay) return date.toISOString()
  return campusWallClockToIso(`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} 00:00:00`)
}

/**
 * The events of a calendar file as plain listings for normalizeIcsEvent in
 * src/sharedEvents.mjs: `uid`, `summary`, `description`, `location`, `url`,
 * `start` and `end` as ISO (an all-day one at campus midnight, its end the
 * next day's as the file writes it), `allDay` and `status`. Null for text that
 * is not a calendar. A repeating event gives its first occurrence: Sidearm's
 * schedule has none.
 */
export function icsListings(text) {
  if (typeof text !== 'string' || !/^\s*BEGIN:VCALENDAR/.test(text)) return null
  let parsed
  try {
    parsed = ical.sync.parseICS(text)
  } catch {
    return null
  }
  const listings = []
  for (const event of Object.values(parsed)) {
    if (event?.type !== 'VEVENT') continue
    const allDay = event.datetype === 'date' || event.start?.dateOnly === true
    listings.push({
      uid: icalText(event.uid),
      summary: icalText(event.summary),
      description: icalText(event.description),
      location: icalText(event.location),
      url: icalText(event.url),
      start: icsInstant(event.start, allDay),
      end: icsInstant(event.end, allDay),
      allDay,
      status: icalText(event.status),
    })
  }
  return listings
}

/**
 * Whether a calendar file's event is in the source's window: not over before
 * today on the campus calendar, and starting within `days`. Sidearm's file is
 * the whole season, played games included. One without a readable start is
 * kept, for the plan to count it as skipped.
 */
export function inIcsWindow(raw, source, now) {
  if (!raw?.start || Number.isNaN(Date.parse(raw.start))) return true
  const end = raw.end && !Number.isNaN(Date.parse(raw.end)) ? raw.end : raw.start
  return Date.parse(end) >= Date.parse(campusWallClockToIso(`${campusYmd(now)} 00:00:00`)) && Date.parse(raw.start) <= now.getTime() + source.days * DAY_MS
}

// Per platform: the URL of page `index` (from 0), and what a page body holds.
// `read` answers null for a body that is not the platform's JSON (or, for a
// `text` platform, its text).
const PLATFORMS = {
  localist: {
    url: (source, index) => localistPageUrl(source, index + 1),
    read: (body, index) => {
      if (!Array.isArray(body?.events)) return null
      const total = Number(body.page?.total)
      return { items: body.events.map((wrapper) => wrapper?.event).filter(Boolean), more: Number.isFinite(total) && index + 1 < total }
    },
  },
  livewhale: {
    url: (source, index, now) => liveWhalePageUrl(source, index + 1, now),
    read: (body, index) => {
      if (!Array.isArray(body?.data)) return null
      const total = Number(body.meta?.total_pages)
      return { items: body.data, more: Number.isFinite(total) && index + 1 < total }
    },
  },
  engage: {
    url: (source, index, now) => engagePageUrl(source, index * PAGE_SIZE, now),
    read: (body, index) => {
      if (!Array.isArray(body?.value)) return null
      const total = Number(body['@odata.count'])
      return { items: body.value, more: Number.isFinite(total) && (index + 1) * PAGE_SIZE < total }
    },
  },
  // One page only (MAX_PAGES.tribe): a second one would need `?page=`, which
  // robots.txt disallows, so a list that outgrows it reads as incomplete.
  tribe: {
    url: (source) => tribePageUrl(source),
    read: (body, index) => {
      if (!Array.isArray(body?.events)) return null
      const total = Number(body.total_pages)
      return { items: body.events, more: Number.isFinite(total) && index + 1 < total }
    },
    keep: inTribeWindow,
  },
  // A calendar file, read as text: the whole of it in one request.
  ics: {
    text: true,
    accept: 'text/calendar',
    url: (source) => icsPageUrl(source),
    read: (body) => {
      const items = icsListings(body)
      return items ? { items, more: false } : null
    },
    keep: inIcsWindow,
  },
}

/**
 * Every listing of one source, page by page. Never throws: a page that fails
 * twice, or answers something that is not the platform's JSON, ends the fetch
 * with `complete: false` and the error, keeping the listings already read.
 */
export async function fetchSourceListings(
  source,
  { fetchImpl = globalThis.fetch, now = new Date(), sleep = wait, pageDelayMs = PAGE_DELAY_MS, timeoutMs = PAGE_TIMEOUT_MS, log = console } = {},
) {
  const platform = PLATFORMS[source.platform]
  const maxPages = MAX_PAGES[source.platform]
  const listings = []
  let pages = 0
  for (let index = 0; index < maxPages; index += 1) {
    if (index > 0) await sleep(pageDelayMs)
    const url = platform.url(source, index, now)
    let body
    const init = { headers: { accept: platform.accept || 'application/json', 'user-agent': USER_AGENT } }
    try {
      body = await retryOnceIfTransient(
        `[campus-events] ${source.key} page ${index + 1}`,
        () =>
          platform.text
            ? fetchUpstream(source.key, url, { init, timeoutMs, fetchImpl }).then((response) => response.text())
            : fetchUpstreamJson(source.key, url, { init, timeoutMs, fetchImpl }),
        { log, sleep },
      )
    } catch (error) {
      return { listings, pages, complete: false, error: String(error?.message || error) }
    }
    const page = platform.read(body, index)
    if (!page) {
      const expected = platform.text ? 'a calendar file' : 'its JSON'
      return { listings, pages, complete: false, error: `${source.key} answered something other than ${expected} on page ${index + 1}` }
    }
    pages += 1
    // A platform asked for no window (The Events Calendar) keeps the listings inside one.
    listings.push(...(platform.keep ? page.items.filter((raw) => platform.keep(raw, source, now)) : page.items))
    if (!page.more || page.items.length === 0) return { listings, pages, complete: true, error: null }
  }
  return { listings, pages, complete: false, error: `${source.key} has more than ${maxPages} page${maxPages === 1 ? '' : 's'}` }
}

// ── Writes ──────────────────────────────────────────────────────────────────

const withoutOrganizationKey = (rows) => rows.map(({ organization_key: _organizationKey, ...row }) => row)

/**
 * Upsert on dedupe_key, in batches. A row carries `classifier` only when a
 * classifier answered for it; supabase-js writes NULL for a key one row of a
 * batch lacks, so rows with and without it go in separate batches and a
 * stored verdict is never erased by a row that has none.
 *
 * organization_key is a column README step 48 adds (db/supabase-club-follows.sql).
 * Until it runs, the first batch that names it fails on the missing column:
 * the log names the file once, that batch and every later one go up without
 * it, and `organizationKeys` answers 'column_missing' instead of 'written'.
 */
async function upsertRows(client, rows, { log, sleep }) {
  const groups = [rows.filter((row) => !('classifier' in row)), rows.filter((row) => 'classifier' in row)]
  let upserted = 0
  let organizationKeys = 'written'
  const upsert = (batch) => client.from('campus_events').upsert(batch, { onConflict: 'dedupe_key' })
  for (const group of groups) {
    for (let i = 0; i < group.length; i += UPSERT_BATCH_SIZE) {
      const batch = group.slice(i, i + UPSERT_BATCH_SIZE)
      await retryOnceIfTransient(
        '[campus-events] upsert',
        async () => {
          let result = await upsert(organizationKeys === 'written' ? batch : withoutOrganizationKey(batch))
          if (result.error && organizationKeys === 'written' && isMissingColumnError(result.error, 'organization_key')) {
            logSchemaMissingOnce(DB_FEATURES.club_follows, result.error)
            organizationKeys = 'column_missing'
            result = await upsert(withoutOrganizationKey(batch))
          }
          if (result.error) throw queryError(result, 'campus_events upsert')
        },
        { log, sleep },
      )
      upserted += batch.length
    }
  }
  return { upserted, organizationKeys }
}

/**
 * Delete a source's rows this run did not write: whatever it no longer lists,
 * or now drops as not in Indianapolis or as a copy of another source's row.
 * Only after a complete fetch with listings in it, since an outage or an empty
 * answer would otherwise wipe the source. A failed sweep is logged and left to
 * the next run, as calendarItemStore does: a stale row beats a lost write.
 */
async function sweepSource(client, sourceKey, runAt, { log }) {
  const result = await client.from('campus_events').delete({ count: 'exact' }).eq('source_key', sourceKey).lt('last_seen_at', runAt)
  if (result.error) {
    const error = queryError(result, 'campus_events sweep')
    log.error(`[campus-events] sweep of ${sourceKey} failed:`, error.message)
    return { swept: 0, sweepError: error.message }
  }
  return { swept: result.count ?? 0 }
}

// ── Downtown (README step 49) ───────────────────────────────────────────────

// db/supabase-campus-events-downtown.sql, README step 49, widens the CHECK on
// campus_events.venue_kind to allow 'downtown'.
export const DOWNTOWN_SQL_FILE = 'db/supabase-campus-events-downtown.sql'
const DOWNTOWN_KEYS = new Set(SOURCES.filter((source) => source.downtown).map((source) => source.key))

/** Postgres refusing a downtown row: the CHECK on venue_kind, before README step 49. */
export function isDowntownCheckViolation(error) {
  return String(error?.code ?? '') === '23514' && /\bcampus_events_venue_kind_check\b/.test(String(error?.message ?? ''))
}

/**
 * Before README step 49 a downtown row fails the CHECK on venue_kind, and the
 * whole batch with it. So one goes up alone first. When the CHECK refuses it,
 * the run leaves the downtown sources out (none of their rows, no sweep), says
 * so in one log line and in their entries of the summary, and writes the other
 * sources as before. Once step 49 has run, that row is simply written, and
 * again with the rest. Resolves with the rows still to write; any other
 * failure rejects, as a failed write does.
 *
 * A downtown source keeps its listings as venue_kind 'downtown' unless they
 * are online (sharedEvents.buildEvent), and Jev never changes a known venue,
 * so its first row that is not online is a downtown one.
 */
async function leaveOutDowntownWithoutStep49(client, rows, { summary, fetched, runAt, log, sleep }) {
  const probe = rows.find((row) => DOWNTOWN_KEYS.has(row.source_key) && row.venue_kind !== 'online')
  if (!probe) return rows
  try {
    await upsertRows(client, [{ ...probe, last_seen_at: runAt }], { log, sleep })
    return rows
  } catch (error) {
    if (!isDowntownCheckViolation(error)) throw error
  }
  const reason = `left out: campus_events does not allow venue_kind 'downtown' until ${DOWNTOWN_SQL_FILE} (README step 49) has run`
  // A downtown source whose fetch already failed keeps its own error.
  const left = summary.sources.filter((entry) => entry.enabled && entry.ok && DOWNTOWN_KEYS.has(entry.key))
  for (const entry of left) {
    Object.assign(entry, { ok: false, error: reason, schemaMissing: DOWNTOWN_SQL_FILE })
    // Not swept: a failed source never is.
    fetched.set(entry.key, { ...fetched.get(entry.key), error: reason })
  }
  log.warn(`[campus-events] ${left.map((entry) => entry.key).join(', ')} ${reason}: run it in the Supabase SQL Editor.`)
  const kept = rows.filter((row) => !DOWNTOWN_KEYS.has(row.source_key))
  summary.totals = summarizeRows(kept)
  return kept
}

// ── One run ─────────────────────────────────────────────────────────────────

/**
 * Fetch, plan and (unless `dryRun`) write. Resolves with the run's summary:
 * per source whether it was enabled, fetched completely and how its listings
 * fared (sharedEvents.planCampusEvents), the cross-source collapses, a sample
 * of the dropped listings, totals, and either the rows a real run would write
 * (dry run) or what was upserted and swept, with `organizationKeys` saying
 * whether organization_key was written or its column is still missing. A
 * source that fails is reported and the run goes on; a database failure
 * rejects (after one retry when it is transient), and the route answers it.
 *
 * `engageEnabled` picks the Engage sources: `true` for BoilerLink and TheSpot,
 * a list of their keys for some (engageSourcesFromSetting reads
 * CAMPUS_EVENTS_ENGAGE), anything else for neither.
 *
 * `classify` is the Jev hook (src/campusEventsClassify.mjs, with
 * CAMPUS_EVENTS_CLASSIFY on): an async function given the planned rows and
 * `{ client, sourceFreeFood, log, sleep }` that resolves with the rows, where
 * it may have set category, free_food, venue_kind and open_to_all and added
 * `classifier`, or with `{ rows, summary }`, the summary reported as
 * `classify`. A dry run skips it: it would read the stored verdicts, and a dry
 * run touches no database.
 *
 * `downtownEnabled` (CAMPUS_EVENTS_DOWNTOWN) adds the downtown sources, White
 * River State Park's calendar; off, they are neither fetched nor in the
 * summary, so the run is the one before they existed. A real run before README
 * step 49 leaves them out (leaveOutDowntownWithoutStep49).
 */
export async function runCampusEventsIngest({
  client,
  dryRun = false,
  engageEnabled = false,
  downtownEnabled = false,
  clubs = [],
  classify = null,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  sleep = wait,
  pageDelayMs = PAGE_DELAY_MS,
  log = console,
} = {}) {
  if (!dryRun && !client) throw new Error('runCampusEventsIngest needs a client unless it is a dry run')
  const startedAt = Date.now()
  const runAt = now.toISOString()

  const engage = enabledEngageSources(engageEnabled)
  const fetched = new Map()
  for (const source of SOURCES) {
    if (source.engage && !engage.has(source.key)) continue
    if (source.downtown && !downtownEnabled) continue
    fetched.set(source.key, await fetchSourceListings(source, { fetchImpl, now, sleep, pageDelayMs, log }))
  }
  const plan = planCampusEvents(
    Object.fromEntries([...fetched].map(([key, result]) => [key, result.listings])),
    { isIndianapolisOrg: engageOrgLookup(clubs) },
  )
  let rows = plan.rows
  let classified = null
  if (typeof classify === 'function') {
    if (dryRun) {
      classified = { skipped: 'dry run' }
    } else {
      const result = await classify(rows, { client, sourceFreeFood: plan.sourceFreeFood, log, sleep })
      rows = Array.isArray(result) ? result : result?.rows
      if (!Array.isArray(rows)) throw new Error('classify must resolve with the rows')
      classified = Array.isArray(result) ? null : (result.summary ?? null)
    }
  }

  const planned = new Map(plan.sources.map((stats) => [stats.key, stats]))
  const sources = SOURCES.filter((source) => downtownEnabled || !source.downtown).map((source) => {
    const result = fetched.get(source.key)
    if (!result) return { key: source.key, enabled: false }
    const { key, ...stats } = planned.get(source.key)
    return { key, enabled: true, ok: !result.error, complete: result.complete, pages: result.pages, error: result.error, ...stats }
  })
  // The totals count what is written, so after a classifier they are recounted.
  const totals = rows === plan.rows ? plan.totals : summarizeRows(rows)
  const summary = { ok: true, dryRun: Boolean(dryRun), startedAt: runAt, sources, collapsed: plan.collapsed, dropped: plan.dropped, totals }
  if (classified) summary.classify = classified

  if (dryRun) return { ...summary, rows, durationMs: Date.now() - startedAt }
  rows = await leaveOutDowntownWithoutStep49(client, rows, { summary, fetched, runAt, log, sleep })

  const { upserted, organizationKeys } = await upsertRows(client, rows.map((row) => ({ ...row, last_seen_at: runAt })), { log, sleep })
  for (const entry of sources) {
    const result = fetched.get(entry.key)
    if (!result || result.error || !result.complete || result.listings.length === 0) continue
    Object.assign(entry, await sweepSource(client, entry.key, runAt, { log }))
  }
  return { ...summary, upserted, organizationKeys, durationMs: Date.now() - startedAt }
}
