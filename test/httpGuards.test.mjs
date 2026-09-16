import test from 'node:test'
import assert from 'node:assert/strict'
import { isUuid, requireUuidParam } from '../src/httpGuards.mjs'

// Issue #203 (reused by #196): malformed ids are rejected before they reach
// PostgREST as a 22P02 500.

const ID = '2f6b7a1e-9c4d-4e8f-8a1b-3c5d7e9f0a2b'

// Minimal Express res double (same style as apiNotFound.test.mjs).
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

function run(middleware, params) {
  const res = mockRes()
  let nextCalled = false
  middleware({ params }, res, () => {
    nextCalled = true
  })
  return { res, nextCalled }
}

test('isUuid accepts canonical UUIDs in either case', () => {
  assert.equal(isUuid(ID), true)
  assert.equal(isUuid(ID.toUpperCase()), true)
  assert.equal(isUuid('00000000-0000-0000-0000-000000000000'), true)
})

test('isUuid rejects malformed and non-string values', () => {
  assert.equal(isUuid('abc'), false)
  assert.equal(isUuid(''), false)
  assert.equal(isUuid(`${ID}' OR '1'='1`), false)
  assert.equal(isUuid(` ${ID}`), false, 'no surrounding whitespace')
  assert.equal(isUuid(ID.replace(/-/g, '')), false, 'hyphens are required')
  assert.equal(isUuid('2f6b7a1e-9c4d-4e8f-8a1b-3c5d7e9f0a2g'), false, 'hex digits only')
  assert.equal(isUuid(undefined), false)
  assert.equal(isUuid(null), false)
  assert.equal(isUuid(123), false)
  assert.equal(isUuid({ toString: () => ID }), false)
})

test('requireUuidParam calls next() when the param is a UUID', () => {
  const { res, nextCalled } = run(requireUuidParam('id'), { id: ID })
  assert.equal(nextCalled, true)
  assert.equal(res.body, undefined)
})

test('requireUuidParam answers the standard 400 shape and stops the chain', () => {
  for (const params of [{ id: 'abc' }, { id: "1; drop table users" }, {}]) {
    const { res, nextCalled } = run(requireUuidParam('id'), params)
    assert.equal(nextCalled, false)
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.body, { error: { message: 'A valid id is required.', status: 400 } })
  }
})

test('requireUuidParam checks every named param', () => {
  const guard = requireUuidParam(['requesterId', 'id'])
  assert.equal(run(guard, { requesterId: ID, id: ID }).nextCalled, true)
  const bad = run(guard, { requesterId: ID, id: 'nope' })
  assert.equal(bad.nextCalled, false)
  assert.equal(bad.res.statusCode, 400)
})

test('requireUuidParam checks every name passed as separate arguments', () => {
  const guard = requireUuidParam('requesterId', 'id')
  assert.equal(run(guard, { requesterId: ID, id: ID }).nextCalled, true)
  const bad = run(guard, { requesterId: ID, id: 'abc' })
  assert.equal(bad.nextCalled, false, 'the second name is checked, not read as options')
  assert.equal(bad.res.statusCode, 400)
})

test('requireUuidParam takes options after several names', () => {
  const guard = requireUuidParam('requesterId', 'id', { status: 404, message: 'Not found.' })
  const { res, nextCalled } = run(guard, { requesterId: 'abc', id: ID })
  assert.equal(nextCalled, false)
  assert.deepEqual(res.body, { error: { message: 'Not found.', status: 404 } })
})

test('requireUuidParam throws at mount time without a usable name', () => {
  assert.throws(() => requireUuidParam(), TypeError)
  assert.throws(() => requireUuidParam({ status: 404 }), TypeError)
  assert.throws(() => requireUuidParam(''), TypeError)
  assert.throws(() => requireUuidParam('id', 42), TypeError)
})

test('requireUuidParam can answer a custom status and message', () => {
  const { res, nextCalled } = run(requireUuidParam('id', { status: 404, message: 'Not found.' }), { id: 'abc' })
  assert.equal(nextCalled, false)
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.body, { error: { message: 'Not found.', status: 404 } })
})
