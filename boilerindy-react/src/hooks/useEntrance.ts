import { useCallback, useLayoutEffect, useRef } from 'react'
import { canAnimate, riseOnce } from '../lib/motion'

const REDUCE = '(prefers-reduced-motion: reduce)'

/**
 * Lets a list or grid rise in a few rows at a time (docs/motion.md): when its
 * content lands after the first render, as it replaces a skeleton (`ready`
 * turns true), and when `key` changes, as a filter does. Never on the first
 * render, where the rows were already there, and never for a refetch, a live
 * update or a reorder; a row that arrives later on its own rises by itself.
 * Inside a page that is rising in after a navigation it stays still, since
 * the page's own blocks are moving. Pass the returned ref to the element whose
 * children are the rows.
 */
export function useEntrance<T extends HTMLElement = HTMLElement>(ready: boolean, key?: unknown) {
  const node = useRef<T | null>(null)
  const last = useRef<{ ready: boolean; key: unknown } | null>(null)

  useLayoutEffect(() => {
    const previous = last.current
    last.current = { ready, key }
    const el = node.current
    if (!el || !ready || previous === null) return undefined
    if (previous.ready && Object.is(previous.key, key)) return undefined
    if (el.closest('[data-route-enter]')) return undefined
    return riseOnce(el, 'data-entering')
  }, [ready, key])

  return useCallback((el: T | null) => {
    node.current = el
    if (!el || !canAnimate() || typeof MutationObserver !== 'function') return undefined
    // Rows already there, or moved by a reorder, are not arrivals.
    const known = new WeakSet<Element>(Array.from(el.children))
    const observer = new MutationObserver((records) => {
      const quiet =
        el.hasAttribute('data-entering') ||
        el.closest('[data-route-enter]') !== null ||
        window.matchMedia?.(REDUCE).matches === true
      for (const record of records) {
        record.addedNodes.forEach((added) => {
          if (!(added instanceof HTMLElement) || known.has(added)) return
          known.add(added)
          if (quiet) return
          added.setAttribute('data-arrive', '')
          added.addEventListener('animationend', () => added.removeAttribute('data-arrive'), { once: true })
        })
      }
    })
    observer.observe(el, { childList: true })
    return () => {
      observer.disconnect()
      if (node.current === el) node.current = null
    }
  }, [])
}
