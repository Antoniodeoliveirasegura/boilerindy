// GET /api/health/db, the database probe for uptime monitors (2026-11-03).
//
// GET /api/health answers without touching Supabase, by design: it is the
// keep-warm ping. So it stayed 200 through the three and a half hours the
// database was down on 2026-11-03, and nothing noticed until a student opened
// the app. This probe reads one row id and says whether that worked: 200
// { ok: true } when it did, 503 database_unavailable when the database cannot be
// reached (or the read takes longer than timeoutMs), 503 database_error when it
// answered with some other failure.
//
// One probe serves every caller for ttlMs, and callers that arrive while one is
// in flight share it, so a monitor (or many) costs the database at most one
// tiny read every 10 seconds. See docs/database-outage.md.

import { DATABASE_UNAVAILABLE, describeDatabaseFailure, isDatabaseUnavailableError } from './databaseUnavailable.mjs'

export const PROBE_TTL_MS = 10 * 1000
export const PROBE_TIMEOUT_MS = 5 * 1000
// Every deployment has this table from step 1, and the service-role client
// reads it past RLS; the probe never returns the row.
export const PROBE_TABLE = 'users'

/**
 * @param {{ supabase: { from: Function }, ttlMs?: number, timeoutMs?: number, now?: () => number }} deps
 * @returns {() => Promise<{ ok: boolean, status: number, body: object, what?: string }>}
 */
export function createDatabaseHealth({ supabase, ttlMs = PROBE_TTL_MS, timeoutMs = PROBE_TIMEOUT_MS, now = Date.now }) {
  let cached = null
  let inFlight = null

  async function probe() {
    const signal = AbortSignal.timeout(timeoutMs)
    let error = null
    try {
      ;({ error } = await supabase.from(PROBE_TABLE).select('id').limit(1).abortSignal(signal))
    } catch (err) {
      error = err
    }
    if (!error && !signal.aborted) return { ok: true, status: 200, body: { ok: true } }
    if (signal.aborted || isDatabaseUnavailableError(error)) {
      return {
        ok: false,
        status: 503,
        what: signal.aborted ? `no answer in ${timeoutMs} ms` : describeDatabaseFailure(error),
        body: { ok: false, error: { message: DATABASE_UNAVAILABLE.message, code: DATABASE_UNAVAILABLE.code, status: 503 } },
      }
    }
    return {
      ok: false,
      status: 503,
      what: `database error ${error?.code || ''}`.trim(),
      body: { ok: false, error: { message: 'The database answered with an error.', code: 'database_error', status: 503 } },
    }
  }

  return function checkDatabaseHealth() {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.result)
    if (!inFlight) {
      inFlight = probe().then((result) => {
        cached = { at: now(), result }
        inFlight = null
        return result
      })
    }
    return inFlight
  }
}
