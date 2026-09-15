/**
 * Frontend persistence + helpers for the customizable Student Services board.
 *
 * Mirrors dashboardLayoutStore.ts: the validation rules live in the backend
 * `src/servicesLayout.mjs`, shared verbatim by the server (PUT /api/me/services)
 * and the frontend so the widget catalogue can never drift. This module only
 * adds the browser-side localStorage cache, keyed by backend user id via
 * createLocalLayoutStore (issue #219), used as an offline/optimistic fallback
 * when the API is unreachable.
 */
import {
  WIDGET_IDS,
  WIDGET_SIZES,
  DEFAULT_LAYOUT,
  normalizeLayout,
  defaultLayout,
  allowedSizesFor,
} from '../../../src/servicesLayout.mjs'
import { createLocalLayoutStore } from './createLocalLayoutStore'

export { WIDGET_IDS, WIDGET_SIZES, DEFAULT_LAYOUT, normalizeLayout, defaultLayout, allowedSizesFor }

export const { loadLocalLayout, saveLocalLayout } = createLocalLayoutStore(
  'boilerindy-services-layout-v1-',
  { normalizeLayout },
)
