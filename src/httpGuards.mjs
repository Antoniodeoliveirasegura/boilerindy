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
 * is a UUID. Defaults to 400; pass { status: 404, message: 'Not found.' } when
 * a probe should not learn that the id was malformed.
 * @param {string | string[]} name - param name(s), e.g. 'id' or ['type', 'id']
 * @param {{ status?: number, message?: string }} [options]
 */
export function requireUuidParam(name, { status = 400, message = 'A valid id is required.' } = {}) {
  const names = Array.isArray(name) ? name : [name]
  return function uuidParamGuard(req, res, next) {
    for (const param of names) {
      if (!isUuid(req.params?.[param])) {
        return res.status(status).json({ error: { message, status } })
      }
    }
    return next()
  }
}
