import test from 'node:test'
import assert from 'node:assert/strict'
import { jwtSubject, sessionSyncBucketKey } from '../src/sessionSyncKey.mjs'

// Issue #217: the session-sync limiter keys by the Supabase user carried in the
// request instead of the client IP.

function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`
}

const SUB = '2f6b7a1e-9c4d-4e8f-8a1b-3c5d7e9f0a2b'

test('jwtSubject reads sub from a JWT-shaped token without verifying it', () => {
  assert.equal(jwtSubject(jwt({ sub: SUB, email: 'x@purdue.edu' })), SUB)
  assert.equal(jwtSubject(jwt({ email: 'x@purdue.edu' })), null)
  assert.equal(jwtSubject('not-a-jwt'), null)
  assert.equal(jwtSubject('a.b'), null)
  assert.equal(jwtSubject(`x.${Buffer.from('{not json').toString('base64url')}.y`), null)
  assert.equal(jwtSubject(jwt({ sub: 'x'.repeat(201) })), null, 'absurdly long subjects are ignored')
  assert.equal(jwtSubject(undefined), null)
})

test('sessionSyncBucketKey prefers the bearer token, then the body token, then supabaseUserId, then IP', () => {
  const bearer = { headers: { authorization: `Bearer ${jwt({ sub: SUB })}` }, body: { supabaseUserId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }
  assert.equal(sessionSyncBucketKey(bearer), `sub:${SUB}`)

  const bodyToken = { headers: {}, body: { accessToken: jwt({ sub: SUB }) } }
  assert.equal(sessionSyncBucketKey(bodyToken), `sub:${SUB}`)

  const idOnly = { headers: {}, body: { supabaseUserId: SUB.toUpperCase() } }
  assert.equal(sessionSyncBucketKey(idOnly), `uid:${SUB}`)

  assert.equal(sessionSyncBucketKey({ headers: {}, body: { supabaseUserId: 'not-a-uuid' } }), null)
  assert.equal(sessionSyncBucketKey({ headers: {}, body: {} }), null)
  assert.equal(sessionSyncBucketKey({}), null)
})
