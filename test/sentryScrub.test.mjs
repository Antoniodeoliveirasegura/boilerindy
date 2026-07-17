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
    ],
  })
  assert.ok(!event.request.url.includes('2f1c9e7a-4b6d-4a1e-9c3f-8d2b7e5a1f04'), 'feed token survived scrubbing')
  assert.ok(event.request.url.includes('[redacted]'))
  assert.ok(!event.breadcrumbs[0].data.url.includes('AIzaSy'), 'Gemini key survived scrubbing')
  assert.ok(!event.breadcrumbs[1].message.includes('8882812681'), 'transit key survived scrubbing')
})

test('returns null/undefined unchanged and never throws on odd shapes', () => {
  assert.equal(scrubSentryEvent(null), null)
  assert.equal(scrubSentryEvent(undefined), undefined)
  const event = scrubSentryEvent({ extra: { depth: { deep: ['ok', 42, null] } } })
  assert.deepEqual(event.extra.depth.deep, ['ok', 42, null])
})
