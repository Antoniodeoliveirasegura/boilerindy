import { useEffect } from 'react'
import { useMatch } from 'react-router-dom'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { SERVER_WAKE_DETAIL, SERVER_WAKE_LEAD, startServerWarmup, useServerWarmup } from '../lib/serverWarmup'

// Explains the Render cold start instead of leaving a blank-looking page
// (issue #164). Sends the warm-up ping as soon as the app mounts and shows a
// small pill only once that ping has dragged on long enough to be noticed
// ('slow'). The pill goes away the moment the server answers, and also when
// the ping fails outright, where each page's own error handling takes over.
// Renders nothing otherwise, so it costs nothing while the server is warm.
// The sign-in page still sends the ping but shows no pill: it says the same
// thing in its own status line, where the student is waiting (issue #389).

export default function ServerWakeNotice() {
  const { status } = useServerWarmup()
  const reducedMotion = usePrefersReducedMotion()
  const onSignIn = useMatch('/login') != null

  useEffect(() => {
    // Idempotent, so StrictMode's double mount still sends a single request.
    void startServerWarmup()
  }, [])

  if (status !== 'slow' || onSignIn) return null

  // Layering: above the fixed app header (z-[1100]) and the mobile bottom nav
  // (z-40), below menu backdrops (z-[1500]) and dialogs (z-[2000]). The wrapper
  // ignores the pointer so the pill never blocks a tap on whatever is under it.
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top,0px)] z-[1200] flex justify-center px-4 pt-3">
      <div
        role="status"
        aria-live="polite"
        data-testid="server-wake-notice"
        className="on-ink flex max-w-md items-center gap-3 rounded-[var(--radius-lg)] border border-white/15 bg-[var(--color-ink)] px-4 py-2.5 text-[12.5px] leading-snug text-[var(--color-ink-dim)] shadow-[var(--shadow-lg)]"
      >
        <span
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 rounded-full border-2 border-[var(--color-ink-signal)] border-t-transparent ${reducedMotion ? '' : 'animate-spin'}`}
        />
        <p>
          <span className="font-display font-extrabold text-[var(--color-ink-txt)]">{SERVER_WAKE_LEAD}</span> {SERVER_WAKE_DETAIL}
        </p>
      </div>
    </div>
  )
}
