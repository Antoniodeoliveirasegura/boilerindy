/**
 * Per-user localStorage cache for the AI insight cards (issue #219): the
 * Assignments priorities and study plan, the Home "Week Ahead" digest and the
 * Events recommendations. Each is generated from one student's schedule and
 * deadlines, so every key carries the backend user id (mirrors the
 * taskPriorityStore pattern) and the next account on a shared computer never
 * reads the previous student's insights. Sign-out also wipes them, together with
 * the per-user board drafts, from the device.
 */

export type AiCacheFeature = 'assignments' | 'week-ahead' | 'event-recs'

const AI_CACHE_PREFIX = 'ai-'
// The unscoped `boilerindy-board-draft-v1` key predates issue #219; it is still
// matched on clear so a draft left behind by an older build is removed too.
const BOARD_DRAFT_PREFIX = 'boilerindy-board-draft-v1'

/** `ai-<feature>-<userId>-<suffix>`; the suffix carries the mode and week/day. */
export function aiCacheKey(
  feature: AiCacheFeature,
  userId: string | null | undefined,
  suffix: string,
): string {
  return `${AI_CACHE_PREFIX}${feature}-${userId ?? 'anon'}-${suffix}`
}

/** The unsent board post draft for one user. */
export function boardDraftKey(userId: string): string {
  return `${BOARD_DRAFT_PREFIX}-${userId}`
}

/**
 * Cached insight text, or null when nothing usable is stored. A null key (no
 * user id yet) reads nothing.
 */
export function readAiCache(key: string | null): string | null {
  if (!key) return null
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null')
    return typeof raw === 'string' && raw.trim() ? raw : null
  } catch {
    return null
  }
}

/** Persist insight text. No-ops for a null key (no user id yet). */
export function writeAiCache(key: string | null, value: string): void {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / storage unavailable - the card simply regenerates next time */
  }
}

function isBoardDraftKey(key: string): boolean {
  return key === BOARD_DRAFT_PREFIX || key.startsWith(`${BOARD_DRAFT_PREFIX}-`)
}

/**
 * Remove every `ai-*` cache entry and, unless `keepBoardDrafts` is set, every
 * board draft. Other per-user stores (priorities, tasks, layouts) are left alone.
 */
export function clearAiCaches({ keepBoardDrafts = false }: { keepBoardDrafts?: boolean } = {}): void {
  try {
    // Collect first: removing while walking localStorage.key(i) shifts the indexes.
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key.startsWith(AI_CACHE_PREFIX) || (!keepBoardDrafts && isBoardDraftKey(key))) {
        doomed.push(key)
      }
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}
