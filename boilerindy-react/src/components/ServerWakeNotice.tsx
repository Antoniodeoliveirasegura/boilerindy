import { useEffect } from 'react'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { startServerWarmup, useServerWarmup } from '../lib/serverWarmup'

// Explains the Render cold start instead of leaving a blank-looking page
// (issue #164). Sends the warm-up ping as soon as the app mounts and shows a
// small pill only once that ping has dragged on long enough to be noticed
// ('slow'). The pill goes away the moment the server answers, and also when
// the ping fails outright, where each page's own error handling takes over.
// Renders nothing otherwise, so it costs nothing while the server is warm.

export default function ServerWakeNotice() {
  const { status } = useServerWarmup()
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    // Idempotent, so StrictMode's double mount still sends a single request.
    void startServerWarmup()
  }, [])

  if (status !== 'slow') return null

  // Layering: above the fixed app header (z-[1100]) and the mobile bottom nav
  // (z-40), below menu backdrops (z-[1500]) and dialogs (z-[2000]). The wrapper
  // ignores the pointer so the pill never blocks a tap on whatever is under it.
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top,0px)] z-[1200] flex justify-center px-4 pt-3">
      <div
        role="status"
        aria-live="polite"
        data-testid="server-wake-notice"
        className="flex max-w-md items-center gap-3 rounded-full border border-[var(--color-border-2)] bg-[var(--color-surface)] px-4 py-2 text-[12px] leading-snug text-[var(--color-txt-2)] shadow-[var(--shadow-md)]"
      >
        <span
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 rounded-full border-2 border-[var(--color-gold)] border-t-transparent ${reducedMotion ? '' : 'animate-spin'}`}
        />
        <p>
          <span className="font-semibold text-[var(--color-txt-0)]">Waking up the server.</span> The first visit after a quiet spell can take up to 30 seconds.
        </p>
      </div>
    </div>
  )
}
