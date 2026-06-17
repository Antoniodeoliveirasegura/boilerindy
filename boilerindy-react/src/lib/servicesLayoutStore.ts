/**
 * Frontend persistence + helpers for the customizable Student Services board.
 *
 * Mirrors dashboardLayoutStore.ts: the validation rules live in the backend
 * `src/servicesLayout.mjs`, shared verbatim by the server (PUT /api/me/services)
 * and the frontend so the widget catalogue can never drift. This module only
 * adds the browser-side localStorage cache, keyed by backend user id, used as an
 * offline/optimistic fallback when the API is unreachable.
 */
import {
  WIDGET_IDS,
  WIDGET_SIZES,
  DEFAULT_LAYOUT,
  normalizeLayout,
  defaultLayout,
  allowedSizesFor,
} from '../../../src/servicesLayout.mjs'

export { WIDGET_IDS, WIDGET_SIZES, DEFAULT_LAYOUT, normalizeLayout, defaultLayout, allowedSizesFor }

function storageKey(userId: string): string {
  return `boilerindy-services-layout-v1-${userId}`
}

/** Read the cached layout for a user, or null when nothing is cached. */
export function loadLocalLayout(userId: string | null | undefined) {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    return normalizeLayout(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Persist a layout to localStorage for a user. No-ops without a user id. */
export function saveLocalLayout(userId: string | null | undefined, layout: unknown): void {
  if (!userId) return
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(layout))
  } catch {
    /* storage unavailable / quota — DB copy remains the source of truth */
  }
}
