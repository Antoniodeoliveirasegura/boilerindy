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

test('returns null/undefined unchanged and never throws on odd shapes', () => {
  assert.equal(scrubSentryEvent(null), null)
  assert.equal(scrubSentryEvent(undefined), undefined)
  const event = scrubSentryEvent({ extra: { depth: { deep: ['ok', 42, null] } } })
  assert.deepEqual(event.extra.depth.deep, ['ok', 42, null])
})
