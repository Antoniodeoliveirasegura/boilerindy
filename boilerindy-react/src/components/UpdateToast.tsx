import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { applyUpdate, registerServiceWorker, type RegistrationLike } from '../lib/swUpdate'

// Registers the service worker (production only, so dev assets are never
// cached) and offers a refresh once a new version is installed and waiting
// (issue #220). Renders nothing until then. `register`, `apply` and `enabled`
// are props only so tests can drive it without a real worker.

// The space left between this toast and the session-expiry alert stacked on it.
const STACK_GAP_PX = 8

type Props = {
  enabled?: boolean
  register?: (opts: { onUpdateReady: (r: RegistrationLike) => void }) => Promise<RegistrationLike | null>
  apply?: (registration: RegistrationLike) => void
}

export default function UpdateToast({
  enabled = import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  register = registerServiceWorker,
  apply = applyUpdate,
}: Props) {
  const [ready, setReady] = useState<RegistrationLike | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const toastRef = useRef<HTMLDivElement>(null)
  const shown = ready !== null && !dismissed

  useEffect(() => {
    if (!enabled) return
    // The registration resolves and the update callback fires asynchronously,
    // so no state is set synchronously inside the effect body.
    void register({
      onUpdateReady: (registration) => {
        setReady(registration)
        setDismissed(false)
      },
    })
  }, [enabled, register])

  const refresh = useCallback(() => {
    if (ready) apply(ready)
  }, [apply, ready])

  // SessionExpiryWatcher's alert shares this bottom slot, and this toast sits
  // over it, so the toast covered the alert's buttons when both showed. While
  // the toast is up, its height plus a gap goes on <html> as
  // --update-toast-lift, which the alert adds to its offset to stack above it.
  // Measured, not fixed, because the message wraps to more lines on phones.
  useLayoutEffect(() => {
    const el = toastRef.current
    if (!shown || !el) return undefined
    const root = document.documentElement
    const measure = () => {
      root.style.setProperty('--update-toast-lift', `${el.getBoundingClientRect().height + STACK_GAP_PX}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.removeProperty('--update-toast-lift')
    }
  }, [shown])

  if (!shown) return null

  // On phones the bottom offset clears the assistant button, which floats 76px
  // up over the 62px tab bar (56px tall), plus an 8px gap, so the toast never
  // covers the button (issue #249). It layers over the tab bar and the
  // assistant's backdrop (z-40), one step above SessionExpiryWatcher's alert
  // (z-[45]), and under the open assistant panel (z-50): at z-[1200] it sat on
  // the panel's input row on phones, so a student could not type a question
  // until they dismissed it.
  //
  // The wrapper spans the screen only to centre the card, so it lets the
  // pointer through and only the card takes it. When the wrapper took it,
  // from md its full-width band over the bottom of the page swallowed taps on
  // the assistant button and on the page beside the card.
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+140px)] z-[46] flex justify-center px-4 md:bottom-6">
      <div
        ref={toastRef}
        role="status"
        aria-live="polite"
        data-testid="sw-update-toast"
        className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border-2)] border-l-4 border-l-[var(--color-txt-0)] bg-[var(--color-surface)] py-2.5 pl-4 pr-2.5 text-[13.5px] leading-snug text-[var(--color-txt-2)] shadow-[var(--shadow-lg)]"
      >
        <p className="flex-1">
          <span className="font-display font-extrabold text-[var(--color-txt-0)]">A new version of BoilerIndy is ready.</span> Refresh to get it.
        </p>
        <button type="button" onClick={refresh} className="btn btn-primary btn-sm shrink-0">
          Refresh
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="btn btn-ghost btn-sm shrink-0"
        >
          Later
        </button>
      </div>
    </div>
  )
}
