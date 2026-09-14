// Async route safety for Express 4 (issue #197).
//
// Express 4 never forwards a rejected promise to the error middleware: an
// `async (req, res) => {}` handler that throws after an await leaves the HTTP
// request open until the client gives up, and without a Sentry DSN (local,
// CI) Node's default unhandled-rejection policy terminates the process. The
// handlers in server.mjs were safe only because supabase-js returns { error }
// instead of throwing; any helper that rejects broke that assumption.
//
// wrapAsyncRoutes walks the app's router stack after every route is
// registered and wraps each handler and route-level middleware (requireAuth,
// requireAdvertiserAuth, the rate limiters, ...) so a rejection becomes
// next(err) and lands in the catch-all 500 handler. Error middleware (four
// arguments) is left alone. Express 5 does this natively; until that
// migration this is the same behaviour in 40 lines.

const WRAPPED = Symbol('asyncWrapped')

/** next(err) for a rejected promise or a synchronous throw; a no-op for error middleware. */
export function wrapAsync(fn) {
  if (typeof fn !== 'function' || fn.length >= 4 || fn[WRAPPED]) return fn
  const wrapped = function asyncSafe(req, res, next) {
    let out
    try {
      out = fn(req, res, next)
    } catch (err) {
      return next(err)
    }
    // Hand the rejection to next(); the promise the caller sees never rejects.
    if (out && typeof out.then === 'function') return out.then(undefined, next)
    return out
  }
  wrapped[WRAPPED] = true
  wrapped.original = fn
  return wrapped
}

/**
 * Wrap every handler in the app's registered routes (and any app-level
 * middleware that is an async function). Idempotent. Returns the count of
 * handlers wrapped, for the boot log.
 */
export function wrapAsyncRoutes(app) {
  const stack = app?._router?.stack
  if (!Array.isArray(stack)) return 0
  let count = 0
  for (const layer of stack) {
    if (layer.route && Array.isArray(layer.route.stack)) {
      for (const routeLayer of layer.route.stack) {
        const wrapped = wrapAsync(routeLayer.handle)
        if (wrapped !== routeLayer.handle) {
          routeLayer.handle = wrapped
          count += 1
        }
      }
    } else if (typeof layer.handle === 'function' && layer.handle.constructor?.name === 'AsyncFunction') {
      const wrapped = wrapAsync(layer.handle)
      if (wrapped !== layer.handle) {
        layer.handle = wrapped
        count += 1
      }
    }
  }
  return count
}
