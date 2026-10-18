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

import { queryError, retryOnceIfTransient } from './cronTick.mjs'
import { CAMPUS, SOURCES, enabledEngageSources, engageOrgLookup, planCampusEvents, summarizeRows } from './sharedEvents.mjs'
import { fetchUpstreamJson } from './upstreamFetch.mjs'

export const PAGE_SIZE = 100
// Purdue's robots.txt asks for a one-second crawl delay; every source gets it.
export const PAGE_DELAY_MS = 1000
export const PAGE_TIMEOUT_MS = 20_000
// Today's volumes are 1, 4 and 13 pages (Localist, LiveWhale, BoilerLink).
export const MAX_PAGES = Object.freeze({ localist: 10, livewhale: 20, engage: 30 })
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

// ── Page URLs, as verified on 2026-10-17 (docs/shared-campus-events.md) ─────

export function localistPageUrl(source, page) {
  const url = new URL('/api/2/events', source.origin)
  url.searchParams.set('group_id', source.groupId)
  url.searchParams.set('days', String(source.days))
  url.searchParams.set('pp', String(PAGE_SIZE))
  url.searchParams.set('distinct', 'true')
  url.searchParams.set('page', String(page))
  return url.toString()
}

export function liveWhalePageUrl(source, page, now) {
  const path = [
    'live/json/events',
    'category', encodeURIComponent(source.category),
    'near_location', `${CAMPUS.lat},${CAMPUS.lon}`,
    'near_distance', String(source.nearMiles),
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

// Per platform: the URL of page `index` (from 0), and what a page body holds.
// `read` answers null for a body that is not the platform's JSON.
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
    try {
      body = await retryOnceIfTransient(
        `[campus-events] ${source.key} page ${index + 1}`,
        () => fetchUpstreamJson(source.key, url, { init: { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, timeoutMs, fetchImpl }),
        { log, sleep },
      )
    } catch (error) {
      return { listings, pages, complete: false, error: String(error?.message || error) }
    }
    const page = platform.read(body, index)
    if (!page) return { listings, pages, complete: false, error: `${source.key} answered something other than its JSON on page ${index + 1}` }
    pages += 1
    listings.push(...page.items)
    if (!page.more || page.items.length === 0) return { listings, pages, complete: true, error: null }
  }
  return { listings, pages, complete: false, error: `${source.key} has more than ${maxPages} pages` }
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Upsert on dedupe_key, in batches. A row carries `classifier` only when a
 * classifier answered for it; supabase-js writes NULL for a key one row of a
 * batch lacks, so rows with and without it go in separate batches and a
 * stored verdict is never erased by a row that has none.
 */
async function upsertRows(client, rows, { log, sleep }) {
  const groups = [rows.filter((row) => !('classifier' in row)), rows.filter((row) => 'classifier' in row)]
  let upserted = 0
  for (const group of groups) {
    for (let i = 0; i < group.length; i += UPSERT_BATCH_SIZE) {
      const batch = group.slice(i, i + UPSERT_BATCH_SIZE)
      await retryOnceIfTransient(
        '[campus-events] upsert',
        async () => {
          const result = await client.from('campus_events').upsert(batch, { onConflict: 'dedupe_key' })
          if (result.error) throw queryError(result, 'campus_events upsert')
        },
        { log, sleep },
      )
      upserted += batch.length
    }
  }
  return upserted
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

// ── One run ─────────────────────────────────────────────────────────────────

/**
 * Fetch, plan and (unless `dryRun`) write. Resolves with the run's summary:
 * per source whether it was enabled, fetched completely and how its listings
 * fared (sharedEvents.planCampusEvents), the cross-source collapses, a sample
 * of the dropped listings, totals, and either the rows a real run would write
 * (dry run) or what was upserted and swept. A source that fails is reported
 * and the run goes on; a database failure rejects (after one retry when it is
 * transient), and the route answers it.
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
 */
export async function runCampusEventsIngest({
  client,
  dryRun = false,
  engageEnabled = false,
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
  const sources = SOURCES.map((source) => {
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

  const upserted = await upsertRows(client, rows.map((row) => ({ ...row, last_seen_at: runAt })), { log, sleep })
  for (const entry of sources) {
    const result = fetched.get(entry.key)
    if (!result || result.error || !result.complete || result.listings.length === 0) continue
    Object.assign(entry, await sweepSource(client, entry.key, runAt, { log }))
  }
  return { ...summary, upserted, durationMs: Date.now() - startedAt }
}
