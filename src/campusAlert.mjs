// Campus emergency alerts for the banner on the website and the app (issue
// #34 and its research note of 2026-11-01). The source is IU's public alert
// feed for its Indianapolis campus: Purdue Indianapolis shares that campus,
// IU's police cover it, and IU sends an alert for each emergency there (a
// dangerous situation near a garage, a tornado warning, a closure).
// PurdueALERT has no Indianapolis feed a program can read (its public CAP
// channel is West Lafayette only), so it is not read here.
//
// The feed is CAP 1.2 as JSON and holds exactly one message, the latest.
// IU's own banner script (site-builder.js on builder-common.iu.edu) shows
// that message until one whose headline says "Campus Status Normal" replaces
// it, and this module uses the same rule. `expires` cannot do that job: IU
// sets it 15 minutes after `sent`, while an incident runs one to two hours
// and the Normal after a tornado warning has come up to 11 hours later.
//
// IU's words are passed on unchanged apart from whitespace and a length cap;
// nothing here rewrites or summarizes an alert. A message that says TEST in
// capitals, or "only a drill", is marked as a test, so the clients can show
// it the way IU does without the weight of a real emergency.
//
// Shape, like src/circuitNews.mjs: a pure reader (payload in, message out),
// the answer builder for GET /api/campus-alert, and a fetch shell with an
// injectable fetch. The route (src/routes/campus.mjs) and the push tick
// (src/campusAlertPush.mjs) share one reading, cached for 15 s through the
// server's shared stale-on-failure cache (readCampusAlertCached). See
// docs/campus-alerts.md.

export const IU_ALERT_FEED_URL = 'https://exdd-resources.webapps.iu.edu/api/public/v1/rave/indianapolis?output=json'
// How the clients credit the alert ("IU Indianapolis alert").
export const IU_ALERT_SOURCE = 'IU Indianapolis'
export const MAX_HEADLINE_CHARS = 300
export const MAX_MESSAGE_CHARS = 2000
// A reading older than this is one the cache keeps serving because IU could
// not be reached since; the answer marks it stale so a banner can say when it
// was last checked.
export const STALE_AFTER_MS = 2 * 60 * 1000
// IU is asked at most this often per process, whoever reads the alert.
export const CAMPUS_ALERT_CACHE_MS = 15 * 1000
const CAMPUS_ALERT_CACHE_KEY = 'campus:alert'
const FETCH_TIMEOUT_MS = 8_000
const USER_AGENT = 'BoilerIndy campus app (+https://www.boilerindy.app)'
const NORMAL_HEADLINE = /campus status normal/i
const SEVERITIES = new Set(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'])

/** Plain text: control characters dropped, whitespace collapsed, cut to `max` with an ellipsis. */
function plainText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function isoTime(value) {
  if (typeof value !== 'string' || !value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const words = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The message in IU's feed, or null when the payload is not a CAP message
 * this reader understands (no info block, or no headline):
 * { id, sentAt, headline, message, instruction, severity, test, normal }.
 * `message` is IU's description, or null when it only repeats the headline;
 * `normal` is IU's all clear, which ends whatever alert came before it.
 */
export function readIuAlert(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const info = Array.isArray(payload.info) ? payload.info[0] : payload.info
  if (!info || typeof info !== 'object') return null
  const headline = plainText(info.headline, MAX_HEADLINE_CHARS)
  if (!headline) return null
  const description = plainText(info.description, MAX_MESSAGE_CHARS)
  const instruction = plainText(info.instruction, MAX_MESSAGE_CHARS)
  const text = `${headline} ${description}`
  return {
    id: plainText(payload.identifier, 120) || null,
    sentAt: isoTime(payload.sent),
    headline,
    message: description && words(description) !== words(headline) ? description : null,
    instruction: instruction || null,
    severity: SEVERITIES.has(info.severity) ? info.severity : 'Unknown',
    test: payload.status === 'Test' || payload.status === 'Exercise' || /\bTEST\b/.test(text) || /\bonly a drill\b/i.test(text),
    normal: NORMAL_HEADLINE.test(headline),
  }
}

/**
 * How loudly a client shows an alert: a test quietly, Moderate and Minor (a
 * closure, a power outage) as a warning, and the rest (Severe, Extreme, or a
 * severity IU left Unknown) as an emergency.
 */
export function alertLevel(alert) {
  if (alert.test) return 'test'
  return alert.severity === 'Moderate' || alert.severity === 'Minor' ? 'warning' : 'danger'
}

/**
 * GET /api/campus-alert's answer for a reading ({ fetchedAt, alert }):
 * { enabled: true, active, alert, checkedAt, stale }. `alert` is null unless
 * active. checkedAt is when IU last answered, and stale says the server has
 * kept serving that answer for more than STALE_AFTER_MS because IU could not
 * be reached since.
 */
export function campusAlertAnswer(reading, { now = Date.now() } = {}) {
  const { fetchedAt, alert } = reading
  const active = Boolean(alert && !alert.normal)
  return {
    enabled: true,
    active,
    alert: active
      ? {
          id: alert.id,
          source: IU_ALERT_SOURCE,
          sentAt: alert.sentAt,
          headline: alert.headline,
          message: alert.message,
          instruction: alert.instruction,
          severity: alert.severity,
          level: alertLevel(alert),
          test: alert.test,
        }
      : null,
    checkedAt: new Date(fetchedAt).toISOString(),
    stale: now - fetchedAt > STALE_AFTER_MS,
  }
}

/** The answer while CAMPUS_ALERTS is off: nothing to show, and IU is never asked. */
export const CAMPUS_ALERTS_OFF = Object.freeze({ enabled: false, active: false, alert: null, checkedAt: null, stale: false })

/**
 * Fetch and read IU's feed: { fetchedAt, alert }. Throws on a network error,
 * a timeout, a non-200 answer or a payload this reader cannot read, so the
 * server's cache keeps serving the last good reading and tries again shortly.
 */
export async function fetchCampusAlert({ fetchImpl = globalThis.fetch, now = () => Date.now(), feedUrl = IU_ALERT_FEED_URL } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(feedUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`IU's alert feed answered ${res.status}`)
    const alert = readIuAlert(await res.json())
    if (!alert) throw new Error("IU's alert feed answered a message without a headline")
    return { fetchedAt: now(), alert }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * IU's feed through server.mjs's shared stale-on-failure cache (getCached):
 * { fetchedAt, alert }, asked of IU at most every CAMPUS_ALERT_CACHE_MS. The
 * banner's read and the push tick share the one reading, so the tick never
 * adds a request to IU. While IU cannot be reached the cache keeps serving its
 * last reading, whose fetchedAt shows its age; with none it throws.
 */
export function readCampusAlertCached(getCached, options = {}) {
  return getCached(CAMPUS_ALERT_CACHE_KEY, CAMPUS_ALERT_CACHE_MS, () => fetchCampusAlert(options))
}
