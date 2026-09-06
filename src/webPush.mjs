// Web Push without a library (issue #9).
//
// Three standards, all implemented with node:crypto so the backend gains no new
// dependency and Render's install stays as it is:
//
// - RFC 8292 (VAPID): every push request carries a short-lived ES256 JWT signed
//   with the server's VAPID key pair, so push services can attribute traffic.
// - RFC 8291 + RFC 8188 (aes128gcm): the payload is encrypted to the browser's
//   per-subscription P-256 key and auth secret, so the push service only relays
//   opaque bytes. The record layout is salt(16) | rs(4) | idlen(1) | as_public(65)
//   | ciphertext, a single record ending in the 0x02 delimiter.
// - Push service HTTP responses: 201 (and 200/202) means accepted; 404/410 means
//   the subscription is gone and must be deleted; 429/5xx are retryable.
//
// test/webPush.test.mjs checks the encryption against the RFC 8291 Appendix A
// vector and verifies the VAPID signature, so a refactor cannot silently break
// interoperability.

import crypto from 'node:crypto'

export const PUBLIC_KEY_LENGTH = 65 // uncompressed P-256 point: 0x04 | x | y
export const AUTH_SECRET_LENGTH = 16
export const RECORD_SIZE = 4096
// Push services cap payloads at 4 KiB including the aes128gcm header, so keep
// application payloads comfortably below that.
export const MAX_PAYLOAD_BYTES = 3800
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60
export const DEFAULT_VAPID_SUBJECT = 'mailto:support@boilerindy.app'
// VAPID tokens may live at most 24 hours; 12 keeps clock skew comfortable.
export const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60

const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8')
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8')
const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0', 'utf8')
const CURVE = 'prime256v1'

export function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

export function base64UrlDecode(text) {
  const normalized = String(text || '').trim().replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

function isUncompressedPoint(buf) {
  return Buffer.isBuffer(buf) && buf.length === PUBLIC_KEY_LENGTH && buf[0] === 4
}

/**
 * Generate a fresh VAPID key pair in the base64url form used by every Web Push
 * tool (65-byte uncompressed public point, 32-byte private scalar).
 */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH(CURVE)
  ecdh.generateKeys()
  return {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(ecdh.getPrivateKey()),
  }
}

/**
 * Read and validate VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT.
 * Returns null when the keys are absent (push disabled), throws when they are
 * present but malformed or do not belong together, so a bad paste surfaces at
 * boot instead of as 403s from push services.
 */
export function loadVapidKeys(env = process.env) {
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim()
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim()
  if (!publicKey && !privateKey) return null
  if (!publicKey || !privateKey) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together')
  }
  const publicKeyBytes = base64UrlDecode(publicKey)
  if (!isUncompressedPoint(publicKeyBytes)) {
    throw new Error('VAPID_PUBLIC_KEY must be a base64url 65-byte uncompressed P-256 point')
  }
  const privateKeyBytes = base64UrlDecode(privateKey)
  if (privateKeyBytes.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a base64url 32-byte P-256 scalar')
  }
  const ecdh = crypto.createECDH(CURVE)
  try {
    ecdh.setPrivateKey(privateKeyBytes)
  } catch {
    throw new Error('VAPID_PRIVATE_KEY is not a valid P-256 scalar')
  }
  if (!ecdh.getPublicKey().equals(publicKeyBytes)) {
    throw new Error('VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY')
  }
  const subject = String(env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT).trim()
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
    throw new Error('VAPID_SUBJECT must be a mailto: address or an https: URL')
  }
  return {
    publicKey: base64UrlEncode(publicKeyBytes),
    privateKey: base64UrlEncode(privateKeyBytes),
    subject,
    publicKeyBytes,
    privateKeyBytes,
  }
}

function vapidPrivateKeyObject(keys) {
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(keys.publicKeyBytes.subarray(1, 33)),
      y: base64UrlEncode(keys.publicKeyBytes.subarray(33, 65)),
      d: keys.privateKey,
    },
    format: 'jwk',
  })
}

export function vapidPublicKeyObject(keys) {
  return crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(keys.publicKeyBytes.subarray(1, 33)),
      y: base64UrlEncode(keys.publicKeyBytes.subarray(33, 65)),
    },
    format: 'jwk',
  })
}

/**
 * Build the `Authorization: vapid t=<jwt>, k=<public key>` header for one push
 * endpoint. The audience is the endpoint's origin, as RFC 8292 requires.
 */
export function createVapidAuthorization({ endpoint, keys, now = Date.now(), lifetimeSeconds = VAPID_TOKEN_LIFETIME_SECONDS }) {
  const aud = new URL(endpoint).origin
  const exp = Math.floor(now / 1000) + Math.min(lifetimeSeconds, 24 * 60 * 60)
  const header = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = base64UrlEncode(JSON.stringify({ aud, exp, sub: keys.subject }))
  const signingInput = `${header}.${claims}`
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: vapidPrivateKeyObject(keys),
    dsaEncoding: 'ieee-p1363',
  })
  const token = `${signingInput}.${base64UrlEncode(signature)}`
  return { authorization: `vapid t=${token}, k=${keys.publicKey}`, token, aud, exp }
}

/** Decode and verify a VAPID JWT with the matching public key (tests, tooling). */
export function verifyVapidToken(token, keys) {
  const [header, claims, signature] = String(token).split('.')
  if (!header || !claims || !signature) return null
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${header}.${claims}`, 'utf8'),
    { key: vapidPublicKeyObject(keys), dsaEncoding: 'ieee-p1363' },
    base64UrlDecode(signature),
  )
  if (!ok) return null
  return {
    header: JSON.parse(base64UrlDecode(header).toString('utf8')),
    claims: JSON.parse(base64UrlDecode(claims).toString('utf8')),
  }
}

function deriveContentKeys({ sharedSecret, authSecret, uaPublic, asPublic, salt }) {
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, CEK_INFO, 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, NONCE_INFO, 12))
  return { cek, nonce }
}

/**
 * Encrypt a payload for one subscription (RFC 8291). `salt` and
 * `senderPrivateKey` exist so tests can pin the RFC vector; production callers
 * leave both undefined and get fresh randomness per message.
 */
export function encryptPayload(plaintext, { p256dh, auth }, { salt, senderPrivateKey } = {}) {
  const uaPublic = base64UrlDecode(p256dh)
  if (!isUncompressedPoint(uaPublic)) throw new Error('subscription p256dh key is not a 65-byte P-256 point')
  const authSecret = base64UrlDecode(auth)
  if (authSecret.length !== AUTH_SECRET_LENGTH) throw new Error('subscription auth secret must be 16 bytes')

  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')
  if (data.length > MAX_PAYLOAD_BYTES) throw new Error(`push payload exceeds ${MAX_PAYLOAD_BYTES} bytes`)

  const ecdh = crypto.createECDH(CURVE)
  if (senderPrivateKey) ecdh.setPrivateKey(senderPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(uaPublic)
  const saltBytes = salt ? Buffer.from(salt) : crypto.randomBytes(16)
  if (saltBytes.length !== 16) throw new Error('salt must be 16 bytes')

  const { cek, nonce } = deriveContentKeys({ sharedSecret, authSecret, uaPublic, asPublic, salt: saltBytes })
  const record = Buffer.concat([data, Buffer.from([2])]) // final record delimiter, no padding
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(21)
  saltBytes.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, ciphertext])
}

/**
 * The receiver side of encryptPayload, as a browser would do it. Used by the
 * tests to prove a round trip; exported so tooling can inspect messages.
 */
export function decryptPayload(body, { receiverPrivateKey, auth }) {
  const buf = Buffer.from(body)
  if (buf.length < 21) throw new Error('body too short')
  const salt = buf.subarray(0, 16)
  const idlen = buf[20]
  const asPublic = buf.subarray(21, 21 + idlen)
  const ciphertext = buf.subarray(21 + idlen)
  const ecdh = crypto.createECDH(CURVE)
  ecdh.setPrivateKey(Buffer.from(receiverPrivateKey))
  const uaPublic = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(asPublic)
  const { cek, nonce } = deriveContentKeys({
    sharedSecret,
    authSecret: base64UrlDecode(auth),
    uaPublic,
    asPublic,
    salt,
  })
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  let end = record.length
  while (end > 0 && record[end - 1] === 0) end -= 1
  if (end === 0 || (record[end - 1] !== 2 && record[end - 1] !== 1)) throw new Error('bad record delimiter')
  return record.subarray(0, end - 1)
}

/** RFC 8030 Topic header: at most 32 URL-safe base64 characters. */
export function normalizeTopic(topic) {
  const cleaned = String(topic || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  return cleaned || null
}

export function isValidSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false
  if (typeof sub.endpoint !== 'string' || !/^https:\/\/\S+$/.test(sub.endpoint) || sub.endpoint.length > 2048) return false
  const keys = sub.keys
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false
  try {
    return isUncompressedPoint(base64UrlDecode(keys.p256dh)) && base64UrlDecode(keys.auth).length === AUTH_SECRET_LENGTH
  } catch {
    return false
  }
}

/**
 * Deliver one payload to one subscription. Never throws: the result tells the
 * caller whether to keep, retry, or delete the subscription.
 */
export async function sendWebPush({
  subscription,
  payload,
  keys,
  ttl = DEFAULT_TTL_SECONDS,
  urgency = 'normal',
  topic = null,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = 15_000,
}) {
  if (!keys) return { ok: false, status: 0, gone: false, retry: false, error: 'VAPID keys are not configured' }
  if (!isValidSubscription(subscription)) {
    return { ok: false, status: 0, gone: true, retry: false, error: 'invalid subscription' }
  }
  let body
  try {
    body = encryptPayload(typeof payload === 'string' ? payload : JSON.stringify(payload), subscription.keys)
  } catch (err) {
    return { ok: false, status: 0, gone: false, retry: false, error: err.message }
  }
  const { authorization } = createVapidAuthorization({ endpoint: subscription.endpoint, keys, now })
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(Math.max(0, Math.floor(ttl))),
    Urgency: ['very-low', 'low', 'normal', 'high'].includes(urgency) ? urgency : 'normal',
    Authorization: authorization,
  }
  const normalizedTopic = normalizeTopic(topic)
  if (normalizedTopic) headers.Topic = normalizedTopic

  let response
  try {
    response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ok: false, status: 0, gone: false, retry: true, error: err?.message || 'network error' }
  }
  const status = response.status
  if (status === 201 || status === 200 || status === 202) return { ok: true, status, gone: false, retry: false }
  let detail = ''
  try {
    detail = String(await response.text()).slice(0, 200)
  } catch {
    detail = ''
  }
  return {
    ok: false,
    status,
    gone: status === 404 || status === 410,
    retry: status === 429 || status >= 500,
    error: detail || `push service responded ${status}`,
  }
}
