// dashboardLayout.mjs
//
// Pure validation/normalization for the customizable home dashboard (issue #52).
// The layout is a per-user ordered list of widgets, each with a display size.
// Kept I/O-free so the rules are unit-testable and shared verbatim by the server
// (PUT /api/me/dashboard) and the frontend. Untrusted input (DB row, request
// body, localStorage) is always run through normalizeLayout before use.

// The canonical widget catalogue. Unknown ids in stored/submitted layouts are
// dropped, so retiring or renaming a widget never breaks an existing user.
export const WIDGET_IDS = [
  'week-ahead',
  'smart-alerts',
  'quick-actions',
  'next-class',
  'free-time',
  'todays-events',
  'tasks-due',
  'live-shuttles',
  'dining',
  'board',
  'calendar-feed',
]

const WIDGET_ID_SET = new Set(WIDGET_IDS)
export const WIDGET_SIZES = ['normal', 'wide']
const SIZE_SET = new Set(WIDGET_SIZES)

// Shown to a brand-new user (or after a reset). Order/visibility mirrors the
// current dashboard's most useful sections.
export const DEFAULT_LAYOUT = [
  { id: 'week-ahead', size: 'wide', visible: true },
  { id: 'smart-alerts', size: 'wide', visible: true },
  { id: 'quick-actions', size: 'wide', visible: true },
  { id: 'next-class', size: 'normal', visible: true },
  { id: 'free-time', size: 'normal', visible: true },
  { id: 'todays-events', size: 'normal', visible: true },
  { id: 'tasks-due', size: 'normal', visible: true },
  { id: 'live-shuttles', size: 'normal', visible: true },
  { id: 'dining', size: 'normal', visible: true },
  { id: 'board', size: 'normal', visible: true },
  { id: 'calendar-feed', size: 'normal', visible: false },
]

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (!WIDGET_ID_SET.has(entry.id)) return null
  return {
    id: entry.id,
    size: SIZE_SET.has(entry.size) ? entry.size : 'normal',
    // Default to visible unless explicitly disabled.
    visible: entry.visible !== false,
  }
}

/**
 * Sanitize an arbitrary value into a valid layout array:
 * - drops non-objects and unknown widget ids
 * - de-duplicates by id (first occurrence wins)
 * - clamps size to the allowed set
 * - appends any catalogue widgets missing from the input (hidden), so newly
 *   added widgets surface for existing users without wiping their order
 *
 * @param {unknown} input
 * @returns {{id: string, size: string, visible: boolean}[]}
 */
export function normalizeLayout(input) {
  const source = Array.isArray(input) ? input : []
  const seen = new Set()
  const result = []

  for (const entry of source) {
    const normalized = normalizeEntry(entry)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    result.push(normalized)
  }

  // Surface any catalogue widget the stored layout never mentioned, hidden by
  // default so it does not rearrange the user's chosen layout unannounced.
  for (const id of WIDGET_IDS) {
    if (!seen.has(id)) {
      const fallback = DEFAULT_LAYOUT.find((w) => w.id === id)
      result.push({ id, size: fallback?.size || 'normal', visible: false })
    }
  }

  return result
}

/** A fresh copy of the default layout (never hand out the shared reference). */
export function defaultLayout() {
  return DEFAULT_LAYOUT.map((w) => ({ ...w }))
}
