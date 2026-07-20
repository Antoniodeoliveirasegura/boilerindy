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

const UPSERT_BATCH_SIZE = 500

// The sweep deletes rows this sync did not refresh, comparing updated_at (set by
// the database clock, via the update_calendar_items_updated_at trigger) against a
// threshold taken from this process's clock. The guard band absorbs skew between
// the two: a stale row that survives one cycle is swept by the next, whereas a
// refreshed row deleted by a fast database clock is simply gone.
const SWEEP_SKEW_GUARD_MS = 5 * 60 * 1000

function nowIso() {
  return new Date().toISOString()
}

export function createCalendarItemStore(supabase) {
  /**
   * Bring a source's calendar_items in line with a freshly parsed feed.
   *
   * Upserts every row first, then deletes only what this sync did not touch.
   * The old order (delete everything, then insert) meant any insert failure -
   * including a unique-constraint collision - left the user with an empty
   * calendar, because the delete had already committed. Writing first makes a
   * failed sync a no-op instead of a wipe.
   *
   * Throws on upsert failure so the shell can mark the source 'error'; a sweep
   * failure is logged and tolerated (a stale row beats losing the sync).
   *
   * @param {string} sourceId
   * @param {object[]} rows - plan items WITHOUT id/created_at/updated_at.
   */
  async function replaceItems(sourceId, rows) {
    const startedAt = Date.now()

    if (rows.length) {
      // calendar_items is UNIQUE(source_id, external_uid), but planSync dedupes
      // on title/date/hour/location - a different key. Two VEVENTs sharing a UID
      // at different hours cleared that filter and then collided here. Collapse
      // on the key the table actually enforces so the write cannot self-conflict.
      const byExternalUid = new Map()
      for (const row of rows) byExternalUid.set(row.external_uid, row)
      const deduped = [...byExternalUid.values()]

      for (let i = 0; i < deduped.length; i += UPSERT_BATCH_SIZE) {
        const batch = deduped.slice(i, i + UPSERT_BATCH_SIZE)
        const { error: upsertError } = await supabase
          .from('calendar_items')
          .upsert(batch, { onConflict: 'source_id,external_uid' })
        if (upsertError) {
          console.error(`[calendarItemStore] Upsert failed for source=${sourceId} batch ${i}:`, upsertError)
          throw new Error(upsertError.message)
        }
      }
    }

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
