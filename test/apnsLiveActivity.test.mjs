import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http2 from 'node:http2'

import {
  APNS_ORIGINS,
  APNS_TOPIC,
  MAX_PAYLOAD_BYTES,
  PROVIDER_TOKEN_LIFETIME_MS,
  createApnsSender,
  createProviderToken,
  liveActivityPayload,
  loadApnsConfig,
  normalizeApnsToken,
  verifyProviderToken,
} from '../src/apnsLiveActivity.mjs'

// Issue #550, "Later": the APNs sender for Track this bus. Every request goes
// to a local HTTP/2 server standing in for Apple's hosts, which records what
// it was sent and answers as the test says; nothing reaches APNs. The key is
// a fresh P-256 pair in the .p8 file's form (PKCS #8 PEM), so the provider
// token's signature can be checked with its public half.

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' })
const ENV = { APNS_KEY_P8: P8, APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456' }
const TOKEN = 'a1'.repeat(32)
const PAYLOAD = liveActivityPayload({ event: 'update', contentState: { phase: 'due' }, now: Date.parse('2026-11-04T15:00:00Z') })

// An HTTP/2 server in place of APNs: answer(request, n) gives the status and
// APNs' reason for the nth request.
async function apnsStub(answer = () => ({ status: 200 })) {
  const requests = []
  const open = new Set()
  let sessions = 0
  const server = http2.createServer()
  server.on('session', (session) => {
    sessions += 1
    open.add(session)
    session.on('close', () => open.delete(session))
  })
  server.on('stream', (stream, headers) => {
    const chunks = []
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      requests.push({ headers, body: chunks.join('') })
      const { status = 200, reason = null } = answer(requests.at(-1), requests.length) ?? {}
      stream.respond({ ':status': status })
      stream.end(reason ? JSON.stringify({ reason }) : undefined)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    sessions: () => sessions,
    async close() {
      for (const session of open) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function withSender({ answer, now } = {}, run) {
  const stub = await apnsStub(answer)
  const config = loadApnsConfig(ENV)
  const sender = createApnsSender({ config, origins: { production: stub.origin, development: stub.origin }, now })
  try {
    await run({ sender, stub })
  } finally {
    sender.close()
    await stub.close()
  }
}

// ── The key ─────────────────────────────────────────────────────────────────

test('loadApnsConfig reads the three variables, with the .p8 pasted as it is, with \\n, or as its base64 body', () => {
  assert.equal(loadApnsConfig({}), null)
  for (const pem of [P8, P8.trim().replace(/\n/g, '\\n'), P8.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')]) {
    const config = loadApnsConfig({ ...ENV, APNS_KEY_P8: pem })
    assert.equal(config.keyId, 'ABC123DEFG')
    assert.equal(config.teamId, 'TEAM123456')
    assert.equal(config.privateKey.asymmetricKeyType, 'ec')
  }
})

test('loadApnsConfig refuses a partial set, a malformed id and a key that is not a P-256 auth key, never naming the key', () => {
  const refusals = [
    [{ APNS_KEY_P8: P8 }, /must be set together/],
    [{ ...ENV, APNS_TEAM_ID: '' }, /must be set together/],
    [{ ...ENV, APNS_KEY_ID: 'abc123defg' }, /APNS_KEY_ID/],
    [{ ...ENV, APNS_TEAM_ID: 'TEAM12' }, /APNS_TEAM_ID/],
    [{ ...ENV, APNS_KEY_P8: 'not a key' }, /not a readable \.p8 key/],
    [{ ...ENV, APNS_KEY_P8: crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }, /P-256/],
    [{ ...ENV, APNS_KEY_P8: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) }, /P-256/],
  ]
  const body = P8.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  for (const [env, message] of refusals) {
    assert.throws(
      () => loadApnsConfig(env),
      (error) => message.test(error.message) && !error.message.includes(body.slice(0, 24)),
    )
  }
})

test('the provider token is an ES256 JWT naming the key and the team, signed by the .p8 key', () => {
  const now = Date.parse('2026-11-04T15:00:00Z')
  const token = createProviderToken({ ...loadApnsConfig(ENV), now })
  const verified = verifyProviderToken(token, publicKey)
  assert.deepEqual(verified, { header: { alg: 'ES256', kid: 'ABC123DEFG' }, claims: { iss: 'TEAM123456', iat: now / 1000 } })
  // A raw r||s signature, 64 bytes, as JWS has it.
  assert.equal(Buffer.from(token.split('.')[2], 'base64url').length, 64)
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
  assert.equal(verifyProviderToken(token, other), null)
})

test('a push token is the lowercase hex of its bytes; anything else is not one', () => {
  assert.equal(normalizeApnsToken(` ${'AB'.repeat(32)} `), 'ab'.repeat(32))
  for (const bad of [null, '', 'ab', 'xy'.repeat(32), 'abc'.repeat(21), 'ab'.repeat(300), 42]) assert.equal(normalizeApnsToken(bad), null)
})

test('the payload is aps with the event, the content state and the dates in Unix seconds', () => {
  const now = Date.parse('2026-11-04T15:00:00.900Z')
  assert.deepEqual(
    liveActivityPayload({ event: 'update', contentState: { phase: 'arriving' }, now, staleAt: now + 180_000, alert: { title: 'T', body: 'B', sound: 'default' } }),
    { aps: { timestamp: 1793804400, event: 'update', 'content-state': { phase: 'arriving' }, 'stale-date': 1793804580, alert: { title: 'T', body: 'B', sound: 'default' } } },
  )
  assert.deepEqual(liveActivityPayload({ event: 'end', contentState: { phase: 'arrived' }, now, dismissAt: now + 120_000 }), {
    aps: { timestamp: 1793804400, event: 'end', 'content-state': { phase: 'arrived' }, 'dismissal-date': 1793804520 },
  })
})

// ── Sending ─────────────────────────────────────────────────────────────────

test('a push goes to /3/device/<token> as a liveactivity push for the app, with the priority, the expiration and the JSON body', async () => {
  await withSender({}, async ({ sender, stub }) => {
    const result = await sender.send({ token: TOKEN.toUpperCase(), env: 'production', payload: PAYLOAD, priority: 10, expiration: 1793804460 })
    assert.deepEqual(result, { ok: true, status: 200 })
    const [request] = stub.requests
    assert.equal(request.headers[':method'], 'POST')
    assert.equal(request.headers[':path'], `/3/device/${TOKEN}`)
    assert.equal(request.headers['apns-push-type'], 'liveactivity')
    assert.equal(request.headers['apns-topic'], APNS_TOPIC)
    assert.equal(APNS_TOPIC.endsWith('.push-type.liveactivity'), true)
    assert.equal(request.headers['apns-priority'], '10')
    assert.equal(request.headers['apns-expiration'], '1793804460')
    assert.equal(request.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(request.body), PAYLOAD)
    const [scheme, jwt] = request.headers.authorization.split(' ')
    assert.equal(scheme, 'bearer')
    assert.equal(verifyProviderToken(jwt, publicKey).claims.iss, 'TEAM123456')
  })
})

test('every push rides one HTTP/2 session, and the provider token is kept 50 minutes, then renewed', async () => {
  let clock = Date.parse('2026-11-04T15:00:00Z')
  await withSender({ now: () => clock }, async ({ sender, stub }) => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await sender.send({ token: TOKEN, env: 'production', payload: PAYLOAD })).ok, true)
      clock += 20 * 60 * 1000
    }
    // 0, 20 and 40 minutes: one token; at 60 minutes, a new one.
    assert.equal((await sender.send({ token: TOKEN, env: 'production', payload: PAYLOAD })).ok, true)
    const iats = stub.requests.map((r) => verifyProviderToken(r.headers.authorization.slice('bearer '.length), publicKey).claims.iat)
    assert.deepEqual(new Set(iats.slice(0, 3)).size, 1)
    assert.equal(iats[3] - iats[0], (60 * 60 * 1000) / 1000)
    assert.ok(PROVIDER_TOKEN_LIFETIME_MS < 60 * 60 * 1000 && PROVIDER_TOKEN_LIFETIME_MS > 20 * 60 * 1000)
    assert.equal(stub.sessions(), 1)
  })
})

test('each environment has its own host', async () => {
  assert.deepEqual(APNS_ORIGINS, { production: 'https://api.push.apple.com', development: 'https://api.sandbox.push.apple.com' })
  const production = await apnsStub()
  const development = await apnsStub()
  const sender = createApnsSender({ config: loadApnsConfig(ENV), origins: { production: production.origin, development: development.origin } })
  try {
    assert.equal((await sender.send({ token: TOKEN, env: 'development', payload: PAYLOAD })).ok, true)
    assert.equal((await sender.send({ token: TOKEN, env: 'production', payload: PAYLOAD })).ok, true)
    assert.deepEqual([production.requests.length, development.requests.length], [1, 1])
    assert.equal((await sender.send({ token: TOKEN, env: 'staging', payload: PAYLOAD })).ok, false)
  } finally {
    sender.close()
    await production.close()
    await development.close()
  }
})

test("APNs' answers: 410 and a bad token are gone, 429 and 5xx are retried later, other refusals are neither", async () => {
  const answers = [
    [{ status: 410, reason: 'Unregistered' }, { ok: false, status: 410, reason: 'Unregistered', gone: true, retry: false }],
    [{ status: 410, reason: 'ExpiredToken' }, { ok: false, status: 410, reason: 'ExpiredToken', gone: true, retry: false }],
    [{ status: 400, reason: 'BadDeviceToken' }, { ok: false, status: 400, reason: 'BadDeviceToken', gone: true, retry: false }],
    [{ status: 400, reason: 'DeviceTokenNotForTopic' }, { ok: false, status: 400, reason: 'DeviceTokenNotForTopic', gone: true, retry: false }],
    [{ status: 400, reason: 'BadExpirationDate' }, { ok: false, status: 400, reason: 'BadExpirationDate', gone: false, retry: false }],
    [{ status: 403, reason: 'InvalidProviderToken' }, { ok: false, status: 403, reason: 'InvalidProviderToken', gone: false, retry: false }],
    [{ status: 429, reason: 'TooManyRequests' }, { ok: false, status: 429, reason: 'TooManyRequests', gone: false, retry: true }],
    [{ status: 503, reason: 'ServiceUnavailable' }, { ok: false, status: 503, reason: 'ServiceUnavailable', gone: false, retry: true }],
    [{ status: 500 }, { ok: false, status: 500, reason: 'http_500', gone: false, retry: true }],
  ]
  for (const [answer, expected] of answers) {
    await withSender({ answer: () => answer }, async ({ sender }) => {
      assert.deepEqual(await sender.send({ token: TOKEN, env: 'production', payload: PAYLOAD }), expected)
    })
  }
})

test('an expired provider token is renewed and the push sent once more; a second refusal is the answer', async () => {
  // A clock a second further on at each look, so a renewed token has its own iat.
  let clock = Date.parse('2026-11-04T15:00:00Z')
  const now = () => (clock += 1000)
  await withSender({ now, answer: (_request, n) => (n === 1 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 }) }, async ({ sender, stub }) => {
    assert.deepEqual(await sender.send({ token: TOKEN, env: 'production', payload: PAYLOAD }), { ok: true, status: 200 })
    assert.equal(stub.requests.length, 2)
    const [first, second] = stub.requests.map((r) => verifyProviderToken(r.headers.authorization.slice('bearer '.length), publicKey).claims.iat)
    assert.ok(second > first, 'the push went again with a new token')
  })
  await withSender({ answer: () => ({ status: 403, reason: 'ExpiredProviderToken' }) }, async ({ sender, stub }) => {
    const result = await sender.send({ token: TOKEN, env: 'production', payload: PAYLOAD })
    assert.deepEqual(result, { ok: false, status: 403, reason: 'ExpiredProviderToken', gone: false, retry: false })
    assert.equal(stub.requests.length, 2, 'renewed once, not in a loop')
  })
})

test('a host that cannot be reached is a retry, without throwing, and the next push opens a new session', async () => {
  const stub = await apnsStub()
  const origin = stub.origin
  await stub.close()
  const sender = createApnsSender({ config: loadApnsConfig(ENV), origins: { production: origin, development: origin }, timeoutMs: 2000 })
  try {
    const result = await sender.send({ token: TOKEN, env: 'production', payload: PAYLOAD })
    assert.equal(result.ok, false)
    assert.equal(result.status, 0)
    assert.equal(result.retry, true)
    assert.equal(result.gone, false)
  } finally {
    sender.close()
  }
  // A session that dies is forgotten: a live stub answers the next push.
  const live = await apnsStub()
  let calls = 0
  const flaky = createApnsSender({
    config: loadApnsConfig(ENV),
    origins: { production: live.origin, development: live.origin },
    connect: (url) => {
      calls += 1
      return http2.connect(calls === 1 ? origin : url)
    },
  })
  try {
    assert.equal((await flaky.send({ token: TOKEN, env: 'production', payload: PAYLOAD })).retry, true)
    assert.equal((await flaky.send({ token: TOKEN, env: 'production', payload: PAYLOAD })).ok, true)
    assert.equal(calls, 2)
  } finally {
    flaky.close()
    await live.close()
  }
})

test('a stalled answer times out as a retry', async () => {
  const server = http2.createServer()
  const open = new Set()
  server.on('session', (session) => open.add(session))
  server.on('stream', () => {}) // never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const sender = createApnsSender({ config: loadApnsConfig(ENV), origins: { production: origin, development: origin }, timeoutMs: 200 })
  try {
    assert.deepEqual(await sender.send({ token: TOKEN, env: 'production', payload: PAYLOAD }), { ok: false, status: 0, reason: 'timeout', gone: false, retry: true })
  } finally {
    sender.close()
    for (const session of open) session.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a token that is not hex and a payload over 4 KB are refused before any request', async () => {
  await withSender({}, async ({ sender, stub }) => {
    assert.deepEqual(await sender.send({ token: 'not-a-token', env: 'production', payload: PAYLOAD }), {
      ok: false,
      status: 400,
      reason: 'BadDeviceToken',
      gone: true,
      retry: false,
    })
    const big = liveActivityPayload({ event: 'update', contentState: { phase: 'due', note: 'x'.repeat(MAX_PAYLOAD_BYTES) }, now: 0 })
    assert.deepEqual(await sender.send({ token: TOKEN, env: 'production', payload: big }), { ok: false, status: 413, reason: 'PayloadTooLarge', gone: false, retry: false })
    assert.equal(stub.requests.length, 0)
  })
})
