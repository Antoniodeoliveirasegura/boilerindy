import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import AppErrorBoundary from './components/AppErrorBoundary'
import { BUILD_ID, QUERY_CACHE_MAX_AGE_MS, createQueryClient, createQueryPersister, dehydrateOptions } from './lib/queryClient'
import { attachBreadcrumbSink, attachErrorSink, captureEarlyWindowErrors } from './lib/errorReporting'
import './index.css'
import App from './App'

// Error tracking (issue #50), loaded OFF the critical path: @sentry/react and the
// scrubber are not in the initial bundle, and init runs after first paint. Until
// then, window errors, boundary crashes and breadcrumbs are buffered by
// lib/errorReporting and flushed to Sentry the moment it is up, so a
// first-render crash (or a direct landing on a broken link) is not lost.
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
      // Replay breadcrumbs left before init (the not-found page on a direct
      // landing, #245) first, so an early error drained below carries them.
      attachBreadcrumbSink((breadcrumb) => Sentry.addBreadcrumb(breadcrumb))
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

// The client data cache (issue #251): one QueryClient for the whole app,
// with the public reads persisted to localStorage so the dashboard paints
// from the last visit before the network answers. Above AuthProvider (in App)
// so sign-out can clear it. Without usable storage the plain provider serves
// an in-memory cache and nothing else changes.
const queryClient = createQueryClient()
const persister = createQueryPersister()
const app = (
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {persister ? (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, maxAge: QUERY_CACHE_MAX_AGE_MS, buster: BUILD_ID, dehydrateOptions }}
      >
        {app}
      </PersistQueryClientProvider>
    ) : (
      <QueryClientProvider client={queryClient}>{app}</QueryClientProvider>
    )}
  </StrictMode>,
)

// The PWA service worker (issue #11) is registered by components/UpdateToast,
// which also watches for a new version and offers the refresh (issue #220).
// Production only, so dev assets are never cached; a failed registration is
// swallowed there and never breaks the app.
