/**
 * Extract a building code from a room string like "ET 215" → "ET".
 * Lives in its own module (not in Map.jsx) so the Map page file only
 * exports React components, keeping Fast Refresh boundaries intact.
 * Migrated to TypeScript (issue #20).
 */
export function extractBuildingCode(roomStr: string | null | undefined): string | null {
  if (!roomStr) return null
  const match = roomStr.match(/^([A-Z]{2,4})\s*\d*/i)
  return match ? match[1].toUpperCase() : null
}

/**
 * The Map page's deep link for a class room. Map.tsx resolves ?building= and
 * ?room= once its buildings load, so the link carries the building code when
 * the room starts with one and the room alone when it does not. With no room
 * (or the schedule's "Location unavailable" placeholder) it is plain /map.
 * Schedule's Find Room and Home's Get Directions both build it here: Home
 * linked to plain /map, so its primary button opened a map with nothing
 * selected.
 */
export function mapHrefForRoom(room: string | null | undefined): string {
  if (!room || !room.trim() || room === 'Location unavailable') return '/map'
  const buildingCode = extractBuildingCode(room)
  if (buildingCode) return `/map?building=${buildingCode}&room=${encodeURIComponent(room)}`
  return `/map?room=${encodeURIComponent(room)}`
}
