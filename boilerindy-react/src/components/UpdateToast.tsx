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

  // Sits above the mobile bottom nav (z-40) and below dialogs (z-[2000]), like
  // ServerWakeNotice; the bottom offset clears the nav on phones.
  return (
    <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+84px)] z-[1200] flex justify-center px-4 md:bottom-6">
      <div
        role="status"
        aria-live="polite"
        data-testid="sw-update-toast"
        className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-[var(--color-border-2)] bg-[var(--color-surface)] px-4 py-3 text-[13px] leading-snug text-[var(--color-txt-2)] shadow-[var(--shadow-md)]"
      >
        <p className="flex-1">
          <span className="font-semibold text-[var(--color-txt-0)]">A new version of BoilerIndy is ready.</span> Refresh to get it.
        </p>
        <button type="button" onClick={refresh} className="btn btn-primary shrink-0 px-3 py-1.5 text-[12px]">
          Refresh
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="btn shrink-0 px-2 py-1.5 text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]"
        >
          Later
        </button>
      </div>
    </div>
  )
}
