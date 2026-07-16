/**
 * Frontend persistence + helpers for the customizable home dashboard (issue #52).
 *
 * The validation rules live in the backend `src/dashboardLayout.mjs`, shared
 * verbatim by the server (PUT /api/me/dashboard) and the frontend so the widget
 * catalogue can never drift. This module only adds the browser-side localStorage
 * cache, keyed by backend user id (mirrors the taskLocalStore pattern), used as
 * an offline/optimistic fallback when the API is unreachable.
 * Migrated to TypeScript (issue #20).
 */
import {
  WIDGET_IDS,
  WIDGET_SIZES,
  DEFAULT_LAYOUT,
  normalizeLayout,
  defaultLayout,
  allowedSizesFor,
} from '../../../src/dashboardLayout.mjs'

export { WIDGET_IDS, WIDGET_SIZES, DEFAULT_LAYOUT, normalizeLayout, defaultLayout, allowedSizesFor }

function storageKey(userId: string): string {
  return `boilerindy-dashboard-layout-v1-${userId}`
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
    /* storage unavailable / quota - DB copy remains the source of truth */
  }
}
