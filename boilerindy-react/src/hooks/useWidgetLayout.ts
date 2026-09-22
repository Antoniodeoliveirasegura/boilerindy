import { useCallback, useEffect, useState } from 'react'
import { authRequest } from '../lib/authApi'
import { createWholeValueSaves, writeFailureMessage, type RefusedSave } from '../lib/writeFailure'

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
  // Why the last layout change did not save (issue #202). A refused PUT (the
  // user-write limiter's 429) puts back the layout the server last accepted,
  // so the board never shows an arrangement the next load would drop. A
  // network or 5xx failure keeps the change on screen and in the cache, and
  // the next successful PUT carries it.
  const [saveError, setSaveError] = useState('')
  // One bookkeeping object for the hook's lifetime, seeded with the layout the
  // board first painted (the cache, or the default).
  const [saves] = useState(() => createWholeValueSaves<WidgetLayoutEntry[]>(layout))

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = (await authRequest(endpoint)) as { layout?: unknown }
        if (cancelled) return
        const next = normalizeLayout(data?.layout)
        setLayout(next)
        saveLocalLayout(userId, next)
        saves.loaded(next)
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
  }, [userId, endpoint, defaultLayout, normalizeLayout, loadLocalLayout, saveLocalLayout, saves])

  // Single write path: normalize, cache locally, and sync to the server.
  const commit = useCallback(
    (next: WidgetLayoutEntry[]) => {
      const normalized = normalizeLayout(next)
      setLayout(normalized)
      saveLocalLayout(userId, normalized)
      setSaveError('')
      const ticket = saves.start()
      const restore = (refused: RefusedSave<WidgetLayoutEntry[]> | null) => {
        if (!refused) return
        setLayout(refused.restore)
        saveLocalLayout(userId, refused.restore)
        setSaveError(writeFailureMessage(refused.error, 'Could not save your layout. Please try again.'))
      }
      authRequest(endpoint, {
        method: 'PUT',
        body: JSON.stringify({ layout: normalized }),
      }).then(
        () => restore(saves.succeeded(ticket, normalized)),
        // offline or 5xx - localStorage copy will re-sync via the next successful PUT
        (err: unknown) => restore(saves.failed(ticket, err)),
      )
    },
    [userId, endpoint, normalizeLayout, saveLocalLayout, saves],
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

  return { layout, editing, setEditing, move, moveToTop, reorder, setVisible, setSize, reset, saveError }
}
