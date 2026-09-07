import { useSyncExternalStore } from 'react'

// Tracks the one warm-up ping the app sends at boot, so the UI can say "waking
// up the server" instead of looking hung (issue #164).
//
// The API sleeps on Render's free tier after ~15 min idle and takes 20 to 50 s
// to boot on the next request. Every call site uses relative /api/... URLs and
// AuthContext hits /api/session on the first render, so a cold start shows up
// as a blank-looking wait. Sending GET /api/health as early as possible wakes
// the instance no later than that first call, and the state kept here lets
// ServerWakeNotice explain the wait once it has gone on long enough to notice.
//
// A plain external store, not context or component state: it must run once per
// page load no matter how many components ask (StrictMode mounts twice), keep
// its answer across remounts, and be testable without React. Only the hook at
// the bottom touches React.

export type ServerWarmupStatus = 'idle' | 'pending' | 'slow' | 'ready' | 'failed'

export type ServerWarmupState = {
  status: ServerWarmupStatus
  /** Date.now() when the ping was sent; null until startServerWarmup() runs. */
  startedAt: number | null
  /**
   * Milliseconds from startedAt to the latest status change, so once the status
   * is 'ready' this is how long the cold start took. Frozen per transition
   * rather than recomputed on read, because useSyncExternalStore needs a
   * snapshot that only changes when something happened.
   */
  elapsedMs: number
}

export type ServerWarmupOptions = {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** How long the ping may take before the status turns 'slow'. */
  slowAfterMs?: number
  /** Give up (abort the request, status 'failed') after this long. */
  timeoutMs?: number
  /** Endpoint to ping. Must not need a session: the request carries no cookie. */
  path?: string
}

export const DEFAULT_SLOW_AFTER_MS = 2500
export const DEFAULT_TIMEOUT_MS = 90_000
export const DEFAULT_WARMUP_PATH = '/api/health'

const IDLE: ServerWarmupState = { status: 'idle', startedAt: null, elapsedMs: 0 }

type Run = {
  controller: AbortController
  slowTimer: ReturnType<typeof setTimeout> | null
  timeoutTimer: ReturnType<typeof setTimeout> | null
}

let state: ServerWarmupState = IDLE
let inFlight: Promise<void> | null = null
let currentRun: Run | null = null
const listeners = new Set<() => void>()

function publish(status: ServerWarmupStatus, startedAt: number | null): void {
  state = {
    status,
    startedAt,
    elapsedMs: startedAt == null ? 0 : Math.max(0, Date.now() - startedAt),
  }
  // Copy first: a listener may unsubscribe while we iterate.
  for (const listener of [...listeners]) listener()
}

function clearTimers(run: Run): void {
  if (run.slowTimer != null) clearTimeout(run.slowTimer)
  if (run.timeoutTimer != null) clearTimeout(run.timeoutTimer)
  run.slowTimer = null
  run.timeoutTimer = null
}

/**
 * Send the warm-up ping. Idempotent: every call after the first returns the
 * same promise and no second request is made, settled or not. The promise
 * resolves when the status reaches 'ready' or 'failed' and never rejects; read
 * the outcome from the store.
 *
 * 'ready' means any HTTP response at all, including an error status: the point
 * is whether the instance is awake, not whether the endpoint is happy.
 */
export function startServerWarmup(options: ServerWarmupOptions = {}): Promise<void> {
  if (inFlight) return inFlight

  const startedAt = Date.now()
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  if (!fetchImpl) {
    // No fetch at all (a bare test runtime): nothing to wait for, nothing to show.
    publish('failed', startedAt)
    inFlight = Promise.resolve()
    return inFlight
  }

  const run: Run = { controller: new AbortController(), slowTimer: null, timeoutTimer: null }
  currentRun = run

  const settle = (status: 'ready' | 'failed'): void => {
    // Ignore a late answer after the timeout fired or after a test reset.
    if (currentRun !== run) return
    currentRun = null
    clearTimers(run)
    publish(status, startedAt)
  }

  run.slowTimer = setTimeout(() => {
    run.slowTimer = null
    if (currentRun === run) publish('slow', startedAt)
  }, options.slowAfterMs ?? DEFAULT_SLOW_AFTER_MS)

  run.timeoutTimer = setTimeout(() => {
    run.timeoutTimer = null
    settle('failed')
    run.controller.abort()
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  inFlight = fetchImpl(options.path ?? DEFAULT_WARMUP_PATH, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    signal: run.controller.signal,
  }).then(
    () => settle('ready'),
    () => settle('failed'),
  )
  publish('pending', startedAt)
  return inFlight
}

export function getServerWarmupState(): ServerWarmupState {
  return state
}

/** Subscribe to status changes. Returns the matching unsubscribe function. */
export function subscribeServerWarmup(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current warm-up state, re-rendering the caller on every change. */
export function useServerWarmup(): ServerWarmupState {
  return useSyncExternalStore(subscribeServerWarmup, getServerWarmupState, getServerWarmupState)
}

/** Back to 'idle' with timers cleared and any in-flight request abandoned. */
export function resetServerWarmupForTests(): void {
  if (currentRun) {
    const run = currentRun
    currentRun = null
    clearTimers(run)
    run.controller.abort()
  }
  inFlight = null
  state = IDLE
  for (const listener of [...listeners]) listener()
}
