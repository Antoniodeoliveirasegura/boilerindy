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
  'gpa',
  'free-time',
  'todays-events',
  'tasks-due',
  'live-shuttles',
  'dining',
  'board',
  'calendar-feed',
  'sponsored',
]

const WIDGET_ID_SET = new Set(WIDGET_IDS)

// Widget widths, ordered narrowest -> widest. They map to column spans on the
// 4-column desktop dashboard grid: quarter=1, half=2, three-quarter=3, full=4.
// The order matters: the edit UI steps a widget up/down through this list.
export const WIDGET_SIZES = ['quarter', 'half', 'three-quarter', 'full']
const SIZE_SET = new Set(WIDGET_SIZES)
const DEFAULT_SIZE = 'half'

// Per-widget width range. Most widgets read poorly squeezed below half width, so
// their minimum is `half` (max stays `full`). Quick actions is the exception: it
// is a grid of icon buttons that collapses cleanly into a narrow vertical strip,
// so it keeps the full quarter..full range.
const DEFAULT_ALLOWED_SIZES = WIDGET_SIZES.slice(WIDGET_SIZES.indexOf('half')) // half -> full
const WIDGET_ALLOWED_SIZES = {
  'quick-actions': WIDGET_SIZES, // quarter -> full (quarter renders as a vertical stack)
}

/** The ordered list of widths a given widget may take (narrowest -> widest). */
export function allowedSizesFor(id) {
  return WIDGET_ALLOWED_SIZES[id] || DEFAULT_ALLOWED_SIZES
}

// Clamp a canonical size into the widget's allowed range, snapping to the nearest
// end. Lets a layout saved under the old wider range (e.g. a quarter-width
// non-quick-actions widget) migrate up to that widget's new minimum.
function clampSizeForWidget(id, size) {
  const allowed = allowedSizesFor(id)
  if (allowed.includes(size)) return size
  const idx = WIDGET_SIZES.indexOf(size)
  const minSize = allowed[0]
  const maxSize = allowed[allowed.length - 1]
  if (idx > WIDGET_SIZES.indexOf(maxSize)) return maxSize
  return minSize
}

// Back-compat: the dashboard originally had only normal/wide. Map those onto the
// new scale so saved layouts keep their look (normal was 1-of-2 columns = half,
// wide was 2-of-2 = full).
const LEGACY_SIZE_ALIASES = { normal: 'half', wide: 'full' }

// Shown to a brand-new user (or after a reset). Order/visibility mirrors the
// current dashboard's most useful sections.
export const DEFAULT_LAYOUT = [
  { id: 'week-ahead', size: 'full', visible: true },
  { id: 'smart-alerts', size: 'full', visible: true },
  { id: 'quick-actions', size: 'full', visible: true },
  { id: 'next-class', size: 'half', visible: true },
  { id: 'gpa', size: 'half', visible: true },
  { id: 'free-time', size: 'half', visible: true },
  { id: 'todays-events', size: 'half', visible: true },
  { id: 'tasks-due', size: 'half', visible: true },
  { id: 'live-shuttles', size: 'half', visible: true },
  { id: 'dining', size: 'half', visible: true },
  { id: 'board', size: 'half', visible: true },
  { id: 'sponsored', size: 'half', visible: true },
  { id: 'calendar-feed', size: 'half', visible: false },
]

// Clamp an arbitrary size to the allowed set, migrating legacy names and
// falling back to DEFAULT_SIZE for anything unrecognised.
function normalizeSize(size) {
  if (SIZE_SET.has(size)) return size
  if (Object.prototype.hasOwnProperty.call(LEGACY_SIZE_ALIASES, size)) {
    return LEGACY_SIZE_ALIASES[size]
  }
  return DEFAULT_SIZE
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (!WIDGET_ID_SET.has(entry.id)) return null
  return {
    id: entry.id,
    size: clampSizeForWidget(entry.id, normalizeSize(entry.size)),
    // Default to visible unless explicitly disabled.
    visible: entry.visible !== false,
  }
}

/**
 * Sanitize an arbitrary value into a valid layout array:
 * - drops non-objects and unknown widget ids
 * - de-duplicates by id (first occurrence wins)
 * - clamps size to the allowed set (migrating legacy normal/wide)
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
      result.push({ id, size: fallback?.size || DEFAULT_SIZE, visible: false })
    }
  }

  return result
}

/** A fresh copy of the default layout (never hand out the shared reference). */
export function defaultLayout() {
  return DEFAULT_LAYOUT.map((w) => ({ ...w }))
}
