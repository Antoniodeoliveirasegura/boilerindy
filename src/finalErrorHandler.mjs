// The last error middleware server.mjs registers: anything that escapes a
// route handler, a malformed or oversized request body included, gets the
// standard { error: { message, status } } shape and never a stack trace,
// regardless of NODE_ENV (issue #131).
//
// Logging. captureConsoleIntegration forwards console.error to Sentry, and
// Sentry 11 groups those captures by the stack of the call, so every line from
// here lands in one issue titled "consoleHandler" (Sentry BOILERINDY-API-7).
// Two kinds of error do not belong there:
//
// - a 5xx that Sentry.setupExpressErrorHandler, registered just before this,
//   already captured: it leaves the event id on res.sentry, and a second event
//   would only repeat it;
// - a client error from Express's body parsers (malformed JSON, a body over the
//   100 kB limit). http-errors marks those `expose` with a 4xx status: the
//   client gets that status, and nothing on the server broke.
//
// Both are logged with console.warn, which keeps the line in the Render log.
// Anything else stays a console.error and so still reaches Sentry, notably an
// escaped error carrying an upstream's 4xx `status` (an UpstreamError, a
// SupabaseQueryError): the Express handler reads that field as the response
// status and skips anything under 500.
//
// A database outage is neither, and never gets this far (2026-11-03): the
// session store's read fails on every signed-in request, and each one used to
// log `[unhandled]` with the whole Cloudflare error page Supabase's gateway sent,
// and file a Sentry event. createDatabaseOutageHandler, registered before
// Sentry's handler, answers those with 503 database_unavailable, and
// src/databaseUnavailable.mjs keeps the log to one line a minute and the Sentry
// reports to one issue. Sentry 11's Express handler has no filter of its own
// (it ignores shouldHandleError), so answering first is how it skips them.

import { describeDatabaseFailure, isDatabaseUnavailableError, respondDatabaseUnavailable } from './databaseUnavailable.mjs'

// "GET /api/me" from "GET /api/me/calendar": enough to tell the reads apart in
// the outage log, and short of an id or a calendar feed's token in the path.
function requestLabel(req) {
  const prefix = String(req?.path || '').split('/').slice(0, 3).join('/')
  return [req?.method, prefix].filter(Boolean).join(' ') || 'a request'
}

/**
 * The error middleware for a database outage: 503 database_unavailable for an
 * error isDatabaseUnavailableError recognises, next(err) for anything else (and
 * for an outage after the headers went out, which only the later handlers can
 * deal with). Register it before Sentry's Express handler.
 * @param {{ noteOutage?: (err: unknown, where: string) => void }} [options]
 *   noteOutage replaces the process-wide outage log (tests)
 */
export function createDatabaseOutageHandler({ noteOutage } = {}) {
  return function databaseOutageHandler(err, req, res, next) {
    if (!isDatabaseUnavailableError(err) || res.headersSent) return next(err)
    return respondDatabaseUnavailable(res, err, { where: requestLabel(req), ...(noteOutage ? { note: noteOutage } : {}) })
  }
}

/** The 4xx status of a client error (a body parser's, or any http-errors one), or null. */
export function clientErrorStatus(err) {
  const status = Number(err?.status ?? err?.statusCode)
  if (err?.expose === true && Number.isInteger(status) && status >= 400 && status < 500) return status
  return null
}

export function createFinalErrorHandler({ log = console } = {}) {
  return function finalErrorHandler(err, _req, res, _next) {
    const clientStatus = clientErrorStatus(err)
    // An outage that reached here (its headers had gone out) logs its label, not a gateway's error page.
    const text = isDatabaseUnavailableError(err) ? describeDatabaseFailure(err) : err?.message || err
    if (res.sentry || clientStatus !== null) log.warn('[unhandled]', text)
    else log.error('[unhandled]', text)
    if (res.headersSent) return
    // Any other error carrying status 400 has always answered 400; kept as it was.
    const isBadRequest = err?.status === 400 || err?.statusCode === 400 || err?.type === 'entity.parse.failed'
    const status = clientStatus ?? (isBadRequest ? 400 : 500)
    res.status(status).json({
      error: { message: status < 500 ? 'Invalid request.' : 'Internal server error.', status },
    })
  }
}
