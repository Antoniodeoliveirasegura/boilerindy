// Telling a database outage from a bug (2026-11-03).
//
// On 2026-11-03 the Supabase project ran out of memory and stopped answering
// for three and a half hours: Postgres went silent at 10:51 UTC and a restart
// brought it back at 14:33. Every request that needed the database failed, and
// each failure looked like a different bug:
//
// - routes answered 500 with their feature's fallback message, and the final
//   error handler logged `[unhandled]` followed by the whole Cloudflare error
//   page Supabase's gateway sent instead of JSON (`522: Connection timed out`,
//   then 525 and 521 during the restart), about a hundred log lines a request,
//   and Sentry's Express handler filed an event for each one;
// - while the restart came up, PostgREST answered PGRST002 ("Could not query
//   the database for the schema cache. Retrying."), which isSchemaMissingError
//   read as a missing table: features answered `*_schema_missing`, which the
//   app shows as "coming soon", and the log told the operator to run SQL files.
//
// isDatabaseUnavailableError(err) recognises the failures that mean the
// database cannot be reached at all. respondDatabaseUnavailable answers them
// with 503 `database_unavailable` and a Retry-After, and the outage log keeps
// the Render log to one line a minute while it lasts and hands a line to the
// reporter (Sentry, set by server.mjs) at most every 15 minutes, under one
// fingerprint: an outage is one Sentry issue, and its events show how long it
// lasted. See docs/database-outage.md.

import { describeFailure } from './cronTick.mjs'

// PostgREST: no database connection (PGRST000, PGRST001), the schema cache
// could not be loaded (PGRST002, what it answers while Postgres starts), no pool
// connection in time (PGRST003). Postgres: too many connections, a connection
// exception, the server shutting down or starting up.
const UNAVAILABLE_CODES = new Set([
  'PGRST000',
  'PGRST001',
  'PGRST002',
  'PGRST003',
  '53300',
  '08000',
  '08001',
  '08003',
  '08006',
  '57P01',
  '57P02',
  '57P03',
])

// What the gateways in front of Postgres answer while it is down: Supabase's
// own 502, 503 and 504, and Cloudflare's origin errors (521 web server down,
// 522 connection timed out and 525 TLS handshake failed were all seen on
// 2026-11-03).
const UNAVAILABLE_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])

// Node and undici codes for a connection that never completed.
const NETWORK_CODE_RE = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/

// supabase-js hands a gateway's non-JSON body back as { message: body }: the
// whole Cloudflare error page, whose title names the host and the status
// ("tsnazxzeaezfsoukwgti.supabase.co | 522: Connection timed out"), or the one
// line Supabase's own gateway writes.
const GATEWAY_PAGE_TITLE_RE = /<title>[^<]*\bsupabase\.co\b[^<]*?\|\s*(5\d\d):\s*([^<]*)<\/title>/i
const GATEWAY_LINE_RE = /^\s*(upstream request timeout|upstream connect error|no healthy upstream)/i

// How postgrest-js reports a fetch that failed before any answer.
const FETCH_FAILED_RE = /\bfetch failed\b|\bFetchError\b|socket hang up/i

/**
 * True when the error says the database cannot be reached at all: a PostgREST
 * or Postgres connection code, PostgREST still loading its schema cache, a
 * gateway error page or line in place of PostgREST's JSON, or a Supabase fetch
 * that never completed. A failed query (a bug, a missing table, a constraint) is
 * not, and neither is another service's outage (an UpstreamError, such as
 * TransLoc or a calendar feed host).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isDatabaseUnavailableError(err) {
  if (!err || typeof err !== 'object') return false
  if (err.name === 'UpstreamError') return false
  const code = err.code ? String(err.code) : ''
  if (UNAVAILABLE_CODES.has(code)) return true
  if (err.name === 'SupabaseQueryError' && (err.status === 0 || UNAVAILABLE_STATUS.has(err.status))) return true
  const message = String(err.message || '')
  if (GATEWAY_PAGE_TITLE_RE.test(message) || GATEWAY_LINE_RE.test(message)) return true
  // postgrest-js always fills `details` and `hint` on the errors it builds, so
  // this is a Supabase call, not some other fetch.
  const fromPostgrest = 'details' in err && 'hint' in err
  return fromPostgrest && (FETCH_FAILED_RE.test(message) || NETWORK_CODE_RE.test(code))
}

/**
 * A short, stable label for an outage failure ("Supabase 522 Connection timed
 * out", "Supabase PGRST002"), for the log line and the Sentry event, never the
 * error page itself.
 * @param {unknown} err
 * @returns {string}
 */
export function describeDatabaseFailure(err) {
  const message = String(err?.message || '')
  const page = GATEWAY_PAGE_TITLE_RE.exec(message)
  if (page) return `Supabase ${page[1]} ${page[2].trim()}`.trim()
  const line = GATEWAY_LINE_RE.exec(message)
  if (line) return `Supabase gateway ${line[1].toLowerCase()}`
  const code = err?.code ? String(err.code) : ''
  if (UNAVAILABLE_CODES.has(code)) return `Supabase ${code}`
  if (err?.name === 'SupabaseQueryError') return describeFailure(err)
  return code ? `Supabase unreachable (${code})` : 'Supabase unreachable'
}

export const LOG_EVERY_MS = 60 * 1000
export const REPORT_EVERY_MS = 15 * 60 * 1000

/**
 * The outage log: one Render log line a minute at most, each counting the
 * requests answered 503 since the line before, and a call to `report` with the
 * same summary at most every `reportEveryMs`. A reporter that throws is ignored.
 * @param {{ log?: { warn: Function }, report?: ((summary: { what: string, where: string, failedRequests: number }) => void) | null,
 *   now?: () => number, logEveryMs?: number, reportEveryMs?: number }} [options]
 * @returns {(err: unknown, where: string) => void}
 */
export function createDatabaseOutageLog({ log = console, report = null, now = Date.now, logEveryMs = LOG_EVERY_MS, reportEveryMs = REPORT_EVERY_MS } = {}) {
  let lastLogAt = -Infinity
  let lastReportAt = -Infinity
  let failedSinceLog = 0
  return function noteDatabaseOutage(err, where) {
    failedSinceLog += 1
    const at = now()
    if (at - lastLogAt < logEveryMs) return
    const what = describeDatabaseFailure(err)
    const failedRequests = failedSinceLog
    log.warn(`[database] unavailable (${what}) at ${where}: ${failedRequests} request(s) answered 503 database_unavailable since the previous line`)
    lastLogAt = at
    failedSinceLog = 0
    if (report && at - lastReportAt >= reportEveryMs) {
      lastReportAt = at
      try {
        report({ what, where, failedRequests })
      } catch {
        // A broken reporter must not turn a 503 into a 500.
      }
    }
  }
}

let noteOutage = createDatabaseOutageLog()

/**
 * Replace the process-wide outage log; server.mjs passes Sentry's reporter at
 * boot. Returns the new log so a test can call it directly.
 * @param {Parameters<typeof createDatabaseOutageLog>[0]} options
 */
export function configureDatabaseOutageLog(options) {
  noteOutage = createDatabaseOutageLog(options)
  return noteOutage
}

export const DATABASE_UNAVAILABLE = Object.freeze({
  code: 'database_unavailable',
  message: 'BoilerIndy cannot reach its database right now. Please try again in a few minutes.',
  retryAfterSeconds: 30,
})

/**
 * Answer 503 database_unavailable with a Retry-After, and note the outage.
 * @param {{ status: (code: number) => any, set?: Function }} res Express response
 * @param {unknown} err
 * @param {{ where?: string, note?: (err: unknown, where: string) => void }} [options]
 *   where names the route or feature in the log line; note replaces the
 *   process-wide outage log (tests)
 */
export function respondDatabaseUnavailable(res, err, { where = 'a request', note = noteOutage } = {}) {
  note(err, where)
  if (typeof res.set === 'function') res.set('Retry-After', String(DATABASE_UNAVAILABLE.retryAfterSeconds))
  return res.status(503).json({
    error: { message: DATABASE_UNAVAILABLE.message, code: DATABASE_UNAVAILABLE.code, status: 503 },
  })
}
