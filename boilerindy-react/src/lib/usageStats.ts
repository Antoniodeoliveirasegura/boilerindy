// First-party product analytics client (issue #51). Events queue locally and
// flush in batches to our own backend - no third-party trackers, ever.
// Disabled until configureAnalytics says otherwise, so nothing is recorded for
// signed-out visitors or users who opted out (their queue is dropped too).
// Fails soft everywhere: analytics must never break or slow the app.
// Migrated to TypeScript (issue #20).

type AnalyticsEvent = { event_name: string; page: string; props: Record<string, unknown> }

const ENDPOINT = '/api/usage/events'
const FLUSH_INTERVAL_MS = 10_000
const BATCH_MAX = 20

let isEnabled = false
let queue: AnalyticsEvent[] = []
let flushTimer: ReturnType<typeof window.setInterval> | null = null

function startTimer(): void {
  if (flushTimer == null) {
    flushTimer = window.setInterval(flush, FLUSH_INTERVAL_MS)
  }
}

function stopTimer(): void {
  if (flushTimer != null) {
    window.clearInterval(flushTimer)
    flushTimer = null
  }
}

/** Enable/disable tracking. Disabling drops anything still queued. */
export function configureAnalytics({ enabled }: { enabled?: boolean }): void {
  isEnabled = Boolean(enabled)
  if (!isEnabled) {
    queue = []
    stopTimer()
    return
  }
  startTimer()
}

/** Queue an allowlisted event. No-op when tracking is disabled. */
export function track(eventName: string, props: Record<string, unknown> = {}): void {
  if (!isEnabled) return
  queue.push({ event_name: eventName, page: window.location.pathname, props })
  if (queue.length >= BATCH_MAX) flush()
}

/** Send the queued batch now. Exposed for tests and route-change hooks. */
export function flush(): void {
  if (!isEnabled || queue.length === 0) return
  const events = queue.splice(0, BATCH_MAX)
  fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    keepalive: true,
  })
    .then((res) => {
      // Session is gone (signed out / expired in this tab): stop tracking so we
      // don't keep POSTing to this requireAuth endpoint and logging 401s.
      if (res && res.status === 401) configureAnalytics({ enabled: false })
    })
    .catch(() => {
      /* analytics is best-effort; never surface errors */
    })
}

// On tab close/navigation the interval never fires again - hand the remaining
// batch to sendBeacon, which the browser delivers after the page is gone.
function flushWithBeacon(): void {
  if (!isEnabled || queue.length === 0) return
  const events = queue.splice(0, BATCH_MAX)
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, JSON.stringify({ events }))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushWithBeacon)
}
