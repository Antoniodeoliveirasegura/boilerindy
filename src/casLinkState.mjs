import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Single-use state nonce for the website Purdue CAS link flow (issue #293).
 *
 * GET /auth/purdue/callback writes a Purdue identity onto the signed-in
 * student, and a Lax session cookie rides a top-level navigation, so without
 * a nonce anyone could hand a signed-in student a callback URL carrying the
 * attacker's own CAS ticket and overwrite their link. The connect route mints
 * a nonce into the session and puts it in the CAS service URL; the callback
 * takes it back out of the session (spending it) and refuses the link unless
 * the value in the URL matches.
 *
 * The native ?t= flow does not use this: the signed handoff token already
 * binds that attempt to the student and never touches the session.
 */

export function createCasState(generate = randomBytes) {
  return generate(16).toString('hex')
}

/**
 * Read the nonce and delete it from the session in one step, so a callback
 * can only ever spend it once, whether or not the rest of the link succeeds.
 * Returns '' when there is none.
 */
export function takeCasState(session) {
  if (!session || typeof session !== 'object') return ''
  const value = session.casState
  delete session.casState
  return typeof value === 'string' ? value : ''
}

/** Constant-time comparison; false unless both are equal non-empty strings. */
export function casStateMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false
  if (!expected || !provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  // Compare byte lengths, not string lengths: a multi-byte character would
  // otherwise make timingSafeEqual throw.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * The website callback's gate: spend the session's nonce and return it when
 * the callback's ?state= matches, or null when the callback must be refused
 * (no nonce, a wrong or missing state, or a nonce already spent). The nonce is
 * gone afterwards either way.
 */
export function spendCasState(session, providedState) {
  const expected = takeCasState(session)
  const provided = typeof providedState === 'string' ? providedState : ''
  return casStateMatches(expected, provided) ? expected : null
}

/**
 * The CAS service URL. CAS validates a ticket against the byte-identical
 * service string it was issued for, so the login redirect and the ticket
 * validation must build it the same way. The website variant carries the
 * post-link path and, when there is one, the state nonce, which makes the
 * nonce part of what CAS signs. The native variant carries only the handoff
 * token so the callback can identify the student without a cookie (#214),
 * and a state is never added to it.
 */
export function buildCasServiceUrl(baseUrl, { nextPath, token, state } = {}) {
  if (token) return `${baseUrl}/auth/purdue/callback?t=${encodeURIComponent(token)}`
  const base = `${baseUrl}/auth/purdue/callback?next=${encodeURIComponent(nextPath)}`
  return typeof state === 'string' && state ? `${base}&state=${encodeURIComponent(state)}` : base
}
