import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  base64UrlDecode,
  base64UrlEncode,
  createVapidAuthorization,
  decryptPayload,
  encryptPayload,
  generateVapidKeys,
  isValidSubscription,
  loadVapidKeys,
  normalizeTopic,
  sendWebPush,
  verifyVapidToken,
} from '../src/webPush.mjs'

// RFC 8291 Appendix A: the one published end-to-end vector for aes128gcm Web
// Push. Pinning the sender key and salt makes encryptPayload deterministic, so
// a byte-exact match proves the HKDF/AES layout matches what browsers decrypt.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  output:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('encryptPayload reproduces the RFC 8291 test vector byte for byte', () => {
  const body = encryptPayload(
    RFC.plaintext,
    { p256dh: RFC.receiverPublic, auth: RFC.auth },
    { salt: base64UrlDecode(RFC.salt), senderPrivateKey: base64UrlDecode(RFC.senderPrivate) },
  )
  assert.equal(base64UrlEncode(body), RFC.output)
  // Header layout: salt(16) | rs=4096 | idlen=65 | sender public key.
  assert.equal(body.readUInt32BE(16), 4096)
  assert.equal(body[20], 65)
  assert.equal(base64UrlEncode(body.subarray(21, 86)), RFC.senderPublic)
})

test('decryptPayload reverses encryptPayload with a fresh sender key and salt', () => {
  const receiver = generateVapidKeys() // any P-256 pair works as a browser key
  const auth = base64UrlEncode(Buffer.from('0123456789abcdef'))
  const message = JSON.stringify({ title: 'Due soon', body: 'CS 180 homework 3', url: '/assignments' })
  const body = encryptPayload(message, { p256dh: receiver.publicKey, auth })
  const opened = decryptPayload(body, { receiverPrivateKey: base64UrlDecode(receiver.privateKey), auth })
  assert.equal(opened.toString('utf8'), message)
  // Randomised: two encryptions of the same message differ.
  const again = encryptPayload(message, { p256dh: receiver.publicKey, auth })
  assert.notEqual(base64UrlEncode(again), base64UrlEncode(body))
})

test('encryptPayload rejects malformed subscription keys and oversized payloads', () => {
  const auth = base64UrlEncode(Buffer.alloc(16, 1))
  assert.throws(() => encryptPayload('x', { p256dh: 'AAAA', auth }), /p256dh/)
  assert.throws(() => encryptPayload('x', { p256dh: RFC.receiverPublic, auth: 'AAAA' }), /auth secret/)
  assert.throws(() => encryptPayload('x'.repeat(5000), { p256dh: RFC.receiverPublic, auth }), /exceeds/)
})

test('generateVapidKeys and loadVapidKeys round-trip, and mismatches are rejected', () => {
  const pair = generateVapidKeys()
  assert.equal(base64UrlDecode(pair.publicKey).length, 65)
  assert.equal(base64UrlDecode(pair.privateKey).length, 32)

  const keys = loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey })
  assert.equal(keys.publicKey, pair.publicKey)
  assert.equal(keys.subject, 'mailto:support@boilerindy.app')

  assert.equal(loadVapidKeys({}), null)
  assert.throws(() => loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey }), /set together/)
  const other = generateVapidKeys()
  assert.throws(
    () => loadVapidKeys({ VAPID_PUBLIC_KEY: other.publicKey, VAPID_PRIVATE_KEY: pair.privateKey }),
    /does not match/,
  )
  assert.throws(
    () => loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: 'support@x' }),
    /VAPID_SUBJECT/,
  )
})

test('private scalars with a leading zero byte are padded to 32 bytes and accepted either way', () => {
  // 0x00 0x01 0x01 ... is a valid scalar whose minimal encoding is 31 bytes.
  const short = Buffer.alloc(31, 1)
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(1), short]))
  const publicKey = base64UrlEncode(ecdh.getPublicKey())
  const fromShort = loadVapidKeys({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: base64UrlEncode(short) })
  const fromPadded = loadVapidKeys({
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: base64UrlEncode(Buffer.concat([Buffer.alloc(1), short])),
  })
  assert.equal(fromShort.privateKeyBytes.length, 32)
  assert.equal(fromShort.privateKey, fromPadded.privateKey)
  for (let i = 0; i < 40; i += 1) {
    const pair = generateVapidKeys()
    assert.equal(base64UrlDecode(pair.privateKey).length, 32)
  }
  assert.throws(() => loadVapidKeys({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: base64UrlEncode(Buffer.alloc(33, 1)) }), /32-byte/)
})

test('createVapidAuthorization signs a verifiable ES256 token scoped to the endpoint origin', () => {
  const pair = generateVapidKeys()
  const keys = loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: 'mailto:ops@example.edu' })
  const now = Date.parse('2026-09-06T12:00:00Z')
  const { authorization, token, aud, exp } = createVapidAuthorization({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys,
    now,
  })
  assert.equal(aud, 'https://fcm.googleapis.com')
  assert.equal(exp, Math.floor(now / 1000) + 12 * 60 * 60)
  assert.equal(authorization, `vapid t=${token}, k=${pair.publicKey}`)

  const decoded = verifyVapidToken(token, keys)
  assert.deepEqual(decoded.header, { typ: 'JWT', alg: 'ES256' })
  assert.deepEqual(decoded.claims, { aud, exp, sub: 'mailto:ops@example.edu' })
  // Raw r||s signature, not DER.
  assert.equal(base64UrlDecode(token.split('.')[2]).length, 64)
  // A different key pair does not verify it.
  const stranger = generateVapidKeys()
  const strangerKeys = loadVapidKeys({ VAPID_PUBLIC_KEY: stranger.publicKey, VAPID_PRIVATE_KEY: stranger.privateKey })
  assert.equal(verifyVapidToken(token, strangerKeys), null)
})

test('isValidSubscription and normalizeTopic guard the wire format', () => {
  const good = { endpoint: 'https://push.example/abc', keys: { p256dh: RFC.receiverPublic, auth: RFC.auth } }
  assert.equal(isValidSubscription(good), true)
  assert.equal(isValidSubscription({ ...good, endpoint: 'http://push.example/abc' }), false)
  assert.equal(isValidSubscription({ ...good, keys: { p256dh: 'nope', auth: RFC.auth } }), false)
  assert.equal(isValidSubscription(null), false)
  assert.equal(normalizeTopic('deadline:calendar/123!'), 'deadlinecalendar123')
  assert.equal(normalizeTopic('x'.repeat(50)).length, 32)
  assert.equal(normalizeTopic(''), null)
})

function fakeFetch(status, text = '') {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return { status, text: async () => text }
  }
  return { impl, calls }
}

test('sendWebPush posts an encrypted body with VAPID headers and classifies responses', async () => {
  const pair = generateVapidKeys()
  const keys = loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey })
  const receiver = generateVapidKeys()
  const auth = base64UrlEncode(Buffer.alloc(16, 7))
  const subscription = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz', keys: { p256dh: receiver.publicKey, auth } }
  const payload = { title: 'Hello', body: 'World', url: '/settings', tag: 'test', kind: 'test' }

  const ok = fakeFetch(201)
  const result = await sendWebPush({ subscription, payload, keys, fetchImpl: ok.impl, topic: 'test' })
  assert.deepEqual(result, { ok: true, status: 201, gone: false, retry: false })
  const [{ url, init }] = ok.calls
  assert.equal(url, subscription.endpoint)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm')
  assert.equal(init.headers['Content-Type'], 'application/octet-stream')
  assert.equal(init.headers.TTL, '86400')
  assert.equal(init.headers.Urgency, 'normal')
  assert.equal(init.headers.Topic, 'test')
  assert.match(init.headers.Authorization, /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=/)
  const opened = decryptPayload(init.body, { receiverPrivateKey: base64UrlDecode(receiver.privateKey), auth })
  assert.deepEqual(JSON.parse(opened.toString('utf8')), payload)

  const gone = fakeFetch(410, 'gone')
  assert.deepEqual(await sendWebPush({ subscription, payload, keys, fetchImpl: gone.impl }), {
    ok: false, status: 410, gone: true, retry: false, error: 'gone',
  })
  const throttled = fakeFetch(429)
  assert.equal((await sendWebPush({ subscription, payload, keys, fetchImpl: throttled.impl })).retry, true)
  const rejected = fakeFetch(403, 'bad vapid')
  const r = await sendWebPush({ subscription, payload, keys, fetchImpl: rejected.impl })
  assert.equal(r.ok, false)
  assert.equal(r.gone, false)
  assert.equal(r.retry, false)

  const network = await sendWebPush({ subscription, payload, keys, fetchImpl: async () => { throw new Error('ECONNRESET') } })
  assert.deepEqual(network, { ok: false, status: 0, gone: false, retry: true, error: 'ECONNRESET' })

  const invalid = await sendWebPush({ subscription: { endpoint: 'https://x', keys: {} }, payload, keys, fetchImpl: ok.impl })
  assert.equal(invalid.gone, true)
  const unconfigured = await sendWebPush({ subscription, payload, keys: null, fetchImpl: ok.impl })
  assert.equal(unconfigured.ok, false)
})
