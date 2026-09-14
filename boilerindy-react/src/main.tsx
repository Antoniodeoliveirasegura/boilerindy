import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AppErrorBoundary from './components/AppErrorBoundary'
import { attachErrorSink, captureEarlyWindowErrors } from './lib/errorReporting'
import './index.css'
import App from './App'

// Error tracking (issue #50), loaded OFF the critical path: @sentry/react and the
// scrubber are not in the initial bundle, and init runs after first paint. Until
// then, window errors and boundary crashes are buffered by lib/errorReporting
// and flushed to Sentry the moment it is up, so a first-render crash is not lost.
// Only active when VITE_SENTRY_DSN is set (prod); local dev sends zero events.
// The listeners are installed before React renders so the very first frame is
// covered.
if (import.meta.env.VITE_SENTRY_DSN) {
  const detachEarlyCapture = captureEarlyWindowErrors()
  const bootSentry = async () => {
    try {
      const Sentry = await import('@sentry/react')
      const { scrubSentryEvent } = await import('../../src/sentryScrub.mjs')
      Sentry.init({
        dsn: import.meta.env.VITE_SENTRY_DSN,
        environment: import.meta.env.MODE,
        sendDefaultPii: false,
        tracesSampleRate: 0, // errors only - keeps the free tier roomy
        beforeSend: scrubSentryEvent,
      })
      // Sentry's own global handlers own window errors from here; drop ours
      // first so nothing is reported twice, then drain the early buffer.
      detachEarlyCapture()
      attachErrorSink((error, context) =>
        Sentry.captureException(error, context as Parameters<typeof Sentry.captureException>[1]),
      )
    } catch {
      // Sentry is best-effort; never let it break the app.
    }
  }
  if ('requestIdleCallback' in window) requestIdleCallback(bootSentry)
  else setTimeout(bootSentry, 1000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)

// The PWA service worker (issue #11) is registered by components/UpdateToast,
// which also watches for a new version and offers the refresh (issue #220).
// Production only, so dev assets are never cached; a failed registration is
// swallowed there and never breaks the app.
