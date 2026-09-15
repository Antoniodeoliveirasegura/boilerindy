/**
 * Frontend persistence + helpers for the customizable home dashboard (issue #52).
 *
 * The validation rules live in the backend `src/dashboardLayout.mjs`, shared
 * verbatim by the server (PUT /api/me/dashboard) and the frontend so the widget
 * catalogue can never drift. This module only adds the browser-side localStorage
 * cache, keyed by backend user id via createLocalLayoutStore (issue #219), used
 * as an offline/optimistic fallback when the API is unreachable.
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
import { createLocalLayoutStore } from './createLocalLayoutStore'

export { WIDGET_IDS, WIDGET_SIZES, DEFAULT_LAYOUT, normalizeLayout, defaultLayout, allowedSizesFor }

export const { loadLocalLayout, saveLocalLayout } = createLocalLayoutStore(
  'boilerindy-dashboard-layout-v1-',
  { normalizeLayout },
)
