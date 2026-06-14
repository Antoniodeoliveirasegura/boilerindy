/**
 * Frontend persistence + helpers for the customizable home dashboard (issue #52).
 *
 * The validation rules live in the repo-root `dashboardLayout.mjs`, which is
 * shared verbatim by the server (PUT /api/me/dashboard) and the frontend so the
 * widget catalogue can never drift between the two. This module only adds the
 * browser-side localStorage cache, keyed by backend user id (mirrors the
 * taskLocalStore pattern), used as an offline/optimistic fallback when the API
 * is unreachable.
 */
import {
  WIDGET_IDS,
  WIDGET_SIZES,
  DEFAULT_LAYOUT,
  normalizeLayout,
  defaultLayout,
  allowedSizesFor,
} from '../../../dashboardLayout.mjs'

export {
  WIDGET_IDS,
  WIDGET_SIZES,
  DEFAULT_LAYOUT,
  normalizeLayout,
  defaultLayout,
  allowedSizesFor,
}

function storageKey(userId) {
  return `boilerindy-dashboard-layout-v1-${userId}`
}

/**
 * Read the cached layout for a user. Returns a normalized layout, or null when
 * nothing is cached / storage is unavailable (caller falls back to default).
 *
 * @param {string | null | undefined} userId
 * @returns {ReturnType<typeof normalizeLayout> | null}
 */
export function loadLocalLayout(userId) {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    return normalizeLayout(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Persist a layout to localStorage for a user. Silently no-ops without a user
 * id or when storage throws (private mode / quota).
 *
 * @param {string | null | undefined} userId
 * @param {unknown} layout
 */
export function saveLocalLayout(userId, layout) {
  if (!userId) return
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(layout))
  } catch {
    /* storage unavailable / quota — DB copy remains the source of truth */
  }
}
