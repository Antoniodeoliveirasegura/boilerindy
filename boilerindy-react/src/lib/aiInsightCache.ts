/**
 * Per-user localStorage cache for the AI insight cards (issue #219): the
 * Assignments priorities and study plan, the Home "Week Ahead" digest and the
 * Events recommendations. Each is generated from one student's schedule and
 * deadlines, so every key carries the backend user id (mirrors the
 * taskPriorityStore pattern) and the next account on a shared computer never
 * reads the previous student's insights. Sign-out also wipes them from the
 * device, together with the per-user board drafts and the dashboard's cached
 * location and its permission-prompt flag (issue #294, see useUserLocation).
 */

import { LOCATION_STORAGE_KEYS } from '../hooks/useUserLocation'

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

export type CachedAiText = { text: string; at: number }

export const AI_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Cached insight text with the time it was generated, or null when nothing
 * usable is stored. A null key (no user id yet) reads nothing.
 *
 * Entries used to be a bare JSON string with no timestamp, so revisiting a page
 * replayed text that could be hours or days old: the student saw an "insight"
 * listing work they had since finished, which is a large part of why the AI felt
 * pre-loaded. Entries now expire on their own and the UI can say how fresh they
 * are. A pre-timestamp entry reads as expired rather than as undated text.
 */
export function readAiCache(key: string | null, ttlMs: number = AI_CACHE_TTL_MS): CachedAiText | null {
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'string') return null
    if (!parsed || typeof parsed !== 'object') return null

    const { text, at } = parsed as Partial<CachedAiText>
    if (typeof text !== 'string' || !text.trim() || typeof at !== 'number') return null
    if (Date.now() - at > ttlMs) return null
    return { text, at }
  } catch {
    return null
  }
}

/** Persist insight text with a generated-at stamp. No-ops for a null key. */
export function writeAiCache(key: string | null, text: string): CachedAiText {
  const entry: CachedAiText = { text, at: Date.now() }
  if (!key) return entry
  try {
    localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    /* quota / storage unavailable - the card simply regenerates next time */
  }
  return entry
}

/** "just now" / "12 min ago" / "3 hours ago" - for the freshness label. */
export function describeAge(at: number | null | undefined): string {
  if (!at) return ''
  const minutes = Math.floor((Date.now() - at) / 60000)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'} ago`
}

function isBoardDraftKey(key: string): boolean {
  return key === BOARD_DRAFT_PREFIX || key.startsWith(`${BOARD_DRAFT_PREFIX}-`)
}

/**
 * Remove every `ai-*` cache entry, the cached location keys (always, matched
 * exactly) and, unless `keepBoardDrafts` is set, every board draft. Other
 * per-user stores (priorities, tasks, layouts) are left alone.
 */
export function clearAiCaches({ keepBoardDrafts = false }: { keepBoardDrafts?: boolean } = {}): void {
  try {
    // Collect first: removing while walking localStorage.key(i) shifts the indexes.
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (
        key.startsWith(AI_CACHE_PREFIX) ||
        LOCATION_STORAGE_KEYS.includes(key) ||
        (!keepBoardDrafts && isBoardDraftKey(key))
      ) {
        doomed.push(key)
      }
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}
