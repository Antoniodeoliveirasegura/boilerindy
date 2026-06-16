import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AppErrorBoundary from './components/AppErrorBoundary'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)

// PWA service worker (issue #11). Registered in production only so dev assets are
// never cached. Best-effort — a failed registration must not break the app.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

// Error tracking (issue #50), loaded OFF the critical path: @sentry/react and the
// scrubber are no longer in the initial bundle, and init runs after first paint.
// Only active when VITE_SENTRY_DSN is set (prod); local dev sends zero events.
if (import.meta.env.VITE_SENTRY_DSN) {
  const bootSentry = async () => {
    try {
      const Sentry = await import('@sentry/react')
      const { scrubSentryEvent } = await import('../../src/sentryScrub.mjs')
      Sentry.init({
        dsn: import.meta.env.VITE_SENTRY_DSN,
        environment: import.meta.env.MODE,
        sendDefaultPii: false,
        tracesSampleRate: 0, // errors only — keeps the free tier roomy
        beforeSend: scrubSentryEvent,
      })
    } catch {
      // Sentry is best-effort; never let it break the app.
    }
  }
  if ('requestIdleCallback' in window) requestIdleCallback(bootSentry)
  else setTimeout(bootSentry, 1000)
}
