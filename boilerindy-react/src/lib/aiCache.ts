/**
 * Short-lived cache for generated AI panels (week digest, assignment insights,
 * event picks).
 *
 * These were cached per week or per day with no timestamp, so revisiting a page
 * replayed text that could be hours or days old - the student saw an "insight"
 * listing work they had since finished, which is a large part of why the AI felt
 * pre-loaded. Entries now carry a generated-at stamp, expire on their own, and
 * the UI can say how fresh they are.
 */

export type CachedAiText = { text: string; at: number }

export const AI_CACHE_TTL_MS = 6 * 60 * 60 * 1000

export function readAiCache(key: string, ttlMs: number = AI_CACHE_TTL_MS): CachedAiText | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)

    // Entries written before this helper existed were a bare JSON string. They
    // have no timestamp, so treat them as expired rather than showing undated text.
    if (typeof parsed === 'string') return null
    if (!parsed || typeof parsed !== 'object') return null

    const { text, at } = parsed as Partial<CachedAiText>
    if (typeof text !== 'string' || typeof at !== 'number') return null
    if (Date.now() - at > ttlMs) return null
    return { text, at }
  } catch {
    return null
  }
}

export function writeAiCache(key: string, text: string): CachedAiText {
  const entry: CachedAiText = { text, at: Date.now() }
  try {
    localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    /* quota */
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
