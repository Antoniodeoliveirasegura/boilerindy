import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  APPLE_AUDIENCE,
  APPLE_REVOKE_URL,
  CLIENT_SECRET_LIFETIME_SECONDS,
  MAX_APPLE_TOKEN_LENGTH,
  createAppleClientSecret,
  createAppleTokenRevoker,
  readAppleRevokeConfig,
  readAppleTokenFields,
} from '../src/appleTokenRevoke.mjs'

// Sign in with Apple token revocation on account deletion: the settings, the
// ES256 client secret Apple's REST API wants, the request fields and the
// revoke call. The key is a throwaway P-256 pair made in memory for this run;
// no Apple credential is involved anywhere.

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const SETTINGS = { teamId: 'TEAM123456', keyId: 'KEYID12345', privateKey: PEM, servicesId: 'com.example.app.web' }
const REFRESH_TOKEN = 'r0a1b2c3d4e5f6.0.abcd.refresh-token-from-the-confirmation'
const NOW = Date.parse('2026-10-24T12:00:00Z')

const decode = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
function verifiedClaims(jwt) {
  const [header, claims, signature] = jwt.split('.')
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${header}.${claims}`, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  )
  assert.ok(ok, 'the client secret verifies with the public half of the key')
  return { header: decode(header), claims: decode(claims) }
}

// A fetch that records each request and answers with `reply`.
function recordingFetch(reply = { status: 200, body: '' }) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(init.body) })
    const { status, body } = typeof reply === 'function' ? reply() : reply
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return { calls, fetchImpl }
}

test('the settings: all four blank or some blank name what is missing, never a value', () => {
  assert.deepEqual(readAppleRevokeConfig({}), {
    missing: ['APPLE_TEAM_ID', 'APPLE_SIGN_IN_KEY_ID', 'APPLE_SIGN_IN_PRIVATE_KEY', 'APPLE_SIGN_IN_SERVICES_ID'],
  })
  assert.deepEqual(readAppleRevokeConfig({ ...SETTINGS, keyId: '  ', servicesId: undefined }), {
    missing: ['APPLE_SIGN_IN_KEY_ID', 'APPLE_SIGN_IN_SERVICES_ID'],
  })
})

test('the settings: a wrong-looking Team ID, Key ID, Services ID or key is an error that names the setting', () => {
  const cases = [
    [{ teamId: 'team' }, 'APPLE_TEAM_ID'],
    [{ keyId: 'AuthKey_KEYID12345.p8' }, 'APPLE_SIGN_IN_KEY_ID'],
    [{ servicesId: 'TEAM123456.com.example.app.web' }, 'APPLE_SIGN_IN_SERVICES_ID'],
    [{ servicesId: 'https://example.com' }, 'APPLE_SIGN_IN_SERVICES_ID'],
    [{ privateKey: 'not a key at all' }, 'APPLE_SIGN_IN_PRIVATE_KEY'],
  ]
  for (const [override, name] of cases) {
    const read = readAppleRevokeConfig({ ...SETTINGS, ...override })
    assert.equal(read.config, undefined)
    assert.ok(read.error.startsWith(name), read.error)
    assert.ok(!read.error.includes(Object.values(override)[0]), 'the value itself is not echoed')
  }
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  assert.match(readAppleRevokeConfig({ ...SETTINGS, privateKey: rsa }).error, /^APPLE_SIGN_IN_PRIVATE_KEY is not a P-256 key/)
})

test('the settings: the .p8 contents load as pasted, or on one line with literal \\n', () => {
  const read = readAppleRevokeConfig(SETTINGS)
  assert.equal(read.config.teamId, 'TEAM123456')
  assert.equal(read.config.keyId, 'KEYID12345')
  assert.equal(read.config.servicesId, 'com.example.app.web')
  assert.equal(read.config.privateKey.asymmetricKeyType, 'ec')
  const oneLine = PEM.trim().replace(/\n/g, '\\n')
  assert.ok(!oneLine.includes('\n'))
  assert.ok(readAppleRevokeConfig({ ...SETTINGS, privateKey: oneLine }).config)
})

test('the client secret is an ES256 JWT with the claims Apple lists, signed by the key, for five minutes', () => {
  const { config } = readAppleRevokeConfig(SETTINGS)
  const { header, claims } = verifiedClaims(createAppleClientSecret(config, { now: NOW }))
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEYID12345' })
  const iat = NOW / 1000
  assert.deepEqual(claims, {
    iss: 'TEAM123456',
    iat,
    exp: iat + CLIENT_SECRET_LIFETIME_SECONDS,
    aud: APPLE_AUDIENCE,
    sub: 'com.example.app.web',
  })
  assert.equal(CLIENT_SECRET_LIFETIME_SECONDS, 300)
  assert.equal(APPLE_AUDIENCE, 'https://appleid.apple.com')
})

test('the request fields: no token is null, a usable one defaults to refresh_token, anything else is invalid', () => {
  for (const appleToken of [undefined, null, '']) assert.equal(readAppleTokenFields({ appleToken }), null)
  assert.equal(readAppleTokenFields(), null)
  assert.deepEqual(readAppleTokenFields({ appleToken: REFRESH_TOKEN }), { token: REFRESH_TOKEN, tokenType: 'refresh_token' })
  assert.deepEqual(readAppleTokenFields({ appleToken: ` ${REFRESH_TOKEN} `, appleTokenType: 'access_token' }), {
    token: REFRESH_TOKEN,
    tokenType: 'access_token',
  })
  for (const fields of [
    { appleToken: 42 },
    { appleToken: { token: REFRESH_TOKEN } },
    { appleToken: '   ' },
    { appleToken: 'two words' },
    { appleToken: 'x'.repeat(MAX_APPLE_TOKEN_LENGTH + 1) },
    { appleToken: REFRESH_TOKEN, appleTokenType: 'id_token' },
    { appleToken: REFRESH_TOKEN, appleTokenType: ['refresh_token'] },
  ]) {
    assert.deepEqual(readAppleTokenFields(fields), { invalid: true }, JSON.stringify(fields).slice(0, 80))
  }
})

test('unconfigured: the revoker says what is missing and never calls Apple', async () => {
  const { calls, fetchImpl } = recordingFetch()
  const revoker = createAppleTokenRevoker({}, { fetchImpl })
  assert.equal(revoker.configured, false)
  assert.equal(
    revoker.problem,
    'APPLE_TEAM_ID, APPLE_SIGN_IN_KEY_ID, APPLE_SIGN_IN_PRIVATE_KEY, APPLE_SIGN_IN_SERVICES_ID not set',
  )
  assert.deepEqual(await revoker.revoke({ token: REFRESH_TOKEN, tokenType: 'refresh_token' }), { revoked: false, reason: 'not-configured' })
  const wrongKey = createAppleTokenRevoker({ ...SETTINGS, privateKey: 'nope' }, { fetchImpl })
  assert.equal(wrongKey.configured, false)
  assert.match(wrongKey.problem, /^APPLE_SIGN_IN_PRIVATE_KEY is not a PEM private key/)
  assert.deepEqual(await wrongKey.revoke({ token: REFRESH_TOKEN }), { revoked: false, reason: 'not-configured' })
  assert.equal(calls.length, 0)
})

test('configured: one form POST to /auth/revoke with the Services ID, a fresh client secret and the token', async () => {
  const { calls, fetchImpl } = recordingFetch({ status: 200, body: '' })
  const revoker = createAppleTokenRevoker(SETTINGS, { fetchImpl, now: () => NOW })
  assert.equal(revoker.configured, true)
  assert.equal(revoker.problem, null)
  assert.deepEqual(await revoker.revoke({ token: REFRESH_TOKEN, tokenType: 'refresh_token' }), { revoked: true })
  assert.equal(calls.length, 1)
  const [{ url, init, form }] = calls
  assert.equal(url, APPLE_REVOKE_URL)
  assert.equal(APPLE_REVOKE_URL, 'https://appleid.apple.com/auth/revoke')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.ok(init.signal instanceof AbortSignal, 'the call has a deadline')
  assert.deepEqual([...form.keys()], ['client_id', 'client_secret', 'token', 'token_type_hint'])
  assert.equal(form.get('client_id'), 'com.example.app.web')
  assert.equal(form.get('token'), REFRESH_TOKEN)
  assert.equal(form.get('token_type_hint'), 'refresh_token')
  assert.equal(verifiedClaims(form.get('client_secret')).claims.sub, 'com.example.app.web')

  await revoker.revoke({ token: 'an-access-token', tokenType: 'access_token' })
  assert.equal(calls[1].form.get('token_type_hint'), 'access_token')
})

test('Apple refusing is reported with its status and error code, and nothing secret comes back', async () => {
  const { fetchImpl } = recordingFetch({ status: 400, body: '{"error":"invalid_client"}' })
  const outcome = await createAppleTokenRevoker(SETTINGS, { fetchImpl }).revoke({ token: REFRESH_TOKEN, tokenType: 'refresh_token' })
  assert.deepEqual(outcome, { revoked: false, reason: 'rejected', status: 400, appleError: 'invalid_client' })
  assert.ok(!JSON.stringify(outcome).includes(REFRESH_TOKEN))

  const html = recordingFetch({ status: 503, body: '<html>maintenance</html>' })
  assert.deepEqual(await createAppleTokenRevoker(SETTINGS, { fetchImpl: html.fetchImpl }).revoke({ token: REFRESH_TOKEN }), {
    revoked: false,
    reason: 'rejected',
    status: 503,
    appleError: null,
  })
})

test('a stalled Apple is abandoned at the deadline, and a failed connection is network', async () => {
  // Never answers but honours the abort signal, like real fetch.
  const stalled = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
  // AbortSignal.timeout's timer is unref'd and this fake holds no socket, so
  // keep the event loop alive until the deadline fires.
  const keepAlive = setTimeout(() => {}, 5000)
  const started = Date.now()
  try {
    const outcome = await createAppleTokenRevoker(SETTINGS, { fetchImpl: stalled, timeoutMs: 30 }).revoke({ token: REFRESH_TOKEN })
    assert.deepEqual(outcome, { revoked: false, reason: 'timeout' })
    assert.ok(Date.now() - started < 2000)
  } finally {
    clearTimeout(keepAlive)
  }
  const refused = async () => {
    throw new TypeError('fetch failed')
  }
  assert.deepEqual(await createAppleTokenRevoker(SETTINGS, { fetchImpl: refused }).revoke({ token: REFRESH_TOKEN }), {
    revoked: false,
    reason: 'network',
  })
})

test('a call without a usable token or type never reaches Apple', async () => {
  const { calls, fetchImpl } = recordingFetch()
  const revoker = createAppleTokenRevoker(SETTINGS, { fetchImpl })
  assert.deepEqual(await revoker.revoke(), { revoked: false, reason: 'error' })
  assert.deepEqual(await revoker.revoke({ token: REFRESH_TOKEN, tokenType: 'id_token' }), { revoked: false, reason: 'error' })
  assert.equal(calls.length, 0)
})
