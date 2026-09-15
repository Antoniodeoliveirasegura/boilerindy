// Error reporting seam (issue #50).
//
// @sentry/react is loaded off the critical path (see main.tsx), so for the
// first second or so of a page load nothing is listening. That window holds the
// failures most worth seeing: a crash during the first render, or a chunk that
// throws while evaluating. Callers report here instead of calling a
// captureException that may still be a no-op. Before a sink is attached the
// reports are buffered (bounded); attaching the sink drains them in order.
// Without a DSN nothing ever attaches, so at most MAX_PENDING objects sit in
// memory and zero events leave the browser, same as before.

export type ErrorContext = Record<string, unknown>
export type ErrorSink = (error: unknown, context?: ErrorContext) => void

export const MAX_PENDING = 20

type Pending = { error: unknown; context?: ErrorContext }

let pending: Pending[] = []
let sink: ErrorSink | null = null
let dropped = 0

/** Report an error now if Sentry is up, otherwise hold it until it is. */
export function reportError(error: unknown, context?: ErrorContext): void {
  if (sink) {
    try {
      sink(error, context)
    } catch {
      // Reporting must never take the app down with it.
    }
    return
  }
  if (pending.length >= MAX_PENDING) {
    dropped += 1
    return
  }
  pending.push({ error, context })
}

/** Install the real reporter and flush everything that arrived before it. */
export function attachErrorSink(next: ErrorSink): void {
  sink = next
  const queued = pending
  pending = []
  for (const item of queued) {
    try {
      next(item.error, item.context)
    } catch {
      // ignore - see reportError
    }
  }
  if (dropped > 0) {
    const n = dropped
    dropped = 0
    try {
      next(new Error(`errorReporting: ${n} early error(s) dropped before Sentry initialised`), {
        contexts: { early: { dropped: n } },
      })
    } catch {
      // ignore
    }
  }
}

/**
 * Catch window-level errors during the pre-init window. Sentry installs its
 * own onerror / onunhandledrejection handlers at init, so the caller detaches
 * these the moment the sink is attached to avoid reporting anything twice.
 * Returns the detach function.
 */
export function captureEarlyWindowErrors(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    reportError(event.error ?? new Error(String(event.message || 'Unknown error')), {
      contexts: { early: { mechanism: 'onerror' } },
    })
  }
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason
    reportError(reason ?? new Error('Unhandled promise rejection'), {
      contexts: { early: { mechanism: 'onunhandledrejection' } },
    })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

// Breadcrumbs (issue #245) go through the same seam. Sentry.addBreadcrumb
// returns without recording anything until init has run, so a breadcrumb left
// during the first render (a direct landing on a broken link, say) was lost.
// They are held here, stamped with the time they happened, and replayed when
// the sink attaches. Only the newest MAX_PENDING are kept, like Sentry's own
// breadcrumb buffer; a dropped breadcrumb is not worth an error event.

export type Breadcrumb = {
  category?: string
  message?: string
  data?: Record<string, unknown>
  timestamp?: number
}
export type BreadcrumbSink = (breadcrumb: Breadcrumb) => void

let pendingBreadcrumbs: Breadcrumb[] = []
let breadcrumbSink: BreadcrumbSink | null = null

/** Leave a breadcrumb now if Sentry is up, otherwise hold it until it is. */
export function reportBreadcrumb(breadcrumb: Breadcrumb): void {
  // Sentry keeps a timestamp it is given, so a replayed breadcrumb still
  // shows when it happened rather than when init ran.
  const stamped = { timestamp: Date.now() / 1000, ...breadcrumb }
  if (breadcrumbSink) {
    try {
      breadcrumbSink(stamped)
    } catch {
      // ignore - see reportError
    }
    return
  }
  if (pendingBreadcrumbs.length >= MAX_PENDING) pendingBreadcrumbs.shift()
  pendingBreadcrumbs.push(stamped)
}

/** Install the real breadcrumb recorder and replay what arrived before it. */
export function attachBreadcrumbSink(next: BreadcrumbSink): void {
  breadcrumbSink = next
  const queued = pendingBreadcrumbs
  pendingBreadcrumbs = []
  for (const item of queued) {
    try {
      next(item)
    } catch {
      // ignore - see reportError
    }
  }
}

/** How many reports are waiting for a sink (tests and debugging). */
export function pendingCount(): number {
  return pending.length
}

export function __resetErrorReportingForTests(): void {
  pending = []
  sink = null
  dropped = 0
  pendingBreadcrumbs = []
  breadcrumbSink = null
}
