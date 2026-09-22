import test from 'node:test'
import assert from 'node:assert/strict'
import { scrubSentryEvent } from '../src/sentryScrub.mjs'

test('redacts email addresses anywhere in string values', () => {
  const event = scrubSentryEvent({
    message: 'login failed for student@purdue.edu today',
    exception: { values: [{ type: 'Error', value: 'no row for alice.smith+test@gmail.com' }] },
  })
  assert.equal(event.message, 'login failed for [email] today')
  assert.equal(event.exception.values[0].value, 'no row for [email]')
})

test('redacts token-like strings (JWTs, bearer tokens, long hex)', () => {
  const event = scrubSentryEvent({
    message:
      'auth: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123sig and key 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c',
  })
  assert.ok(!event.message.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT survived scrubbing')
  assert.ok(!event.message.includes('3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'), 'hex token survived scrubbing')
})

test('drops cookies, auth headers, and user fields entirely', () => {
  const event = scrubSentryEvent({
    request: {
      url: 'https://www.boilerindy.app/api/me/profile',
      headers: { cookie: 'pih.sid=secret', authorization: 'Bearer x', accept: 'application/json' },
      cookies: { 'pih.sid': 'secret' },
      data: '{"password":"hunter22"}',
    },
    user: { id: 'u1', email: 'student@purdue.edu', ip_address: '1.2.3.4' },
    breadcrumbs: [{ message: 'fetch /api/session for student@purdue.edu' }],
  })
  assert.equal(event.request.headers.cookie, undefined)
  assert.equal(event.request.headers.authorization, undefined)
  assert.equal(event.request.headers.accept, 'application/json')
  assert.equal(event.request.cookies, undefined)
  assert.equal(event.request.data, undefined)
  assert.equal(event.user, undefined)
  assert.equal(event.breadcrumbs[0].message, 'fetch /api/session for [email]')
})

test('redacts the calendar-feed token, UUIDs, and API keys in URLs', () => {
  const event = scrubSentryEvent({
    request: { url: 'https://www.boilerindy.app/feeds/calendar/2f1c9e7a-4b6d-4a1e-9c3f-8d2b7e5a1f04.ics' },
    breadcrumbs: [
      { data: { url: 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r' } },
      { message: 'transit ?apiKey=8882812681 fetched' },
      { message: 'xAI 429 for key xai-Ab3dEf9GhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd' },
    ],
  })
  assert.ok(!event.request.url.includes('2f1c9e7a-4b6d-4a1e-9c3f-8d2b7e5a1f04'), 'feed token survived scrubbing')
  assert.ok(event.request.url.includes('[redacted]'))
  assert.ok(!event.breadcrumbs[0].data.url.includes('AIzaSy'), 'Google key survived scrubbing')
  assert.ok(!event.breadcrumbs[1].message.includes('8882812681'), 'transit key survived scrubbing')
  assert.ok(!event.breadcrumbs[2].message.includes('xai-Ab3d'), 'xAI key survived scrubbing')
  assert.equal(event.breadcrumbs[2].message, 'xAI 429 for key [token]')
})

test('returns null/undefined unchanged and never throws on odd shapes', () => {
  assert.equal(scrubSentryEvent(null), null)
  assert.equal(scrubSentryEvent(undefined), undefined)
  const event = scrubSentryEvent({ extra: { depth: { deep: ['ok', 42, null] } } })
  assert.deepEqual(event.extra.depth.deep, ['ok', 42, null])
})

// ── Sentry's own identifiers must survive (2026-09-14) ─────────────────────
//
// event_id and trace_id are 32 hex chars, a git-SHA release is 40, and
// debug_meta carries sourcemap debug_id UUIDs: exactly the shapes the token
// rules redact. A redacted event_id makes the envelope invalid and Sentry
// answers 400, which is how production dropped every error for months.

test('leaves Sentry identifiers intact while still redacting tokens in content', () => {
  const event = {
    event_id: '0123456789abcdef0123456789abcdef',
    release: 'e00473544f025c470081538da500c0ce7d204645',
    dist: '1',
    timestamp: 1789000000.123,
    sdk: { name: 'sentry.javascript.react', version: '10.57.0' },
    contexts: { trace: { trace_id: 'abcdef0123456789abcdef0123456789', span_id: '0123456789abcdef', parent_span_id: 'fedcba9876543210' } },
    debug_meta: { images: [{ type: 'sourcemap', code_file: 'https://www.boilerindy.app/assets/CJ0gZUS2.js', debug_id: '3f9a8b7c-6d5e-4f3a-2b1c-0d9e8f7a6b5c' }] },
    message: 'token 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c and feed 8d0f5e1a-2b3c-4d5e-8f9a-0b1c2d3e4f5a for a@b.co',
    breadcrumbs: [{ category: 'fetch', data: { url: 'https://api.example/x?token=abc123', method: 'GET' } }],
  }
  const out = scrubSentryEvent(event)

  assert.equal(out.event_id, event.event_id)
  assert.equal(out.release, event.release)
  assert.equal(out.dist, '1')
  assert.equal(out.timestamp, event.timestamp)
  assert.deepEqual(out.sdk, event.sdk)
  assert.deepEqual(out.contexts.trace, event.contexts.trace)
  assert.deepEqual(out.debug_meta, event.debug_meta)

  // Content is still scrubbed.
  assert.equal(out.message, 'token [token] and feed [token] for [email]')
  assert.equal(out.breadcrumbs[0].data.url, 'https://api.example/x?token=[redacted]')
})

test('a hex-looking value under a content key is still redacted even when the key name matches nowhere', () => {
  const out = scrubSentryEvent({ event_id: 'ffffffffffffffffffffffffffffffff', extra: { session: 'ffffffffffffffffffffffffffffffff' } })
  assert.equal(out.event_id, 'ffffffffffffffffffffffffffffffff')
  assert.equal(out.extra.session, '[token]')
})

test('redacts Groq API keys (gsk_ prefix)', () => {
  const out = scrubSentryEvent({ message: 'boot with gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP set' })
  assert.equal(out.message, 'boot with [token] set')
})

test('redacts the row value in a PostgREST unique-violation detail (issue #206)', () => {
  const event = scrubSentryEvent({
    extra: {
      pgError: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "users_purdue_username_key"',
        details: 'Key (purdue_username)=(jdoe) already exists.',
        hint: null,
      },
    },
  })
  assert.equal(event.extra.pgError.details, '[redacted]')
  // The constraint name is schema, not a student, so the message survives.
  assert.match(event.extra.pgError.message, /users_purdue_username_key/)
  assert.equal(event.extra.pgError.code, '23505')
})

test('redacts the row value when the detail rides inside an exception message', () => {
  const event = scrubSentryEvent({
    exception: {
      values: [
        {
          type: 'PostgrestError',
          value: 'insert failed: Key (email)=(jdoe@purdue.edu) already exists.',
        },
      ],
    },
  })
  const { value } = event.exception.values[0]
  assert.ok(!value.includes('jdoe@purdue.edu'), 'row value survived scrubbing')
  assert.ok(!value.includes('jdoe'), 'local part survived scrubbing')
  // The column name stays: it says which constraint fired without naming anyone.
  assert.match(value, /Key \(email\)=\(\[redacted\]\)/)
})

test('keeps a hint that is not quoting a row', () => {
  const event = scrubSentryEvent({
    extra: { pgError: { hint: 'Perhaps you meant the column "users.display_name".' } },
  })
  assert.equal(event.extra.pgError.hint, 'Perhaps you meant the column "users.display_name".')
})
