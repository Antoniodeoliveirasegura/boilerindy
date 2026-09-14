// Background re-sync of linked calendar sources (issue #12).
//
// A student connects a Brightspace or Purdue feed once; until now the imported
// items only changed when they pressed Sync or "Sync all", so a due date moved
// in Brightspace stayed stale here. A cron job now calls
// POST /api/internal/sources/resync (server.mjs) and this module decides which
// sources are due and runs them one at a time.
//
// Pure core: pickSourcesToResync(rows, opts) -> the rows to sync, oldest first.
// Shell: runSourceResync({ client, sync }) reads candidates through the
// Supabase client and calls the existing runScheduleSync for each.

import { queryError } from './cronTick.mjs'

export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000 // ready sources: re-sync after 6 h
export const DEFAULT_ERROR_RETRY_MS = 24 * 60 * 60 * 1000 // error sources: retry daily
export const DEFAULT_BATCH = 15 // sources per run
export const DEFAULT_BUDGET_MS = 60 * 1000 // stop starting new syncs after this
export const CANDIDATE_LIMIT = 200

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
 * Oldest sync first (never-synced first of all), capped at batch.
 */
export function pickSourcesToResync(
  rows,
  { now = new Date(), staleMs = DEFAULT_STALE_MS, errorRetryMs = DEFAULT_ERROR_RETRY_MS, batch = DEFAULT_BATCH } = {},
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
  const key = (row) => ms(row.last_synced_at) ?? 0
  due.sort((a, b) => key(a) - key(b))
  return due.slice(0, Math.max(0, batch))
}

/**
 * One cron tick: list candidates, pick the due ones, sync them sequentially
 * (one upstream fetch at a time), and report. A sync that throws has already
 * marked its source `error` (runScheduleSync does that); the run continues.
 * Once budgetMs has elapsed no further sync is started; the rest wait for the
 * next tick and are reported as `deferred`.
 */
export async function runSourceResync({
  client,
  sync,
  now = new Date(),
  staleMs,
  errorRetryMs,
  batch,
  budgetMs = DEFAULT_BUDGET_MS,
  candidateLimit = CANDIDATE_LIMIT,
} = {}) {
  if (!client || typeof sync !== 'function') throw new Error('runSourceResync needs a client and a sync function')
  const startedAt = Date.now()

  const { data, error, status } = await client
    .from('linked_sources')
    .select('id, user_id, source_type, source_url, label, status, last_synced_at, updated_at')
    .in('status', [...SYNCABLE])
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(candidateLimit)
  if (error) throw queryError({ error, status }, 'Could not list linked sources')

  const rows = data || []
  const due = pickSourcesToResync(rows, { now, staleMs, errorRetryMs, batch })

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
    truncated: rows.length >= candidateLimit,
    due: due.length,
    synced,
    failed,
    deferred,
    items,
    failures,
    durationMs: Date.now() - startedAt,
  }
}
