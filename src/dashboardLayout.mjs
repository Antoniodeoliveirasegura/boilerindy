// dashboardLayout.mjs
//
// The home dashboard's widget catalogue (issue #52). The per-user layout is an
// ordered list of widgets, each with a display size. The normalization rules now
// live in the shared, I/O-free `widgetLayout.mjs` factory so the Services board
// can reuse them verbatim; this module just supplies the home catalogue and
// re-exports the resulting helpers. Shared verbatim by the server
// (PUT /api/me/dashboard) and the frontend. Untrusted input (DB row, request
// body, localStorage) is always run through normalizeLayout before use.

import { createWidgetLayout, WIDGET_SIZES } from './widgetLayout.mjs'

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

// Most widgets read poorly squeezed below half width, so the default range is
// half -> full. Quick actions is the exception: it is a grid of icon buttons
// that collapses cleanly into a narrow vertical strip, so it keeps the full
// quarter -> full range.
const board = createWidgetLayout({
  widgetIds: WIDGET_IDS,
  defaultLayout: DEFAULT_LAYOUT,
  allowedSizesByWidget: { 'quick-actions': WIDGET_SIZES },
  defaultMinSize: 'half',
})

export { WIDGET_SIZES }
export const allowedSizesFor = board.allowedSizesFor
export const normalizeLayout = board.normalizeLayout
export const defaultLayout = board.defaultLayout
