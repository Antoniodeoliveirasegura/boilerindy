// Dining favorites helpers (issue #49). Mirrors the server-side normalization
// in src/diningFavorites.mjs so the frontend can match favorited names against
// the live menu snapshot. Migrated to TypeScript (issue #20).

export const MAX_ITEM_NAME = 200

/** Normalize a menu/item name to a stable favorite key, or '' when unusable. */
export function normalizeItemName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_ITEM_NAME)
}

type MenuItem = { name: string }
type Station = { items?: MenuItem[] }
type DiningLocation = { name?: string; stations?: Station[] }
export type FavoriteOnMenu = { name: string; locations: string[] }

/**
 * Cross-reference favorited item names against today's dining snapshot.
 * Returns the favorites on today's menus with the display name and the
 * locations serving them.
 */
export function favoritesOnTodaysMenu(
  favoriteNames: Iterable<string> | null | undefined,
  locations: DiningLocation[] | null | undefined,
): FavoriteOnMenu[] {
  const favs = favoriteNames instanceof Set ? favoriteNames : new Set(favoriteNames ?? [])
  if (favs.size === 0 || !Array.isArray(locations)) return []

  const byFav = new Map<string, { name: string; locations: Set<string> }>()
  for (const loc of locations) {
    for (const station of loc?.stations ?? []) {
      for (const item of station?.items ?? []) {
        const key = normalizeItemName(item?.name)
        if (!key || !favs.has(key)) continue
        if (!byFav.has(key)) byFav.set(key, { name: item.name, locations: new Set() })
        if (loc?.name) byFav.get(key)!.locations.add(loc.name)
      }
    }
  }

  return [...byFav.values()].map((entry) => ({
    name: entry.name,
    locations: [...entry.locations],
  }))
}
