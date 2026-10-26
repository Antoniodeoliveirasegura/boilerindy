import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { canAnimate, finiteAnimations, whenSettled } from '../lib/motion'

type PresenceState = { open: boolean; mounted: boolean; opening: number }

/**
 * What usePresence hands an overlay. Destructure it: the React Compiler's lint
 * types whatever goes into a `ref` prop as a ref, and an object read for one
 * (`presence.attach`) becomes a ref whose other fields it then refuses during
 * render.
 */
export type Presence<T extends Element = HTMLDivElement> = {
  /** A callback ref for the overlay's root. */
  attach: (el: T | null) => void
  mounted: boolean
  motion: 'open' | 'closed'
  opening: number
}

/**
 * Keeps an overlay (a dialog, a menu, a toast) on the page while it animates
 * out (docs/motion.md). Put `ref={attach}` and `data-motion={motion}` on its root:
 * "open" plays the entrance in index.css and "closed" the exit. While closed
 * it is still mounted but takes no taps; give it `inert` too. It unmounts once
 * the exit's animations finish, and at once without the Web Animations API, so
 * the unit tests (jsdom) see a dialog leave in the commit that closes it.
 * Focus goes back to the opener when `open` turns false, not on unmount: keep
 * that in effects keyed on `open`. `opening` counts the openings, for a key
 * that gives every opening a fresh form.
 */
export function usePresence<T extends Element = HTMLDivElement>(open: boolean): Presence<T> {
  const node = useRef<T | null>(null)
  const attach = useCallback((el: T | null) => {
    node.current = el
  }, [])
  const [state, setState] = useState<PresenceState>({ open, mounted: open, opening: open ? 1 : 0 })
  if (state.open !== open) {
    setState({ open, mounted: open || state.mounted, opening: open ? state.opening + 1 : state.opening })
  }
  const leaving = !open && state.mounted && canAnimate()

  useLayoutEffect(() => {
    if (!leaving) return undefined
    let live = true
    void whenSettled(node.current ? finiteAnimations(node.current) : []).then(() => {
      if (live) setState((s) => (s.open ? s : { ...s, mounted: false }))
    })
    return () => {
      live = false
    }
  }, [leaving])

  return { attach, mounted: open || leaving, motion: open ? 'open' : 'closed', opening: state.opening }
}
