// Client-side types and pure helpers for the club directory (issue #16).
// The shapes mirror src/boilerlinkClubs.mjs on the server.

export type ClubScope = 'indianapolis' | 'all'

export type Club = {
  id: string
  name: string
  shortName: string | null
  slug: string
  url: string
  imageUrl: string | null
  blurb: string
  categories: string[]
  indianapolis: boolean
}

export type ClubCategory = { name: string; count: number; indianapolisCount: number }

export type ClubSearchParams = {
  q?: string
  category?: string
  scope?: ClubScope
  page?: number
  pageSize?: number
}

export type ClubSearchResult = {
  ok: boolean
  error?: string
  source: string
  sourceUrl: string
  fetchedAt: string
  stale: boolean
  directoryTotal: number
  indianapolisTotal: number
  q: string
  category: string
  scope: ClubScope
  page: number
  pageSize: number
  pages: number
  total: number
  clubs: Club[]
  categories: ClubCategory[]
}

export const CLUBS_PAGE_SIZE = 24
export const BOILERLINK_URL = 'https://boilerlink.purdue.edu/'

/** Query string for GET /api/clubs. Defaults are left out so URLs stay short. */
export function buildClubsQuery(params: ClubSearchParams): string {
  const search = new URLSearchParams()
  const q = (params.q || '').trim()
  if (q) search.set('q', q)
  const category = (params.category || '').trim()
  if (category) search.set('category', category)
  if (params.scope === 'indianapolis') search.set('scope', 'indianapolis')
  if (params.page && params.page > 1) search.set('page', String(Math.floor(params.page)))
  if (params.pageSize && params.pageSize !== CLUBS_PAGE_SIZE) search.set('pageSize', String(params.pageSize))
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** The `scope` URL param: anything but "all" means the Indianapolis default. */
export function scopeFromParam(value: string | null | undefined): ClubScope {
  return value === 'all' ? 'all' : 'indianapolis'
}

/** Up to two initials for the logo placeholder: "Chess Club Purdue" -> "CC". */
export function initialsFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const letters = words.slice(0, 2).map((w) => w.charAt(0).toUpperCase())
  return letters.join('') || '?'
}

/** The count shown beside a category for the active scope. */
export function categoryCount(category: ClubCategory, scope: ClubScope): number {
  return scope === 'indianapolis' ? category.indianapolisCount : category.count
}

/** "58 organizations in Indianapolis" / "3 matches for "chess" in Hobby across Purdue". */
export function resultsLabel({ total, q, category, scope }: Pick<ClubSearchResult, 'total' | 'q' | 'category' | 'scope'>): string {
  const count = total.toLocaleString()
  const where = scope === 'indianapolis' ? 'in Indianapolis' : 'across Purdue'
  if (!q && !category) return `${count} organization${total === 1 ? '' : 's'} ${where}`
  const parts = [`${count} match${total === 1 ? '' : 'es'}`]
  if (q) parts.push(`for "${q}"`)
  if (category) parts.push(`in ${category}`)
  parts.push(where)
  return parts.join(' ')
}

/** "Updated today at 6:04 AM" style stamp for the footer, or null for bad input. */
export function formatFetched(iso: string, now: Date = new Date()): string | null {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  const sameDay = then.toDateString() === now.toDateString()
  const time = then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `today at ${time}`
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` at ${time}`
}

// The directory is read through the query cache: see useClubPages and
// clubsQuery in queries/publicData.ts (issue #251).
