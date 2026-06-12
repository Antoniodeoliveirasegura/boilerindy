import { useCallback, useEffect, useState } from 'react'
import { authRequest } from '../lib/authApi'
import {
  defaultLayout,
  normalizeLayout,
  loadLocalLayout,
  saveLocalLayout,
} from '../lib/dashboardLayoutStore'

/**
 * Owns the customizable home dashboard layout (issue #52).
 *
 * Lifecycle:
 * - Initial state is the cached layout (instant paint) or the default.
 * - On mount / user change it GETs /api/me/dashboard (the cross-device source of
 *   truth) and adopts it; if that fails it falls back to localStorage, then to
 *   the default — so a brand-new user always sees DEFAULT_LAYOUT.
 * - Every mutation is normalized, written to localStorage immediately, and
 *   PUT to the server (fire-and-forget; the local copy keeps the UI responsive
 *   if the network drops).
 *
 * All layout values are run through normalizeLayout (the shared validator) so
 * unknown ids and bad sizes can never reach render.
 *
 * @param {string | null | undefined} userId backend user id (from useAuth)
 */
export function useDashboardLayout(userId) {
  const [layout, setLayout] = useState(() => loadLocalLayout(userId) || defaultLayout())
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await authRequest('/api/me/dashboard')
        if (cancelled) return
        const next = normalizeLayout(data?.layout)
        setLayout(next)
        saveLocalLayout(userId, next)
      } catch {
        if (cancelled) return
        const cached = loadLocalLayout(userId)
        if (cached) setLayout(cached)
        // else: keep the default already in state
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  // Single write path: normalize, cache locally, and sync to the server.
  const commit = useCallback(
    (next) => {
      const normalized = normalizeLayout(next)
      setLayout(normalized)
      saveLocalLayout(userId, normalized)
      authRequest('/api/me/dashboard', {
        method: 'PUT',
        body: JSON.stringify({ layout: normalized }),
      }).catch(() => {
        /* offline — localStorage copy will re-sync via the next successful PUT */
      })
    },
    [userId],
  )

  // Move a widget one slot up/down among the *visible* widgets (skips hidden
  // entries so keyboard reordering matches what the user sees). dir: -1 | +1.
  const move = useCallback(
    (id, dir) => {
      const idx = layout.findIndex((w) => w.id === id)
      if (idx < 0) return
      let target = idx + dir
      while (target >= 0 && target < layout.length && !layout[target].visible) {
        target += dir
      }
      if (target < 0 || target >= layout.length) return
      const targetId = layout[target].id
      const next = layout.slice()
      const [moved] = next.splice(idx, 1)
      const insertAt = next.findIndex((w) => w.id === targetId) + (dir > 0 ? 1 : 0)
      next.splice(insertAt, 0, moved)
      commit(next)
    },
    [layout, commit],
  )

  // Drag-and-drop reorder: drop `fromId` onto `toId`'s slot.
  const reorder = useCallback(
    (fromId, toId) => {
      if (!fromId || fromId === toId) return
      const from = layout.findIndex((w) => w.id === fromId)
      const to = layout.findIndex((w) => w.id === toId)
      if (from < 0 || to < 0) return
      const next = layout.slice()
      const [moved] = next.splice(from, 1)
      const insertAt = next.findIndex((w) => w.id === toId)
      next.splice(insertAt, 0, moved)
      commit(next)
    },
    [layout, commit],
  )

  const setVisible = useCallback(
    (id, visible) => {
      commit(layout.map((w) => (w.id === id ? { ...w, visible } : w)))
    },
    [layout, commit],
  )

  const reset = useCallback(() => commit(defaultLayout()), [commit])

  return { layout, editing, setEditing, move, reorder, setVisible, reset }
}
