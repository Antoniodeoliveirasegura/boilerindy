// widgetLayout.mjs
//
// Generic, I/O-free validation/normalization for a customizable widget board.
// A board is a per-user ordered list of widgets, each with a display size +
// visibility. Extracted from the home dashboard (issue #52) so the Services
// board can reuse the exact same rules with its own widget catalogue - the two
// boards never share a catalogue but they do share this normalization logic,
// keeping behaviour identical and the rules unit-testable.
//
// Untrusted input (DB row, request body, localStorage) is always run through a
// board's normalizeLayout before use.

// Widget widths, ordered narrowest -> widest. They map to column spans on the
// 4-column desktop grid: quarter=1, half=2, three-quarter=3, full=4. The order
// matters: the edit UI steps a widget up/down through this list.
export const WIDGET_SIZES = ['quarter', 'half', 'three-quarter', 'full']
const SIZE_SET = new Set(WIDGET_SIZES)
const DEFAULT_SIZE = 'half'

// Back-compat: the dashboard originally had only normal/wide. Map those onto the
// new scale so saved layouts keep their look (normal = half, wide = full). Newer
// boards never used these names, so the aliases are simply inert for them.
const LEGACY_SIZE_ALIASES = { normal: 'half', wide: 'full' }

/**
 * Build a board's pure layout helpers from its widget catalogue.
 *
 * @param {object} config
 * @param {string[]} config.widgetIds
 *   Canonical widget id catalogue. Unknown ids in stored/submitted layouts are
 *   dropped, so retiring or renaming a widget never breaks an existing user.
 * @param {{id: string, size: string, visible: boolean}[]} config.defaultLayout
 *   Shown to a brand-new user (or after a reset).
 * @param {Record<string, string[]>} [config.allowedSizesByWidget]
 *   Per-widget width range overrides. Anything not listed uses the default range.
 * @param {string} [config.defaultMinSize]
 *   Minimum width for widgets without an override (default 'half'); most widgets
 *   read poorly squeezed below half width.
 *
 * Return type is intentionally left to inference so the precise
 * {id, size, visible}[] shapes flow through to the TypeScript callers.
 */
export function createWidgetLayout(config) {
  const WIDGET_IDS = config.widgetIds
  const WIDGET_ID_SET = new Set(WIDGET_IDS)
  const DEFAULT_LAYOUT = config.defaultLayout
  const WIDGET_ALLOWED_SIZES = config.allowedSizesByWidget || {}
  const defaultMin = config.defaultMinSize || 'half'
  const DEFAULT_ALLOWED_SIZES = WIDGET_SIZES.slice(WIDGET_SIZES.indexOf(defaultMin))

  /** The ordered list of widths a given widget may take (narrowest -> widest). */
  function allowedSizesFor(id) {
    return WIDGET_ALLOWED_SIZES[id] || DEFAULT_ALLOWED_SIZES
  }

  // Clamp a canonical size into the widget's allowed range, snapping to the
  // nearest end. Lets a layout saved under an old wider range migrate up to that
  // widget's new minimum.
  function clampSizeForWidget(id, size) {
    const allowed = allowedSizesFor(id)
    if (allowed.includes(size)) return size
    const idx = WIDGET_SIZES.indexOf(size)
    const minSize = allowed[0]
    const maxSize = allowed[allowed.length - 1]
    if (idx > WIDGET_SIZES.indexOf(maxSize)) return maxSize
    return minSize
  }

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
   */
  function normalizeLayout(input) {
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
  function defaultLayout() {
    return DEFAULT_LAYOUT.map((w) => ({ ...w }))
  }

  return {
    WIDGET_IDS,
    WIDGET_SIZES,
    DEFAULT_LAYOUT,
    allowedSizesFor,
    normalizeLayout,
    defaultLayout,
  }
}
