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

// ── Following a club (issue #16) ────────────────────────────────────────────
// The clubs a student follows live with the account (GET, PUT and DELETE
// /api/me/club-follows, docs/clubs.md#following-a-club), read and written
// through queries/userData.ts. The Events and Free Food read marks the
// followed clubs' events with `followed: true` (lib/campusEvents.ts).

/** A followed club as GET /api/me/club-follows lists it: the directory's club and its key. */
export type FollowedClub = Club & { organizationKey: string }

/** GET /api/me/club-follows: every key followed, oldest first, and the followed clubs the directory still lists, by name. */
export type ClubFollows = { follows: string[]; clubs: FollowedClub[] }

/** The key a club is followed by: `boilerlink:` and its BoilerLink id, as the server stores it. */
export function organizationKeyOf(club: Pick<Club, 'id'>): string {
  return `boilerlink:${club.id}`
}

/** The follows answer with every field defined, whatever the server left out. */
export function normalizeClubFollows(data: unknown): ClubFollows {
  const d = (data ?? {}) as { follows?: unknown; clubs?: unknown }
  const follows = Array.isArray(d.follows) ? d.follows.filter((key): key is string => typeof key === 'string') : []
  const clubs = Array.isArray(d.clubs)
    ? d.clubs.filter(
        (club): club is FollowedClub =>
          Boolean(club) && typeof club === 'object' && typeof (club as FollowedClub).id === 'string' && typeof (club as FollowedClub).organizationKey === 'string',
      )
    : []
  return { follows, clubs }
}

const byName = (a: Club, b: Club) => a.name.localeCompare(b.name, 'en')

/** The follows with one club followed or unfollowed, the way the server will store it. */
export function applyFollow(current: ClubFollows, club: Club, following: boolean): ClubFollows {
  const key = organizationKeyOf(club)
  const follows = current.follows.filter((k) => k !== key)
  const clubs = current.clubs.filter((c) => c.organizationKey !== key)
  if (!following) return { follows, clubs }
  return { follows: [...follows, key], clubs: [...clubs, { ...club, organizationKey: key }].sort(byName) }
}

// The server's search folding (foldText in src/boilerlinkClubs.mjs): fancy
// letters to plain, lowercase, no accents, punctuation to spaces.
function fold(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * The Following view's list: the followed clubs whose name, short name, slug,
 * categories or blurb hold every word of `q`, in `category` when one is
 * picked. At most 100 clubs, so it is filtered here rather than on the server.
 */
export function filterFollowedClubs(clubs: FollowedClub[], { q = '', category = '' }: { q?: string; category?: string } = {}): FollowedClub[] {
  const words = fold(q).split(' ').filter(Boolean)
  const categoryKey = fold(category)
  return clubs.filter((club) => {
    if (categoryKey && !club.categories.some((name) => fold(name) === categoryKey)) return false
    if (words.length === 0) return true
    const text = fold([club.name, club.shortName ?? '', club.slug, club.categories.join(' '), club.blurb].join(' '))
    return words.every((word) => text.includes(word))
  })
}

/** The Following view's category menu: the followed clubs' categories, each with how many of them it has. */
export function followedCategories(clubs: FollowedClub[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const club of clubs) for (const name of club.categories) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

/** "3 clubs you follow" / "1 match for "chess" among the clubs you follow". */
export function followingLabel({ total, q, category }: { total: number; q: string; category: string }): string {
  const count = total.toLocaleString()
  if (!q && !category) return `${count} club${total === 1 ? '' : 's'} you follow`
  const parts = [`${count} match${total === 1 ? '' : 'es'}`]
  if (q) parts.push(`for "${q}"`)
  if (category) parts.push(`in ${category}`)
  parts.push('among the clubs you follow')
  return parts.join(' ')
}

/** The `following` URL param: "1" opens the Following view. */
export function followingFromParam(value: string | null | undefined): boolean {
  return value === '1'
}
