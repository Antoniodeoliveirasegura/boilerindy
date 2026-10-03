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

/** The 4xx status of a client error (a body parser's, or any http-errors one), or null. */
export function clientErrorStatus(err) {
  const status = Number(err?.status ?? err?.statusCode)
  if (err?.expose === true && Number.isInteger(status) && status >= 400 && status < 500) return status
  return null
}

export function createFinalErrorHandler({ log = console } = {}) {
  return function finalErrorHandler(err, _req, res, _next) {
    const clientStatus = clientErrorStatus(err)
    if (res.sentry || clientStatus !== null) log.warn('[unhandled]', err?.message || err)
    else log.error('[unhandled]', err?.message || err)
    if (res.headersSent) return
    // Any other error carrying status 400 has always answered 400; kept as it was.
    const isBadRequest = err?.status === 400 || err?.statusCode === 400 || err?.type === 'entity.parse.failed'
    const status = clientStatus ?? (isBadRequest ? 400 : 500)
    res.status(status).json({
      error: { message: status < 500 ? 'Invalid request.' : 'Internal server error.', status },
    })
  }
}
