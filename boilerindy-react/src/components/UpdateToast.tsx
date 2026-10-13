import { useCallback, useEffect, useState } from 'react'
import { applyUpdate, registerServiceWorker, type RegistrationLike } from '../lib/swUpdate'

// Registers the service worker (production only, so dev assets are never
// cached) and offers a refresh once a new version is installed and waiting
// (issue #220). Renders nothing until then. `register`, `apply` and `enabled`
// are props only so tests can drive it without a real worker.

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

  if (!ready || dismissed) return null

  // Sits above the mobile tab bar (z-40) and below dialogs (z-[2000]), like
  // ServerWakeNotice. On phones the bottom offset clears the assistant button,
  // which floats 76px up over the 62px tab bar (56px tall), plus an 8px gap,
  // so the toast never covers the button (issue #249).
  return (
    <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+140px)] z-[1200] flex justify-center px-4 md:bottom-6">
      <div
        role="status"
        aria-live="polite"
        data-testid="sw-update-toast"
        className="flex w-full max-w-md items-center gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border-2)] border-l-4 border-l-[var(--color-txt-0)] bg-[var(--color-surface)] py-2.5 pl-4 pr-2.5 text-[13.5px] leading-snug text-[var(--color-txt-2)] shadow-[var(--shadow-lg)]"
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
