// calendarItemStore.mjs
//
// The persistence edge for schedule sync. This is a plain module for locality
// of the delete-then-batch-insert and status-update logic — NOT an injected
// port. Because planSync (scheduleSync.mjs) is pure, the tests never touch this
// module, so there is no second adapter to justify a swappable seam.
//
// Identity (id / created_at / updated_at) is stamped HERE, at the I/O edge, so
// the pure core stays deterministic.

import crypto from 'node:crypto'

const INSERT_BATCH_SIZE = 500

function nowIso() {
  return new Date().toISOString()
}

export function createCalendarItemStore(supabase) {
  /**
   * Replace every calendar_item for a source with a fresh set. Deletes first,
   * then inserts the stamped rows in batches. Throws on insert failure so the
   * shell can mark the source 'error'; a delete failure is logged and tolerated
   * (matches prior behaviour — a stale row is better than losing the sync).
   *
   * @param {string} sourceId
   * @param {object[]} rows - plan items WITHOUT id/created_at/updated_at.
   */
  async function replaceItems(sourceId, rows) {
    const { error: deleteError } = await supabase
      .from('calendar_items')
      .delete()
      .eq('source_id', sourceId)

    if (deleteError) {
      console.error(`[calendarItemStore] Delete failed for source=${sourceId}:`, deleteError)
    }

    if (!rows.length) return

    const ts = nowIso()
    const stamped = rows.map((row) => ({
      ...row,
      id: crypto.randomUUID(),
      created_at: ts,
      updated_at: ts,
    }))

    for (let i = 0; i < stamped.length; i += INSERT_BATCH_SIZE) {
      const batch = stamped.slice(i, i + INSERT_BATCH_SIZE)
      const { error: insertError } = await supabase
        .from('calendar_items')
        .insert(batch)
      if (insertError) {
        console.error(`[calendarItemStore] Insert failed for source=${sourceId} batch ${i}:`, insertError)
        throw new Error(insertError.message)
      }
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
