import { useCallback, useEffect, useState } from 'react'
import { authRequest } from '../lib/authApi'

// Owns a customizable widget board's layout (issue #52, generalized for the
// Services board). All layout values are run through the board's normalizeLayout
// (the shared validator) so unknown ids and bad sizes can never reach render.
// The home dashboard and the Services page each call this with their own
// endpoint + board store, so the reorder/resize/hide/persist behaviour stays
// identical across both.

export type WidgetLayoutEntry = { id: string; visible: boolean; size: string }

export type WidgetLayoutConfig = {
  userId: string | null | undefined
  /** Backend endpoint for this board, e.g. '/api/me/dashboard' or '/api/me/services'. */
  endpoint: string
  /** Board-specific helpers (stable module references - never inline these). */
  defaultLayout: () => WidgetLayoutEntry[]
  normalizeLayout: (input: unknown) => WidgetLayoutEntry[]
  loadLocalLayout: (userId: string | null | undefined) => WidgetLayoutEntry[] | null
  saveLocalLayout: (userId: string | null | undefined, layout: unknown) => void
}

export function useWidgetLayout({
  userId,
  endpoint,
  defaultLayout,
  normalizeLayout,
  loadLocalLayout,
  saveLocalLayout,
}: WidgetLayoutConfig) {
  const [layout, setLayout] = useState<WidgetLayoutEntry[]>(
    () => loadLocalLayout(userId) || defaultLayout(),
  )
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = (await authRequest(endpoint)) as { layout?: unknown }
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
  }, [userId, endpoint, defaultLayout, normalizeLayout, loadLocalLayout, saveLocalLayout])

  // Single write path: normalize, cache locally, and sync to the server.
  const commit = useCallback(
    (next: WidgetLayoutEntry[]) => {
      const normalized = normalizeLayout(next)
      setLayout(normalized)
      saveLocalLayout(userId, normalized)
      authRequest(endpoint, {
        method: 'PUT',
        body: JSON.stringify({ layout: normalized }),
      }).catch(() => {
        /* offline - localStorage copy will re-sync via the next successful PUT */
      })
    },
    [userId, endpoint, normalizeLayout, saveLocalLayout],
  )

  // Move a widget one slot up/down among the *visible* widgets. dir: -1 | +1.
  const move = useCallback(
    (id: string, dir: number) => {
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

  // Jump a widget straight to the top of the board. Goes to absolute index 0
  // (above any hidden entries too), so "top" stays top even if a hidden widget
  // above it is later un-hidden.
  const moveToTop = useCallback(
    (id: string) => {
      const idx = layout.findIndex((w) => w.id === id)
      if (idx <= 0) return
      const next = layout.slice()
      const [moved] = next.splice(idx, 1)
      next.unshift(moved)
      commit(next)
    },
    [layout, commit],
  )

  // Drag-and-drop reorder: drop `fromId` onto `toId`'s slot.
  const reorder = useCallback(
    (fromId: string, toId: string) => {
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
    (id: string, visible: boolean) => {
      commit(layout.map((w) => (w.id === id ? { ...w, visible } : w)))
    },
    [layout, commit],
  )

  const setSize = useCallback(
    (id: string, size: string) => {
      commit(layout.map((w) => (w.id === id ? { ...w, size } : w)))
    },
    [layout, commit],
  )

  const reset = useCallback(() => commit(defaultLayout()), [commit, defaultLayout])

  return { layout, editing, setEditing, move, moveToTop, reorder, setVisible, setSize, reset }
}
