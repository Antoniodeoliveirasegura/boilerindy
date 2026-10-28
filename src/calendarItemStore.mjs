// calendarItemStore.mjs
//
// The persistence edge for schedule sync. This is a plain module for locality
// of the upsert-then-sweep and status-update logic - NOT an injected port.
// Because planSync (scheduleSync.mjs) is pure, the sync tests never touch this
// module; its own behaviour is covered by test/calendarItemStore.test.mjs.
//
// Identity (id / created_at / updated_at) is owned by the DATABASE, not stamped
// here. A row that survives a re-sync must keep its primary key:
// user_task_completions.calendar_item_id references calendar_items(id) ON DELETE
// CASCADE, so minting a fresh id per sync erased every task the user ticked off.

import { fetchAllPages } from './pagedSelect.mjs'

const UPSERT_BATCH_SIZE = 500
const DELETE_BATCH_SIZE = 100
// Far above any real feed; the read pages through it 1000 rows at a time.
const EXISTING_ROWS_MAX = 100_000

// Every column planSync writes. A stored row whose values all match the feed is
// left alone: re-writing unchanged rows on every background re-sync was most of
// the project's disk IO (calendar_items had ~36x more updates than inserts).
const COMPARED_COLUMNS = [
  'user_id',
  'source_type',
  'title',
  'description',
  'start_time',
  'end_time',
  'location',
  'category',
  'all_day',
  'raw_json',
]
const TIME_COLUMNS = new Set(['start_time', 'end_time'])

// jsonb comes back with its keys in Postgres order, not the order they were
// sent in, so objects compare with their keys sorted.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// PostgREST answers timestamptz as "2026-07-05T14:30:00+00:00" while planSync
// sends "2026-07-05T14:30:00.000Z"; the same instant must count as unchanged.
function sameTime(a, b) {
  if (a == null || b == null) return a == null && b == null
  const left = Date.parse(a)
  const right = Date.parse(b)
  return Number.isFinite(left) && left === right
}

function sameColumn(column, stored, next) {
  if (TIME_COLUMNS.has(column)) return sameTime(stored, next)
  if (column === 'raw_json') return stableJson(stored) === stableJson(next)
  return (stored ?? null) === (next ?? null)
}

export function isUnchanged(stored, next) {
  return COMPARED_COLUMNS.every((column) => sameColumn(column, stored?.[column], next?.[column]))
}

// The fallback sweep deletes rows this sync did not refresh, comparing updated_at (set by
// the database clock, via the update_calendar_items_updated_at trigger) against a
// threshold taken from this process's clock. The guard band absorbs skew between
// the two: a stale row that survives one cycle is swept by the next, whereas a
// refreshed row deleted by a fast database clock is simply gone.
const SWEEP_SKEW_GUARD_MS = 5 * 60 * 1000

function nowIso() {
  return new Date().toISOString()
}

export function createCalendarItemStore(supabase) {
  async function upsertRows(sourceId, rows) {
    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + UPSERT_BATCH_SIZE)
      const { error: upsertError } = await supabase
        .from('calendar_items')
        .upsert(batch, { onConflict: 'source_id,external_uid' })
      if (upsertError) {
        console.error(`[calendarItemStore] Upsert failed for source=${sourceId} batch ${i}:`, upsertError)
        throw new Error(upsertError.message)
      }
    }
  }

  async function readStoredRows(sourceId) {
    return fetchAllPages(
      () => supabase
        .from('calendar_items')
        .select(['id', 'external_uid', ...COMPARED_COLUMNS].join(', '))
        .eq('source_id', sourceId)
        .order('id', { ascending: true }),
      { max: EXISTING_ROWS_MAX },
    )
  }

  /**
   * Bring a source's calendar_items in line with a freshly parsed feed.
   *
   * Reads what is stored, writes only rows that are new or changed, then
   * deletes the stored rows the feed no longer lists. The old order (delete
   * everything, then insert) meant any insert failure - including a
   * unique-constraint collision - left the user with an empty calendar, because
   * the delete had already committed. Writing first makes a failed sync a no-op
   * instead of a wipe.
   *
   * When the stored rows cannot be read, the sync falls back to writing every
   * row and sweeping by updated_at, which needs no read.
   *
   * Throws on upsert failure so the shell can mark the source 'error'; a delete
   * failure is logged and tolerated (a stale row beats losing the sync).
   *
   * @param {string} sourceId
   * @param {object[]} rows - plan items WITHOUT id/created_at/updated_at.
   */
  async function replaceItems(sourceId, rows) {
    const startedAt = Date.now()

    // calendar_items is UNIQUE(source_id, external_uid), but planSync dedupes
    // on title/date/hour/location - a different key. Two VEVENTs sharing a UID
    // at different hours cleared that filter and then collided here. Collapse
    // on the key the table actually enforces so the write cannot self-conflict.
    const byExternalUid = new Map()
    for (const row of rows) byExternalUid.set(row.external_uid, row)
    const deduped = [...byExternalUid.values()]

    const { data: stored, error: readError } = await readStoredRows(sourceId)
    if (readError) {
      console.error(`[calendarItemStore] Read failed for source=${sourceId}, writing every row:`, readError)
      return replaceItemsBySweep(sourceId, deduped, startedAt)
    }

    const storedByUid = new Map(stored.map((row) => [row.external_uid, row]))
    const changed = deduped.filter((row) => {
      const current = storedByUid.get(row.external_uid)
      return !current || !isUnchanged(current, row)
    })
    await upsertRows(sourceId, changed)

    // Deleted by id from the rows read before the write, so a row another sync
    // of the same source adds meanwhile is never removed by this one.
    // Runs only after every batch succeeded, so a partial write never prunes.
    const goneIds = stored.filter((row) => !byExternalUid.has(row.external_uid)).map((row) => row.id)
    for (let i = 0; i < goneIds.length; i += DELETE_BATCH_SIZE) {
      const { error: deleteError } = await supabase
        .from('calendar_items')
        .delete()
        .eq('source_id', sourceId)
        .in('id', goneIds.slice(i, i + DELETE_BATCH_SIZE))
      if (deleteError) {
        console.error(`[calendarItemStore] Delete failed for source=${sourceId}:`, deleteError)
        return
      }
    }
  }

  async function replaceItemsBySweep(sourceId, rows, startedAt) {
    await upsertRows(sourceId, rows)

    // Anything still carrying an older updated_at is no longer in the feed.
    // Runs only after every batch succeeded, so a partial write never prunes.
    const staleBefore = new Date(startedAt - SWEEP_SKEW_GUARD_MS).toISOString()
    const { error: sweepError } = await supabase
      .from('calendar_items')
      .delete()
      .eq('source_id', sourceId)
      .lt('updated_at', staleBefore)

    if (sweepError) {
      console.error(`[calendarItemStore] Sweep failed for source=${sourceId}:`, sweepError)
    }
  }

  /**
   * Update the linked_sources status row.
   *
   * @param {string} sourceId
   * @param {string} status - 'ready' | 'error' | ...
   * @param {string|null} message - persisted to last_error (null clears it).
   * @param {{ markSynced?: boolean }} opts - when true, also set last_synced_at.
   */
  async function setStatus(sourceId, status, message = null, { markSynced = false } = {}) {
    const ts = nowIso()
    const patch = { status, last_error: message, updated_at: ts }
    if (markSynced) patch.last_synced_at = ts
    await supabase.from('linked_sources').update(patch).eq('id', sourceId)
  }

  return { replaceItems, setStatus }
}
