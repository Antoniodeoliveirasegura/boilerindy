// The motion system's few lines of script (docs/motion.md). Every animation is
// CSS in index.css; these only decide when an attribute goes on or comes off,
// and when an exit has finished.

/** Whether this browser has the Web Animations API. jsdom, under the unit tests, does not. */
export function canAnimate(): boolean {
  return typeof document !== 'undefined' && typeof document.documentElement?.getAnimations === 'function'
}

/**
 * The animations and transitions running in `el` and under it that end on
 * their own: a spinner or a pulsing dot never does, so it is left out.
 */
export function finiteAnimations(el: Element): Animation[] {
  if (typeof el.getAnimations !== 'function') return []
  return el.getAnimations({ subtree: true }).filter((animation) => {
    const end = animation.effect?.getComputedTiming().endTime
    return typeof end === 'number' && Number.isFinite(end)
  })
}

/** Resolves once every one of `animations` has finished or been cancelled. */
export function whenSettled(animations: Animation[]): Promise<void> {
  return Promise.allSettled(animations.map((animation) => animation.finished)).then(() => undefined)
}

/** The keyframes rows and page blocks rise on (index.css). */
const RISE = 'motion-rise'

function risesIn(el: Element): Animation[] {
  return finiteAnimations(el).filter((animation) => (animation as Animation & { animationName?: string }).animationName === RISE)
}

/**
 * Puts `attribute` on `el`, which starts the rise index.css hangs on it, and
 * takes it off once every rise under `el` has finished, so a re-render, a
 * refetch or a reorder cannot replay it. Rises that start meanwhile (a block
 * that renders a moment later) are waited for too, each one once: an
 * animation still listed after it finished (a forwards fill) cannot hold the
 * attribute on. Does nothing without the Web Animations API. The returned
 * cleanup takes the attribute off at once.
 */
export function riseOnce(el: HTMLElement, attribute: string): () => void {
  if (!canAnimate()) return () => {}
  let live = true
  const waited = new WeakSet<Animation>()
  el.setAttribute(attribute, '')
  const settle = () => {
    if (!live) return
    const running = risesIn(el).filter((animation) => !waited.has(animation))
    if (running.length === 0) {
      el.removeAttribute(attribute)
      return
    }
    for (const animation of running) waited.add(animation)
    void whenSettled(running).then(settle)
  }
  settle()
  return () => {
    live = false
    el.removeAttribute(attribute)
  }
}

/**
 * Which navigations move to another page, for the route entrance in
 * AppLayout. The admin console's sections share one layout, so moving between
 * them is not a new page; everywhere else a new path is. Query strings and
 * hashes (a filter, a tab) never are.
 */
export function routeEntranceKey(pathname: string): string {
  const path = pathname.replace(/\/+$/, '').toLowerCase() || '/'
  return path === '/admin' || path.startsWith('/admin/') ? '/admin' : path
}
