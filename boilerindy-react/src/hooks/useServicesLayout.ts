import {
  defaultLayout,
  normalizeLayout,
  loadLocalLayout,
  saveLocalLayout,
} from '../lib/servicesLayoutStore'
import { useWidgetLayout } from './useWidgetLayout'

// Student Services board layout. Thin wrapper over the generic useWidgetLayout,
// wiring it to the Services board's endpoint + store so the page reuses the
// exact reorder/resize/hide/persist behaviour of the home dashboard.

export function useServicesLayout(userId: string | null | undefined) {
  return useWidgetLayout({
    userId,
    endpoint: '/api/me/services',
    defaultLayout,
    normalizeLayout,
    loadLocalLayout,
    saveLocalLayout,
  })
}
