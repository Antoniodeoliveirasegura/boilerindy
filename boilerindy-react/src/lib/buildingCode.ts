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
