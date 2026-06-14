// First-party product analytics client (issue #51). Events queue locally and
// flush in batches to our own backend — no third-party trackers, ever.
// Disabled until configureAnalytics says otherwise, so nothing is recorded for
// signed-out visitors or users who opted out (their queue is dropped too).
// Fails soft everywhere: analytics must never break or slow the app.

const ENDPOINT = '/api/usage/events'
const FLUSH_INTERVAL_MS = 10_000
const BATCH_MAX = 20

let isEnabled = false
let queue = []
let flushTimer = null

function startTimer() {
  if (flushTimer == null) {
    flushTimer = window.setInterval(flush, FLUSH_INTERVAL_MS)
  }
}

function stopTimer() {
  if (flushTimer != null) {
    window.clearInterval(flushTimer)
    flushTimer = null
  }
}

/** Enable/disable tracking. Disabling drops anything still queued. */
export function configureAnalytics({ enabled }) {
  isEnabled = Boolean(enabled)
  if (!isEnabled) {
    queue = []
    stopTimer()
    return
  }
  startTimer()
}

/** Queue an allowlisted event. No-op when tracking is disabled. */
export function track(eventName, props = {}) {
  if (!isEnabled) return
  queue.push({ event_name: eventName, page: window.location.pathname, props })
  if (queue.length >= BATCH_MAX) flush()
}

/** Send the queued batch now. Exposed for tests and route-change hooks. */
export function flush() {
  if (!isEnabled || queue.length === 0) return
  const events = queue.splice(0, BATCH_MAX)
  fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => {
    /* analytics is best-effort; never surface errors */
  })
}

// On tab close/navigation the interval never fires again — hand the remaining
// batch to sendBeacon, which the browser delivers after the page is gone.
// Beacons post as text/plain; the server JSON-parses that explicitly.
function flushWithBeacon() {
  if (!isEnabled || queue.length === 0) return
  const events = queue.splice(0, BATCH_MAX)
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, JSON.stringify({ events }))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushWithBeacon)
}
