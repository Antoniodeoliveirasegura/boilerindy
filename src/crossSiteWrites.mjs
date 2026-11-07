// Refuse state-changing requests that a browser sends from another site.
//
// pih.sid is SameSite=Lax, which keeps the cookie off a cross-site POST. It
// does not stop the response to a top-level cross-site form POST from setting
// or clearing pih.sid, so without this a page on another site could submit a
// form that signs the visitor in to an account it controls (login CSRF) or
// signs them out. Every legitimate caller is either same-origin (the website
// reaches the API through the Vercel /api rewrite, and the server has no CORS
// policy, so a cross-origin page cannot send it JSON anyway) or not a browser
// page at all (the native app, cron jobs, webhooks, tests), so refusing
// cross-origin browser writes costs nothing that works today.
//
// Browsers mark each request with Sec-Fetch-Site, so that header decides when
// it is present: only same-origin and none (a request the user started, not a
// page) pass. A browser old enough not to send it still sends Origin on a
// cross-origin POST, so Origin decides next: it passes when it is a trusted
// origin (CLIENT_APP_URL, BACKEND_PUBLIC_URL) or names the request's own host.
// A request with neither header did not come from a web page and passes.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const PASSING_SITES = new Set(['same-origin', 'none'])

function originOf(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * @param {{ trustedOrigins?: string[] }} options - full URLs or origins; anything after the origin is ignored
 * @returns {(req: import('express').Request, res: import('express').Response, next: () => void) => void}
 */
export function createCrossSiteWriteGuard({ trustedOrigins = [] } = {}) {
  const trusted = new Set(trustedOrigins.map(originOf).filter(Boolean))

  function allowed(req) {
    if (SAFE_METHODS.has(req.method)) return true
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site) return PASSING_SITES.has(site.toLowerCase())
    const origin = req.headers.origin
    if (origin === undefined) return true
    const parsed = originOf(origin)
    if (!parsed) return false
    if (trusted.has(parsed)) return true
    const host = String(req.headers.host || '').toLowerCase()
    return Boolean(host) && new URL(parsed).host === host
  }

  return function crossSiteWriteGuard(req, res, next) {
    if (allowed(req)) return next()
    console.warn(`[cross-site] refused ${req.method} ${req.path} (sec-fetch-site=${req.headers['sec-fetch-site'] ?? 'none sent'}, origin=${req.headers.origin ?? 'none sent'})`)
    res.status(403).json({ error: { message: 'Cross-site request refused.', status: 403, code: 'cross_site_request' } })
  }
}
