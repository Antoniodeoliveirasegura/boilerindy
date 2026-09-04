import test from 'node:test'
import assert from 'node:assert/strict'
import { apiNotFound } from '../src/apiNotFound.mjs'

// Minimal Express res double (same style as rateLimiter.test.mjs) so the
// fallthrough can be exercised without booting server.mjs.
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
}

test('unknown /api path gets a 404 in the standard JSON error shape', () => {
  const res = mockRes()
  apiNotFound({ method: 'GET', path: '/does-not-exist' }, res)
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.body, { error: { message: 'Not found.', status: 404 } })
})

test('is terminal: responds itself and never calls next()', () => {
  const res = mockRes()
  let nextCalled = false
  apiNotFound({ method: 'POST', path: '/nope' }, res, () => {
    nextCalled = true
  })
  assert.equal(nextCalled, false)
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.error.status, 404)
})
