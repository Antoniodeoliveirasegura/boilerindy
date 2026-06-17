// Neighborhood Guide (issue #31). Student-submitted local recommendations
// (food, study spots, parking, safety). Pure validation/mapping helpers kept
// here so the request shaping is unit-testable without the DB or HTTP layer.

export const GUIDE_CATEGORIES = ['food', 'study', 'parking', 'safety', 'other']
const GUIDE_CATEGORY_SET = new Set(GUIDE_CATEGORIES)

export const MAX_GUIDE_TITLE = 120
export const MAX_GUIDE_BODY = 1000
export const MAX_PLACE_NAME = 120

function parseCoord(value, max) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n < -max || n > max) return { ok: false }
  return { ok: true, value: n }
}

/**
 * Validate + coerce a guide submission into DB columns.
 * @returns {{ value: object } | { error: string }}
 */
export function validateGuideInput(body) {
  const category = String(body?.category ?? '').trim().toLowerCase()
  if (!GUIDE_CATEGORY_SET.has(category)) {
    return { error: `Category must be one of: ${GUIDE_CATEGORIES.join(', ')}` }
  }

  const title = String(body?.title ?? '').trim()
  if (!title || title.length > MAX_GUIDE_TITLE) {
    return { error: `Title is required (max ${MAX_GUIDE_TITLE} characters)` }
  }

  const text = String(body?.body ?? '').trim()
  if (text.length > MAX_GUIDE_BODY) {
    return { error: `Description must be ${MAX_GUIDE_BODY} characters or fewer` }
  }

  const placeNameRaw = String(body?.placeName ?? body?.place_name ?? '').trim()
  const placeName = placeNameRaw ? placeNameRaw.slice(0, MAX_PLACE_NAME) : null

  const lat = parseCoord(body?.lat, 90)
  const lng = parseCoord(body?.lng, 180)
  if (!lat.ok || !lng.ok) return { error: 'Latitude/longitude are out of range' }
  // Coordinates only count when both are present.
  const hasCoords = lat.value !== null && lng.value !== null

  return {
    value: {
      category,
      title,
      body: text,
      place_name: placeName,
      lat: hasCoords ? lat.value : null,
      lng: hasCoords ? lng.value : null,
    },
  }
}

/**
 * Shape a DB row for the API response.
 */
export function mapGuideRow(row, currentUserId, upvotedRecIds = new Set()) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body || '',
    placeName: row.place_name || null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    upvotes: row.upvote_count ?? 0,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    upvotedByMe: upvotedRecIds.has(row.id),
    isMine: row.user_id === currentUserId,
  }
}
