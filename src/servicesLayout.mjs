// servicesLayout.mjs
//
// The Student Services page's widget catalogue. Mirrors dashboardLayout.mjs but
// for the /services board: the customizable widgets are the In-App Shortcuts
// card plus the resource-group cards (Academic Support, Transit & Dining, etc.).
// Normalization rules are shared verbatim via the `widgetLayout.mjs` factory, so
// the Services board behaves exactly like the home dashboard. Shared by the
// server (PUT /api/me/services) and the frontend; untrusted input (DB row,
// request body, localStorage) is always run through normalizeLayout before use.

import { createWidgetLayout, WIDGET_SIZES } from './widgetLayout.mjs'

// The canonical Services widget catalogue. Unknown ids in stored/submitted
// layouts are dropped, so retiring or renaming a widget never breaks a user.
export const WIDGET_IDS = [
  'in-app-shortcuts',
  'academic-support',
  'transit-and-dining',
  'campus-life-and-careers',
  'health-and-wellness',
]

// Shown to a brand-new user (or after a reset). In-App Shortcuts leads at full
// width (it is a dense link grid); the four resource groups follow at half width
// in two rows, matching the page's previous two-column resource layout.
export const DEFAULT_LAYOUT = [
  { id: 'in-app-shortcuts', size: 'full', visible: true },
  { id: 'academic-support', size: 'half', visible: true },
  { id: 'transit-and-dining', size: 'half', visible: true },
  { id: 'campus-life-and-careers', size: 'half', visible: true },
  { id: 'health-and-wellness', size: 'half', visible: true },
]

// Every Services widget is a card of links/lists that reads poorly below half
// width, so they all use the default half -> full range (no per-widget override).
const board = createWidgetLayout({
  widgetIds: WIDGET_IDS,
  defaultLayout: DEFAULT_LAYOUT,
  defaultMinSize: 'half',
})

export { WIDGET_SIZES }
export const allowedSizesFor = board.allowedSizesFor
export const normalizeLayout = board.normalizeLayout
export const defaultLayout = board.defaultLayout
