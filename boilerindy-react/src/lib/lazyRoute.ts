import { createElement, lazy, useState, type ComponentType } from 'react'

// A page chunk that will not load is usually one a new deploy removed: this
// tab still runs the old build, and Vercel answers the old hashed file with
// index.html. React.lazy remembers the failure for good, so the route stayed
// broken and the crash screen replaced the whole app. Reload once to pick up
// the new build; a second failure soon after (offline, or a real bug in the
// chunk) is left to the error boundaries, so this can never loop.
const RELOAD_KEY = 'pih-chunk-reload-at'
const RELOAD_WINDOW_MS = 30_000

export function reloadOnceForFailedChunk(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    if (now - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    // Without storage there is no loop guard, so do not reload at all.
    return false
  }
  window.location.reload()
  return true
}

/** A route page that can be fetched ahead of a visit. */
export type RoutePage<P extends object> = ComponentType<P> & { preload: () => void }

/**
 * React.lazy for a route page, with the one-time reload above and a preload.
 *
 * Router transitions are off (App.tsx), so a page that suspends shows the
 * loader, and React keeps it up for at least 300 ms even when the chunk is
 * already there: React.lazy suspends once on first render whatever the state
 * of its promise. So a page whose module has loaded (preloaded, or visited
 * before) is rendered directly and never suspends; only one that is still
 * downloading goes through React.lazy and shows the loader.
 */
export function lazyRoute<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): RoutePage<P> {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<{ default: ComponentType<P> }> | null = null
  const fetchModule = () => {
    pending ??= load().then(
      (mod) => {
        loaded = mod.default
        return mod
      },
      (error: unknown) => {
        // Let a later visit or preload try again.
        pending = null
        throw error
      },
    )
    return pending
  }
  const Lazy = lazy(() =>
    fetchModule().catch((error: unknown) => {
      // Never settle while the reload takes over, so the page loader stays up
      // instead of a crash screen flashing first.
      if (reloadOnceForFailedChunk()) return new Promise<never>(() => {})
      throw error
    }),
  )
  function RoutePage(props: P) {
    // Decided once per mount, so a module that finishes loading while this
    // page is up never swaps the element type under it (that would remount it).
    const [Ready] = useState(() => loaded)
    return Ready ? createElement(Ready, props) : createElement(Lazy, props)
  }
  RoutePage.preload = () => {
    // A failed preload is not an error yet; the visit itself will retry.
    fetchModule().catch(() => {})
  }
  return RoutePage
}
