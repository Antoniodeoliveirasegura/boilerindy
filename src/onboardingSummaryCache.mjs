// In-memory, per-user cache of the two expensive onboarding counts that
// GET /api/session (and every app hydrate) would otherwise recompute on every
// read: the number of linked_sources, and the number of `class` calendar_items.
// Issue #111 (item 6): trust the signed session cookie on reads instead of
// re-counting on each hydrate.
//
// Only the two COUNTS are cached. The Purdue-derived fields (hasPurdueLinked and
// the needs* gates) are recomputed from the fresh user row on every call, so
// linking or unlinking Purdue needs no cache handling here.
//
// Correctness rests on invalidating a user's entry whenever those counts change.
// Every such write funnels through a small set of choke points in server.mjs
// (createScheduleSource, runScheduleSync, source delete, account delete), each
// calling invalidate(). The TTL is a backstop that bounds staleness for anything
// not explicitly invalidated: a future write path someone forgets to hook, or a
// multi-instance deployment where one process cannot see another's writes.
//
// The generation guard closes the read-during-write race: a reader captures the
// user's generation BEFORE issuing the count query and passes it to set(); if an
// invalidation lands while that query is in flight, the generation advances and
// the now-stale result is dropped instead of being cached.

const DEFAULT_TTL_MS = 60_000
// Safety bound on memory. The natural size is "users who read a session within
// the TTL window", far below this; the cap only guards pathological growth.
const DEFAULT_MAX_ENTRIES = 50_000

export function createOnboardingSummaryCache({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const cache = new Map() // userId -> { linkedSourceCount, classCount, expiresAt }
  const generations = new Map() // userId -> number, bumped on every invalidation

  const genOf = (userId) => generations.get(userId) || 0

  function sweepExpired(now) {
    for (const [userId, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(userId)
    }
  }

  return {
    // Capture BEFORE the count query, pass the returned value to set().
    generation(userId) {
      return genOf(userId)
    },

    // Returns { linkedSourceCount, classCount } for a live entry, else null.
    get(userId, now = Date.now()) {
      if (!userId) return null
      const entry = cache.get(userId)
      if (!entry) return null
      if (entry.expiresAt <= now) {
        cache.delete(userId)
        return null
      }
      return { linkedSourceCount: entry.linkedSourceCount, classCount: entry.classCount }
    },

    // gen is optional; when provided, a mismatch means an invalidation raced this
    // read and the result is dropped rather than cached.
    set(userId, counts, gen, now = Date.now()) {
      if (!userId) return
      if (gen !== undefined && gen !== genOf(userId)) return
      if (cache.size >= maxEntries) {
        sweepExpired(now)
        if (cache.size >= maxEntries) cache.clear()
      }
      cache.set(userId, {
        linkedSourceCount: counts.linkedSourceCount || 0,
        classCount: counts.classCount || 0,
        expiresAt: now + ttlMs,
      })
    },

    invalidate(userId) {
      if (!userId) return
      generations.set(userId, genOf(userId) + 1)
      cache.delete(userId)
    },

    clear() {
      cache.clear()
      generations.clear()
    },

    get size() {
      return cache.size
    },

    ttlMs,
  }
}
