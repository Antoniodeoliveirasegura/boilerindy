// Sentry beforeSend scrubbing (issue #50), shared verbatim by the Express
// backend (server.mjs) and the React frontend (main.jsx) — the same pattern as
// dashboardLayout.mjs. Acceptance criterion: event payloads contain no emails,
// cookies, or tokens. Scrubbing must never throw — a scrubbing bug must not
// take down error reporting itself.

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
// JWTs (three base64url segments), Bearer values, and 32+ char hex strings.
const JWT_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g
const BEARER_RE = /\bBearer\s+[\w.~+/-]+=*/gi
const HEX_TOKEN_RE = /\b[0-9a-f]{32,}\b/gi

const DROPPED_HEADERS = ['cookie', 'set-cookie', 'authorization', 'x-api-key', 'apikey']

function scrubString(value) {
  return value
    .replace(JWT_RE, '[token]')
    .replace(BEARER_RE, 'Bearer [token]')
    .replace(HEX_TOKEN_RE, '[token]')
    .replace(EMAIL_RE, '[email]')
}

function scrubDeep(value) {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map(scrubDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = scrubDeep(entry)
    }
    return out
  }
  return value
}

/**
 * Scrub a Sentry event before it leaves the device/server.
 * Drops identifying fields outright (user, cookies, auth headers, request
 * bodies) and redacts emails/token-like strings everywhere else.
 */
export function scrubSentryEvent(event) {
  if (!event || typeof event !== 'object') return event
  try {
    const scrubbed = scrubDeep(event)

    // Identity and credentials never leave at all.
    delete scrubbed.user
    if (scrubbed.request) {
      delete scrubbed.request.cookies
      delete scrubbed.request.data
      if (scrubbed.request.headers) {
        for (const header of Object.keys(scrubbed.request.headers)) {
          if (DROPPED_HEADERS.includes(header.toLowerCase())) {
            delete scrubbed.request.headers[header]
          }
        }
      }
    }

    return scrubbed
  } catch {
    // If scrubbing itself fails, drop the event rather than risk leaking PII.
    return null
  }
}
