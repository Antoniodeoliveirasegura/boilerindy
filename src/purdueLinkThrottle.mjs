import { createHash } from 'node:crypto'
import { createRateLimiter } from './rateLimiter.mjs'

/**
 * One rate limit for the three browser steps of a Purdue link attempt
 * (issue #293): GET /auth/purdue/connect, POST /auth/purdue/dev/link and
 * GET /auth/purdue/callback. The step that mints a native handoff token
 * (POST /api/purdue/link-token) was already limited; the steps that spend it
 * were not, and each one reads the student from Supabase before it can refuse
 * anything, so the limiter is mounted ahead of that lookup.
 *
 * Buckets, in order:
 * - a live handoff token (signature valid, not expired, not spent), so
 *   students linking from the app behind one campus NAT do not share a budget.
 *   Only a live token gets its own bucket: keying on whatever ?t= a request
 *   carries would give every forged value a fresh budget and make the limit
 *   free to bypass. The key is a hash prefix, so a token never reaches the
 *   limiter's log line.
 * - the session user, for the website flow.
 * - otherwise null, which the limiter turns into the client IP.
 *
 * All three routes are browser redirects, and the app's auth session waits
 * for a redirect to its return URL, so a JSON 429 would leave it hanging. A
 * blocked request is answered in the caller's own shape instead.
 */

export const PURDUE_LINK_FLOW_WINDOW_MS = 15 * 60 * 1000
export const PURDUE_LINK_FLOW_MAX = 30
export const THROTTLED_NATIVE_MESSAGE = 'Too many attempts. Wait a few minutes and try again.'

/**
 * The handoff token a link request carries, or '' for the website flow. The
 * same rule resolvePurdueLinkActor uses to choose between the two flows.
 */
export function linkHandoffToken(req) {
  const raw = req?.query?.t ?? req?.body?.t
  return typeof raw === 'string' ? raw : ''
}

/**
 * Bucket key for the link flow. `verifyToken` throws for a token that is not
 * live (the handoff's own verify), and anything it throws means "not a token
 * bucket".
 */
export function purdueLinkFlowKey(req, verifyToken) {
  const token = linkHandoffToken(req)
  if (token) {
    try {
      verifyToken(token)
      return `pl:${createHash('sha256').update(token).digest('base64url').slice(0, 16)}`
    } catch {
      // Forged, expired or spent: fall through to the user or the IP.
    }
  }
  const userId = req?.session?.userId
  if (typeof userId === 'string' && userId) return `u:${userId}`
  return null
}

/**
 * @param {object} options
 * @param {{ verify: (token: string) => unknown, returnUrl: (status: string, params?: object) => string }} options.handoff
 *   The Purdue link handoff (src/purdueLinkHandoff.mjs).
 * @param {string} options.clientAppUrl Website origin for the throttled redirect.
 */
export function createPurdueLinkFlowRateLimit({
  handoff,
  clientAppUrl,
  windowMs = PURDUE_LINK_FLOW_WINDOW_MS,
  max = PURDUE_LINK_FLOW_MAX,
}) {
  return createRateLimiter({
    name: 'purdue-link-flow',
    windowMs,
    max,
    keyBy: (req) => purdueLinkFlowKey(req, (token) => handoff.verify(token)),
    onLimit: (req, res) => {
      if (linkHandoffToken(req)) {
        return res.redirect(handoff.returnUrl('error', { reason: 'rate-limited', message: THROTTLED_NATIVE_MESSAGE }))
      }
      return res.redirect(`${clientAppUrl}/settings?error=purdue-link-throttled`)
    },
  })
}
