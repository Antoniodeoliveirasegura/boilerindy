// Dining favorites helpers (issue #49). Mirrors the server-side normalization
// in src/diningFavorites.mjs so the frontend can match favorited names against
// the live menu snapshot. Kept here (not shared) because the React app is a
// separate package from the Express server.

export const MAX_ITEM_NAME = 200

/**
 * @param {unknown} name
 * @returns {string} normalized favorite key, or '' when unusable
 */
export function normalizeItemName(name) {
  if (typeof name !== 'string') return ''
  return name.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_ITEM_NAME)
}

/**
 * Cross-reference favorited item names against today's dining snapshot.
 * @param {Iterable<string>} favoriteNames - normalized favorite keys
 * @param {Array<{ name: string, stations?: Array<{ items?: Array<{ name: string }> }> }>} locations
 * @returns {Array<{ name: string, locations: string[] }>} favorites on today's
 *   menus with the display name and the locations serving them
 */
export function favoritesOnTodaysMenu(favoriteNames, locations) {
  const favs = favoriteNames instanceof Set ? favoriteNames : new Set(favoriteNames || [])
  if (favs.size === 0 || !Array.isArray(locations)) return []

  const byFav = new Map() // normalized key -> { name, locations: Set<string> }
  for (const loc of locations) {
    for (const station of loc?.stations || []) {
      for (const item of station?.items || []) {
        const key = normalizeItemName(item?.name)
        if (!key || !favs.has(key)) continue
        if (!byFav.has(key)) byFav.set(key, { name: item.name, locations: new Set() })
        if (loc?.name) byFav.get(key).locations.add(loc.name)
      }
    }
  }

  return [...byFav.values()].map((entry) => ({
    name: entry.name,
    locations: [...entry.locations],
  }))
}
