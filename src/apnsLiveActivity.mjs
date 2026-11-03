// The APNs sender for Track this bus, the app's Live Activity (issue #550,
// "Later"; boilerindy-app#173, item 5). The app starts the activity and
// reports its push token at POST /api/live-activities; the 30-second tick
// (src/liveActivities.mjs) decides what to send, and this module sends it
// straight to Apple's push service. No dependency, as with Web Push
// (src/webPush.mjs):
//
// - Token auth: every request carries a provider token, an ES256 JWT whose
//   header names the key (kid, APNS_KEY_ID) and whose claims name the team
//   (iss, APNS_TEAM_ID) and when it was made (iat), signed by the .p8 auth key
//   (APNS_KEY_P8) with node:crypto. APNs refuses a token older than an hour
//   (403 ExpiredProviderToken) and one replaced more often than every 20
//   minutes (429 TooManyProviderTokenUpdates), so one token serves 50 minutes.
// - HTTP/2 over node:http2: one session per APNs host, opened by the first push
//   and kept for the next ticks. A session that closes, fails or is told to go
//   away is forgotten, and the next push opens another.
// - The push: POST /3/device/<token> with apns-push-type liveactivity, the
//   topic <bundle id>.push-type.liveactivity, a priority (5, or 10 for what
//   must show at once) and an expiration, and a JSON body (liveActivityPayload)
//   whose aps holds the event, the content state and the dates.
// - The answer: 200 is delivered. 410, and a 400 BadDeviceToken or
//   DeviceTokenNotForTopic, mean the token will never take a push again
//   (gone). 429, a 5xx, a timeout or a lost connection mean APNs is busy or
//   down (retry). A 403 ExpiredProviderToken renews the provider token and
//   sends once more; any other 403 is the key's setup.
//
// Tokens and the key are never logged or returned: a result carries the HTTP
// status and APNs' reason code only. test/apnsLiveActivity.test.mjs sends every
// request to a local HTTP/2 stub and verifies the provider token's signature.

import crypto from 'node:crypto'
import http2 from 'node:http2'

export const APNS_ORIGINS = Object.freeze({
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
})
// The app's bundle id, ios.bundleIdentifier in boilerindy-app's app.json.
export const APNS_BUNDLE_ID = 'com.boilerindy.app'
export const APNS_TOPIC = `${APNS_BUNDLE_ID}.push-type.liveactivity`
export const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60 * 1000
export const REQUEST_TIMEOUT_MS = 10_000
// APNs takes Live Activity payloads up to 4 KB.
export const MAX_PAYLOAD_BYTES = 4096

// A key id and a team id are ten characters from the Apple Developer portal.
const APPLE_ID_RE = /^[A-Z0-9]{10}$/
// A push token as the app reports it: the token's bytes in hex.
const APNS_TOKEN_RE = /^(?:[0-9a-f]{2}){16,256}$/
// The answers a token never recovers from: it is not a token, or not this app's.
const GONE_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic'])

/** A push token in the lowercase hex APNs takes, or null when it is not one. */
export function normalizeApnsToken(value) {
  if (typeof value !== 'string') return null
  const token = value.trim().toLowerCase()
  return APNS_TOKEN_RE.test(token) ? token : null
}

// The .p8 file's contents, pasted with its line breaks, with "\n" for each, or
// as the base64 body alone.
function p8ToPem(value) {
  const text = value.replace(/\\n/g, '\n').trim()
  if (text.includes('-----BEGIN')) return text
  const body = text.replace(/\s+/g, '')
  return `-----BEGIN PRIVATE KEY-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`
}

/**
 * Read and check APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID. Returns null when
 * none is set (Live Activities off), throws when they are set in part or the
 * key does not load as an APNs auth key (a P-256 EC key), so a bad paste shows
 * at boot instead of as 403s from APNs. No message ever holds the key.
 */
export function loadApnsConfig(env = process.env) {
  const pem = String(env.APNS_KEY_P8 || '').trim()
  const keyId = String(env.APNS_KEY_ID || '').trim()
  const teamId = String(env.APNS_TEAM_ID || '').trim()
  if (!pem && !keyId && !teamId) return null
  if (!pem || !keyId || !teamId) throw new Error('APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID must be set together')
  if (!APPLE_ID_RE.test(keyId)) throw new Error('APNS_KEY_ID must be the 10-character key id of the APNs auth key')
  if (!APPLE_ID_RE.test(teamId)) throw new Error('APNS_TEAM_ID must be the 10-character Apple team id')
  let privateKey
  try {
    privateKey = crypto.createPrivateKey(p8ToPem(pem))
  } catch {
    throw new Error('APNS_KEY_P8 is not a readable .p8 key')
  }
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('APNS_KEY_P8 must be an APNs auth key (a P-256 EC key)')
  }
  return { keyId, teamId, privateKey }
}

const base64Url = (value) => Buffer.from(value).toString('base64url')

/**
 * The provider token for `now`: an ES256 JWT, { alg, kid } and { iss, iat },
 * signed by the auth key in the raw r||s form JWS uses.
 */
export function createProviderToken({ keyId, teamId, privateKey, now = Date.now() }) {
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = base64Url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))
  const signingInput = `${header}.${claims}`
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${base64Url(signature)}`
}

/** Decode and verify a provider token with the key's public half (tests, tooling); null when it does not verify. */
export function verifyProviderToken(token, publicKey) {
  const [header, claims, signature] = String(token).split('.')
  if (!header || !claims || !signature) return null
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${header}.${claims}`, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  )
  if (!ok) return null
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')),
  }
}

const unixSeconds = (ms) => Math.floor(ms / 1000)

/**
 * A Live Activity push's body, as Apple's "Updating and ending your Live
 * Activity with ActivityKit push notifications" lays it out: aps holds the
 * event ('update' or 'end'), the content state the app's ActivityKit
 * attributes decode, the time it was made (an older one than the last applied
 * is ignored), and when given, the stale date (the activity dims past it), the
 * dismissal date (an ended one leaves the Lock Screen then) and an alert,
 * which lights the screen and plays its sound. Dates come in as epoch ms and go
 * out as Unix seconds.
 */
export function liveActivityPayload({ event, contentState, now, staleAt = null, dismissAt = null, alert = null }) {
  const aps = { timestamp: unixSeconds(now), event, 'content-state': contentState }
  if (staleAt != null) aps['stale-date'] = unixSeconds(staleAt)
  if (dismissAt != null) aps['dismissal-date'] = unixSeconds(dismissAt)
  if (alert) aps.alert = alert
  return { aps }
}

// APNs' reason code from an error body, { "reason": "BadDeviceToken" }, or ''
// for anything else; only a plain word, so a log line never carries more.
function reasonOf(body) {
  try {
    const reason = JSON.parse(body)?.reason
    return typeof reason === 'string' && /^[A-Za-z]{1,64}$/.test(reason) ? reason : ''
  } catch {
    return ''
  }
}

function outcome({ status, reason }) {
  if (status === 200) return { ok: true, status }
  return {
    ok: false,
    status,
    reason: reason || (status ? `http_${status}` : 'network'),
    gone: status === 410 || (status === 400 && GONE_REASONS.has(reason)),
    retry: status === 0 || status === 429 || status >= 500,
  }
}

/**
 * The APNs sender: { send, close }. `send({ token, env, payload, priority,
 * expiration })` pushes one Live Activity update or end to the activity whose
 * push token is `token`, on the host for `env` ('production' or
 * 'development'), with `expiration` in Unix seconds, and resolves with { ok,
 * status } or { ok: false, status, reason, gone, retry }. It never rejects: a
 * lost connection or a timeout is status 0 with `retry`. `close()` closes the
 * sessions.
 *
 * `origins`, `connect` and `now` are there for the tests: a local HTTP/2 stub
 * for Apple's hosts, and a clock to age the provider token.
 */
export function createApnsSender({ config, origins = APNS_ORIGINS, connect = http2.connect, now = () => Date.now(), timeoutMs = REQUEST_TIMEOUT_MS }) {
  const sessions = new Map()
  let provider = null

  function providerToken({ renew = false } = {}) {
    const at = now()
    if (renew || !provider || at - provider.madeAt >= PROVIDER_TOKEN_LIFETIME_MS) {
      provider = { token: createProviderToken({ ...config, now: at }), madeAt: at }
    }
    return provider.token
  }

  function sessionFor(origin) {
    const open = sessions.get(origin)
    if (open && !open.closed && !open.destroyed) return open
    const session = connect(origin)
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin)
    }
    // A failure also reaches every stream on the session, which answers it;
    // without a listener an 'error' event would end the process.
    session.on('error', forget)
    session.on('goaway', forget)
    session.on('close', forget)
    // The tick keeps the session between pushes; it should not keep the
    // process alive on its own.
    session.unref()
    sessions.set(origin, session)
    return session
  }

  function post(origin, token, headers, body) {
    return new Promise((resolve) => {
      let status = 0
      let settled = false
      const done = (answer) => {
        if (settled) return
        settled = true
        resolve(answer)
      }
      let stream
      try {
        stream = sessionFor(origin).request({ ':method': 'POST', ':path': `/3/device/${token}`, ...headers })
      } catch {
        done({ status: 0, reason: 'network' })
        return
      }
      const chunks = []
      stream.setEncoding('utf8')
      stream.on('response', (response) => {
        status = Number(response[':status']) || 0
      })
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => done({ status, reason: reasonOf(chunks.join('')) }))
      stream.on('error', () => done({ status: 0, reason: 'network' }))
      stream.on('close', () => done({ status, reason: status ? reasonOf(chunks.join('')) : 'network' }))
      stream.setTimeout(timeoutMs, () => {
        done({ status: 0, reason: 'timeout' })
        stream.close(http2.constants.NGHTTP2_CANCEL)
      })
      stream.end(body)
    })
  }

  async function send({ token, env, payload, priority = 5, expiration = 0 }) {
    const origin = origins[env]
    const deviceToken = normalizeApnsToken(token)
    if (!origin || !deviceToken) return outcome({ status: 400, reason: 'BadDeviceToken' })
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) return { ok: false, status: 413, reason: 'PayloadTooLarge', gone: false, retry: false }
    const headers = (authorization) => ({
      authorization: `bearer ${authorization}`,
      'apns-push-type': 'liveactivity',
      'apns-topic': APNS_TOPIC,
      'apns-priority': String(priority),
      'apns-expiration': String(Math.max(0, Math.floor(expiration))),
      'content-type': 'application/json',
    })
    let answer = await post(origin, deviceToken, headers(providerToken()), body)
    if (answer.status === 403 && answer.reason === 'ExpiredProviderToken') {
      answer = await post(origin, deviceToken, headers(providerToken({ renew: true })), body)
    }
    return outcome(answer)
  }

  function close() {
    for (const session of sessions.values()) session.close()
    sessions.clear()
  }

  return { send, close }
}
