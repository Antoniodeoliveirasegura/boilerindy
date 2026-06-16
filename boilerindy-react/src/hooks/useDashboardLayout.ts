import {
  defaultLayout,
  normalizeLayout,
  loadLocalLayout,
  saveLocalLayout,
} from '../lib/dashboardLayoutStore'
import { useWidgetLayout, type WidgetLayoutEntry } from './useWidgetLayout'

// Home dashboard layout (issue #52). Thin wrapper over the generic
// useWidgetLayout, wiring it to the home board's endpoint + store. The shared
// hook owns all reorder/resize/hide/persist logic so the home dashboard and the
// Services board behave identically. Migrated to TypeScript (issue #20).

export type DashboardWidget = WidgetLayoutEntry

export function useDashboardLayout(userId: string | null | undefined) {
  return useWidgetLayout({
    userId,
    endpoint: '/api/me/dashboard',
    defaultLayout,
    normalizeLayout,
    loadLocalLayout,
    saveLocalLayout,
  })
}
