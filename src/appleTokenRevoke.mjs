// Sign in with Apple token revocation when an account is deleted. Apple asks
// an app that offers Sign in with Apple to revoke the user's tokens through
// the Sign in with Apple REST API when the account is deleted (developer
// news, 2022-05-24, "Account deletion requirement starts June 30"; TN3194).
// Supabase Auth keeps no provider tokens and makes no such call, so the native
// app sends the token from its fresh Apple confirmation with the delete
// request and this module revokes it. docs/sign-in-with-apple.md has the
// research, the settings and how to check them.
//
// - The client secret is an ES256 JWT (Apple, "Creating a client secret"):
//   header alg ES256 and kid (the Key ID), claims iss (the Team ID), iat, exp,
//   aud https://appleid.apple.com and sub (the client_id). It is signed here
//   with node:crypto for each request and lives five minutes, so unlike the
//   secret pasted into Supabase it never needs rotating.
// - POST https://appleid.apple.com/auth/revoke takes client_id, client_secret,
//   token and token_type_hint as a form. The client_id must be the one the
//   token was issued to: Supabase's OAuth flow authorizes with the first
//   Client ID of its Apple provider, the Services ID.
// - Apple answers 200 when the token is revoked or was already invalid, and a
//   400 with { error } otherwise.
//
// revoke() never throws, and neither the token nor the client secret is ever
// logged or returned.

import crypto from 'node:crypto'
import { UpstreamError, fetchUpstream } from './upstreamFetch.mjs'

export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke'
export const APPLE_AUDIENCE = 'https://appleid.apple.com'
// Deletion waits on this call, so it gets less than the 8 s upstream default.
export const APPLE_REVOKE_TIMEOUT_MS = 5000
// Apple allows up to six months; one request needs a few seconds.
export const CLIENT_SECRET_LIFETIME_SECONDS = 5 * 60
export const APPLE_TOKEN_TYPES = Object.freeze(['refresh_token', 'access_token'])
// Apple's tokens are well under 1 KB; anything this long is not one.
export const MAX_APPLE_TOKEN_LENGTH = 4096

// The four settings, named as server.mjs reads them.
export const APPLE_REVOKE_SETTINGS = Object.freeze({
  teamId: 'APPLE_TEAM_ID',
  keyId: 'APPLE_SIGN_IN_KEY_ID',
  privateKey: 'APPLE_SIGN_IN_PRIVATE_KEY',
  servicesId: 'APPLE_SIGN_IN_SERVICES_ID',
})

const TEN_CHARACTER_ID = /^[A-Z0-9]{10}$/
const SERVICES_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
// One token: printable ASCII with no spaces, which every Apple token is.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/
const APPLE_ERROR_CODE = /^[a-z_]{1,64}$/

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * Reads the four settings. Answers { config } when all of them are usable,
 * { missing: [names] } when some are blank, and { error } when one is set but
 * cannot be right (the message names the setting, never its value).
 */
export function readAppleRevokeConfig({ teamId, keyId, privateKey, servicesId } = {}) {
  const values = { teamId: text(teamId), keyId: text(keyId), privateKey: text(privateKey), servicesId: text(servicesId) }
  const missing = Object.keys(APPLE_REVOKE_SETTINGS).filter((field) => !values[field])
  if (missing.length) return { missing: missing.map((field) => APPLE_REVOKE_SETTINGS[field]) }
  if (!TEN_CHARACTER_ID.test(values.teamId)) {
    return { error: 'APPLE_TEAM_ID must be the 10-character Team ID from the Apple Developer account' }
  }
  if (!TEN_CHARACTER_ID.test(values.keyId)) {
    return { error: 'APPLE_SIGN_IN_KEY_ID must be the 10-character Key ID of the Sign in with Apple key' }
  }
  if (!SERVICES_ID.test(values.servicesId) || values.servicesId.startsWith(`${values.teamId}.`)) {
    return { error: 'APPLE_SIGN_IN_SERVICES_ID must be the Services ID itself, such as com.example.app.web, without the Team ID' }
  }
  let key
  try {
    // A key pasted into a one-line environment value often carries literal \n.
    key = crypto.createPrivateKey(values.privateKey.replace(/\\n/g, '\n'))
  } catch {
    return { error: 'APPLE_SIGN_IN_PRIVATE_KEY is not a PEM private key (the contents of the .p8 file)' }
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return { error: 'APPLE_SIGN_IN_PRIVATE_KEY is not a P-256 key (the contents of the .p8 file)' }
  }
  return { config: { teamId: values.teamId, keyId: values.keyId, servicesId: values.servicesId, privateKey: key } }
}

const base64url = (value) => Buffer.from(value).toString('base64url')

/** The client_secret JWT for one request, signed with the Sign in with Apple key. */
export function createAppleClientSecret(config, { now = Date.now(), lifetimeSeconds = CLIENT_SECRET_LIFETIME_SECONDS } = {}) {
  const iat = Math.floor(now / 1000)
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))
  const claims = base64url(
    JSON.stringify({ iss: config.teamId, iat, exp: iat + lifetimeSeconds, aud: APPLE_AUDIENCE, sub: config.servicesId }),
  )
  const signingInput = `${header}.${claims}`
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: config.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${base64url(signature)}`
}

/**
 * The Apple token fields of a delete request: null when it sent no token,
 * { token, tokenType } when it sent a usable one, and { invalid: true } when
 * the token or its type cannot be one. The type defaults to refresh_token.
 */
export function readAppleTokenFields({ appleToken, appleTokenType } = {}) {
  if (appleToken === undefined || appleToken === null || appleToken === '') return null
  const token = text(appleToken)
  if (!token || token.length > MAX_APPLE_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) return { invalid: true }
  const tokenType = appleTokenType === undefined || appleTokenType === null || appleTokenType === '' ? 'refresh_token' : appleTokenType
  if (!APPLE_TOKEN_TYPES.includes(tokenType)) return { invalid: true }
  return { token, tokenType }
}

function appleErrorOf(body) {
  try {
    const code = JSON.parse(body)?.error
    return typeof code === 'string' && APPLE_ERROR_CODE.test(code) ? code : null
  } catch {
    return null
  }
}

/**
 * The revoker server.mjs builds from the four settings. `configured` and
 * `problem` (null, or what is missing or wrong, for the boot log) say whether
 * it can call Apple. revoke({ token, tokenType }) resolves to { revoked: true }
 * once Apple answers 200, or to { revoked: false, reason } where reason is
 * not-configured, rejected (Apple answered an error: `status` and Apple's
 * `appleError` code are set), timeout, network or error.
 */
export function createAppleTokenRevoker(settings = {}, { fetchImpl = globalThis.fetch, timeoutMs = APPLE_REVOKE_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const read = readAppleRevokeConfig(settings)
  const config = read.config ?? null
  const problem = config ? null : read.error ?? `${read.missing.join(', ')} not set`

  async function revoke({ token, tokenType = 'refresh_token' } = {}) {
    if (!config) return { revoked: false, reason: 'not-configured' }
    if (typeof token !== 'string' || !token || !APPLE_TOKEN_TYPES.includes(tokenType)) return { revoked: false, reason: 'error' }
    try {
      const body = new URLSearchParams({
        client_id: config.servicesId,
        client_secret: createAppleClientSecret(config, { now: now() }),
        token,
        token_type_hint: tokenType,
      })
      const response = await fetchUpstream('Apple', APPLE_REVOKE_URL, {
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: body.toString(),
        },
        timeoutMs,
        fetchImpl,
      })
      // A 200 has no body; read it anyway so the connection is released.
      await response.text().catch(() => '')
      return { revoked: true }
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === 'status') {
        return { revoked: false, reason: 'rejected', status: err.status, appleError: appleErrorOf(err.body) }
      }
      if (err instanceof UpstreamError) return { revoked: false, reason: err.kind === 'timeout' ? 'timeout' : 'network' }
      return { revoked: false, reason: 'error' }
    }
  }

  return { configured: Boolean(config), problem, revoke }
}
