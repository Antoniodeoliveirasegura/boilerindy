// Background re-sync of linked calendar sources (issue #12).
//
// A student connects a Brightspace or Purdue feed once; until now the imported
// items only changed when they pressed Sync or "Sync all", so a due date moved
// in Brightspace stayed stale here. A cron job now calls
// POST /api/internal/sources/resync (src/routes/sources.mjs) and this module
// decides which sources are due and runs them one at a time.
//
// Pure core: pickSourcesToResync(rows, opts) -> the rows to sync, sources that
// have synced first, oldest first, a few per account.
// Shell: runSourceResync({ client, sync }) reads candidates through the
// Supabase client and calls the existing runScheduleSync for each.
//
// Sources whose first sync never worked (a dead link, or a script adding links
// that fail) used to sort first and fill the one candidate window, and about
// 200 of them, from one account, stopped every other student's feed from
// re-syncing. They are now listed apart and go after the feeds that work, and
// one account takes at most DEFAULT_PER_USER places a tick.

import { queryError } from './cronTick.mjs'

export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000 // ready sources: re-sync after 6 h
export const DEFAULT_ERROR_RETRY_MS = 24 * 60 * 60 * 1000 // error sources: retry daily
// Sources per run. 15 until 2026-11-03: the feeds linked together come due
// together, and 11 of them (about 2,000 items in 30 s) landed in one run every
// 6 hours on a database with no memory to spare. Four spread such a wave over
// three hourly runs, and still cover 24 sources at the 6-hour staleness.
export const DEFAULT_BATCH = 4
// Places one account may take in a tick: a student's class schedule and
// Brightspace calendar still sync together.
export const DEFAULT_PER_USER = 2
export const DEFAULT_BUDGET_MS = 60 * 1000 // stop starting new syncs after this
// Rows per listing; each tick reads two (see runSourceResync).
export const CANDIDATE_LIMIT = 200
const LISTED_COLUMNS = 'id, user_id, source_type, source_url, label, status, last_synced_at, updated_at'

const SYNCABLE = new Set(['ready', 'error', 'pending'])

function ms(value) {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : t
}

/**
 * Which of these linked_sources rows are due for a sync right now.
 *
 * - ready / pending: due when never synced or last synced more than staleMs ago;
 * - error: due when the last attempt (updated_at) is older than errorRetryMs,
 *   so an expired link is retried daily rather than every run, and the student
 *   can still press Sync themselves at any time;
 * - anything else is left alone.
 *
 * Sources that have synced before go first, oldest sync first. Sources that
 * never have (a first sync that failed or never finished; a new source syncs
 * when it is added) follow, oldest attempt first, so their retries take turns.
 * One account takes at most perUser places, and the tick at most batch.
 */
export function pickSourcesToResync(
  rows,
  {
    now = new Date(),
    staleMs = DEFAULT_STALE_MS,
    errorRetryMs = DEFAULT_ERROR_RETRY_MS,
    batch = DEFAULT_BATCH,
    perUser = DEFAULT_PER_USER,
  } = {},
) {
  const nowMs = now.getTime()
  const due = []
  for (const row of rows || []) {
    if (!row || !SYNCABLE.has(row.status)) continue
    const synced = ms(row.last_synced_at)
    if (row.status === 'error') {
      const attempted = ms(row.updated_at) ?? synced
      if (attempted != null && nowMs - attempted < errorRetryMs) continue
    } else if (synced != null && nowMs - synced < staleMs) {
      continue
    }
    due.push(row)
  }
  const neverSynced = (row) => (ms(row.last_synced_at) == null ? 1 : 0)
  const key = (row) => (neverSynced(row) ? ms(row.updated_at) ?? 0 : ms(row.last_synced_at))
  due.sort((a, b) => neverSynced(a) - neverSynced(b) || key(a) - key(b))

  const picked = []
  const placesTaken = new Map()
  for (const row of due) {
    if (picked.length >= Math.max(0, batch)) break
    // A row without its user_id counts as an account of its own.
    const account = row.user_id ?? `source:${row.id}`
    const taken = placesTaken.get(account) ?? 0
    if (taken >= perUser) continue
    placesTaken.set(account, taken + 1)
    picked.push(row)
  }
  return picked
}

/**
 * One cron tick: list candidates, pick the due ones, sync them sequentially
 * (one upstream fetch at a time), and report. A sync that throws has already
 * marked its source `error` (runScheduleSync does that); the run continues.
 * Once budgetMs has elapsed no further sync is started; the rest wait for the
 * next tick and are reported as `deferred`.
 *
 * The candidates come from two listings of up to candidateLimit rows each:
 * sources that have synced, oldest sync first, and sources that never have,
 * oldest attempt first. One window shared by both let never-synced rows, which
 * sorted first, fill it and hide every feed that works.
 */
export async function runSourceResync({
  client,
  sync,
  now = new Date(),
  staleMs,
  errorRetryMs,
  batch,
  perUser,
  budgetMs = DEFAULT_BUDGET_MS,
  candidateLimit = CANDIDATE_LIMIT,
} = {}) {
  if (!client || typeof sync !== 'function') throw new Error('runSourceResync needs a client and a sync function')
  const startedAt = Date.now()

  // One after the other, so a failed listing ends the tick before the second.
  const listing = async (neverSynced) => {
    const query = client.from('linked_sources').select(LISTED_COLUMNS).in('status', [...SYNCABLE])
    const ordered = neverSynced
      ? query.is('last_synced_at', null).order('updated_at', { ascending: true })
      : query.not('last_synced_at', 'is', null).order('last_synced_at', { ascending: true })
    const { data, error, status } = await ordered.limit(candidateLimit)
    if (error) throw queryError({ error, status }, 'Could not list linked sources')
    return data || []
  }
  const syncedRows = await listing(false)
  const neverSyncedRows = await listing(true)

  // A source that synced between the two reads is listed twice; keep one.
  const rows = [...new Map([...syncedRows, ...neverSyncedRows].map((row) => [row.id, row])).values()]
  const due = pickSourcesToResync(rows, { now, staleMs, errorRetryMs, batch, perUser })

  let synced = 0
  let failed = 0
  let deferred = 0
  let items = 0
  const failures = []
  for (let i = 0; i < due.length; i += 1) {
    if (Date.now() - startedAt > budgetMs) {
      deferred = due.length - i
      break
    }
    const source = due[i]
    try {
      const result = await sync(source)
      synced += 1
      items += Number(result?.itemCount) || 0
    } catch (err) {
      failed += 1
      if (failures.length < 5) failures.push({ id: source.id, message: err?.message || String(err) })
    }
  }

  return {
    ok: true,
    scanned: rows.length,
    truncated: syncedRows.length >= candidateLimit || neverSyncedRows.length >= candidateLimit,
    due: due.length,
    synced,
    failed,
    deferred,
    items,
    failures,
    durationMs: Date.now() - startedAt,
  }
}
