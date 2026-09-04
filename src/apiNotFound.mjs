// Fallthrough handler for unknown /api/* paths. Express's built-in 404 is an
// HTML "Cannot GET /api/..." page; every real API error is JSON
// { error: { message, status } }, so the 404 matches that shape and clients and
// Sentry breadcrumbs see one consistent format (#157).
//
// server.mjs mounts it with app.use('/api', apiNotFound) after every API route
// and before the error handlers, so it only runs when no route matched.

export function apiNotFound(_req, res) {
  res.status(404).json({ error: { message: 'Not found.', status: 404 } })
}
