import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { scrubSentryEvent } from '../../sentryScrub.mjs'
import CrashFallback from './components/CrashFallback.jsx'
import './index.css'
import App from './App.jsx'

// Error tracking (issue #50). Without VITE_SENTRY_DSN (local dev) Sentry is
// fully disabled — zero events leave the browser. The ErrorBoundary below is
// inert without a client, so the fallback UI still works either way.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    sendDefaultPii: false,
    tracesSampleRate: 0, // errors only — keeps the free tier roomy
    beforeSend: scrubSentryEvent,
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashFallback />}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
