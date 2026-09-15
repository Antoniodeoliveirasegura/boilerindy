// Shared request guards for Express routes. Ids reach PostgREST as UUID
// columns, so a malformed value fails there with 22P02 and surfaces as a 500
// through the per-feature DB error responders. Checking the shape up front
// turns that into a client error in the standard { error: { message, status } }
// JSON shape instead (#203; #196 reuses these for :id route params).

// Canonical 8-4-4-4-12 hex form, either case: the same shape the other modules
// check (purdueLinkHandoff, marketplacePhotos, sessionSyncKey) and what users.id
// holds (uuid_generate_v4 / crypto.randomUUID).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True when value is a string in canonical UUID form.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Express middleware that rejects the request unless every named route param
 * is a UUID. Names come as separate arguments or arrays, optionally followed by
 * an options object: requireUuidParam('requesterId', 'id', { status: 404 }).
 * Defaults to 400; pass { status: 404, message: 'Not found.' } when a probe
 * should not learn that the id was malformed. Throws at mount time when no
 * name is given or a name is not a string, so a bad call cannot skip a param.
 * @param {...(string | string[] | { status?: number, message?: string })} args
 */
export function requireUuidParam(...args) {
  const last = args[args.length - 1]
  const hasOptions = last !== null && typeof last === 'object' && !Array.isArray(last)
  const { status = 400, message = 'A valid id is required.' } = hasOptions ? last : {}
  const names = (hasOptions ? args.slice(0, -1) : args).flat()
  if (names.length === 0 || names.some((n) => typeof n !== 'string' || !n)) {
    throw new TypeError('requireUuidParam needs one or more param names')
  }
  return function uuidParamGuard(req, res, next) {
    for (const param of names) {
      if (!isUuid(req.params?.[param])) {
        return res.status(status).json({ error: { message, status } })
      }
    }
    return next()
  }
}
