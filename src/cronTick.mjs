// Transient-failure handling for the internal cron routes (issue #242).
//
// Supabase's REST layer occasionally answers a 5xx: three 504s in five hours
// on 2026-09-14, each on the first query of a reminder tick. postgrest-js
// retries a GET on 503/520 and on a dropped connection by itself, but not a
// 502 or 504, and the tick that hits one does nothing until the next tick.
//
// runCronTick runs a tick, retries it once after a short pause when the
// failure looks transient, and reports the outcome so the route can log a
// surviving transient failure as a warning (one grouped Sentry issue over
// time) and anything else as an error (an event per tick, which is what a
// real bug deserves). Re-running a whole tick is safe: the reminder runner
// claims each delivery in push_deliveries before sending, and a source
// re-sync is an atomic replace.
//
// queryError turns a failed PostgREST result into an Error that keeps the
// HTTP status and the PostgREST or Postgres code. The runners throw that
// instead of the bare { message } object supabase-js hands back when an
// error body is not JSON, which is exactly what a gateway 504 looks like.

export const RETRY_DELAY_MS = 1500

// Gateway and overload statuses worth a second attempt. 500 is not here: a
// PostgREST 500 is usually a query the schema cannot serve, and that will not
// fix itself in two seconds.
const TRANSIENT_HTTP_STATUS = new Set([408, 429, 502, 503, 504, 520, 521, 522, 523, 524])

// PostgREST codes (no database connection, pool timeout) and Postgres codes
// (statement timeout, too many connections, connection exceptions,
// serialization failure, deadlock, server shutting down or starting up).
const TRANSIENT_CODES = new Set([
  'PGRST000',
  'PGRST001',
  'PGRST002',
  'PGRST003',
  '57014',
  '53300',
  '08000',
  '08001',
  '08003',
  '08006',
  '40001',
  '40P01',
  '57P01',
  '57P02',
  '57P03',
])

// Node and undici error codes for a connection that never completed.
const TRANSIENT_NODE_CODE_RE = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/

// Last resort for errors that carry neither status nor code: the bare
// { message: 'Gateway Timeout' } supabase-js builds from a non-JSON error
// body, or a fetch failure ("TypeError: fetch failed").
const TRANSIENT_MESSAGE_RE =
  /gateway time-?out|bad gateway|service unavailable|\btimed? ?out\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|too many connections|statement timeout|canceling statement/i

/** A failed Supabase query, with the HTTP status and error code kept for triage. */
export class SupabaseQueryError extends Error {
  constructor(what, error = {}, status = null) {
    const detail = error?.message ? String(error.message) : 'unknown error'
    const httpStatus = Number.isInteger(status) ? status : null
    super(httpStatus !== null && httpStatus >= 400 ? `${what}: ${detail} (HTTP ${httpStatus})` : `${what}: ${detail}`)
    this.name = 'SupabaseQueryError'
    this.status = httpStatus
    this.code = error?.code ? String(error.code) : null
    this.details = error?.details ?? null
    this.hint = error?.hint ?? null
  }
}

/**
 * The Error to throw for a failed PostgREST result ({ error, status }).
 * `what` names the query ("push_settings select") so the log line says which
 * one failed; the status tells the retry logic whether it is worth retrying.
 */
export function queryError(result, what) {
  return new SupabaseQueryError(what, result?.error, result?.status)
}

/**
 * Whether a failure is the kind that a second attempt a moment later can
 * fix: a gateway or overload status, a lost or timed-out connection, a
 * database that is busy or restarting. A malformed query, a missing table,
 * a permission problem or a programming error is not.
 */
export function isTransientFailure(err) {
  if (!err) return false
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
  if (err.name === 'UpstreamError') {
    if (err.kind === 'timeout' || err.kind === 'network') return true
    return err.kind === 'status' && TRANSIENT_HTTP_STATUS.has(Number(err.status))
  }
  if (TRANSIENT_HTTP_STATUS.has(Number(err.status))) return true
  const code = err.code ? String(err.code) : ''
  if (code && (TRANSIENT_CODES.has(code) || TRANSIENT_NODE_CODE_RE.test(code))) return true
  const causeCode = err.cause?.code ? String(err.cause.code) : ''
  if (causeCode && TRANSIENT_NODE_CODE_RE.test(causeCode)) return true
  return TRANSIENT_MESSAGE_RE.test(`${err.message || ''} ${err.cause?.message || ''}`)
}

/**
 * A short, stable label for a failure ("Supabase 504", "Supabase PGRST003",
 * "TransLoc timeout"): the part of the log line and the Sentry fingerprint
 * that groups the same kind of hiccup together across ticks.
 */
export function describeFailure(err) {
  if (!err) return 'unknown failure'
  if (err.name === 'UpstreamError') return `${err.upstream} ${err.kind === 'status' ? err.status : err.kind}`
  if (err.name === 'SupabaseQueryError') {
    if (err.status !== null && err.status >= 400) return `Supabase ${err.status}`
    if (err.code) return `Supabase ${err.code}`
    return err.status === 0 ? 'Supabase unreachable' : 'Supabase error'
  }
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
  if (err.code) return `${err.name || 'Error'} ${err.code}`
  return err.name || 'Error'
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run one cron tick, retrying it once after `retryDelayMs` when the first
 * failure is transient. Resolves with `{ ok: true, summary, retried }`, or
 * `{ ok: false, transient, error, retried }` when the tick failed; it never
 * rejects for a tick error. `log.log` gets one line per retry.
 */
export async function runCronTick(name, tick, { log = console, retryDelayMs = RETRY_DELAY_MS, sleep = wait } = {}) {
  let first
  try {
    return { ok: true, summary: await tick(), retried: false }
  } catch (err) {
    if (!isTransientFailure(err)) return { ok: false, transient: false, error: err, retried: false }
    first = err
  }
  log.log(`[cron] ${name}: ${describeFailure(first)} (${first?.message || first}); retrying once in ${retryDelayMs} ms`)
  await sleep(retryDelayMs)
  try {
    return { ok: true, summary: await tick(), retried: true }
  } catch (err) {
    return { ok: false, transient: isTransientFailure(err), error: err, retried: true }
  }
}
