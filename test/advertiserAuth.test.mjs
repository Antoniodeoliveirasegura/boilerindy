import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeAdvertiserEmail,
  normalizeAdvertiserSignIn,
  normalizeLeadInput,
  normalizeAdvertiserAccountInput,
  toAdvertiserProfile,
  COMPANY_NAME_MAX_LENGTH,
  LEAD_MESSAGE_MAX_LENGTH,
} from '../src/advertiserAuth.mjs'

test('normalizeAdvertiserEmail lowercases and trims', () => {
  assert.equal(normalizeAdvertiserEmail('  Brand@Co.COM '), 'brand@co.com')
  assert.equal(normalizeAdvertiserEmail(undefined), '')
})

test('normalizeAdvertiserSignIn returns normalized email + password when valid', () => {
  const result = normalizeAdvertiserSignIn({ email: ' Brand@Co.com ', password: 'secret123' })
  assert.deepEqual(result, { email: 'brand@co.com', password: 'secret123' })
})

test('normalizeAdvertiserSignIn rejects a missing or malformed email', () => {
  assert.throws(() => normalizeAdvertiserSignIn({ email: 'not-an-email', password: 'x' }), /valid business email/)
  assert.throws(() => normalizeAdvertiserSignIn({ password: 'x' }), /valid business email/)
})

test('normalizeAdvertiserSignIn rejects an empty password', () => {
  assert.throws(() => normalizeAdvertiserSignIn({ email: 'brand@co.com', password: '' }), /Enter your password/)
})

test('normalizeLeadInput keeps optional fields null when blank', () => {
  const lead = normalizeLeadInput({ email: 'hi@brand.com' })
  assert.deepEqual(lead, { email: 'hi@brand.com', companyName: null, message: null })
})

test('normalizeLeadInput trims and preserves provided optional fields', () => {
  const lead = normalizeLeadInput({ email: 'hi@brand.com', companyName: '  Acme  ', message: '  hello  ' })
  assert.deepEqual(lead, { email: 'hi@brand.com', companyName: 'Acme', message: 'hello' })
})

test('normalizeLeadInput requires a valid email', () => {
  assert.throws(() => normalizeLeadInput({ email: 'nope' }), /valid business email/)
})

test('normalizeLeadInput rejects an over-long company name and message', () => {
  assert.throws(
    () => normalizeLeadInput({ email: 'hi@brand.com', companyName: 'x'.repeat(COMPANY_NAME_MAX_LENGTH + 1) }),
    /Company name/,
  )
  assert.throws(
    () => normalizeLeadInput({ email: 'hi@brand.com', message: 'x'.repeat(LEAD_MESSAGE_MAX_LENGTH + 1) }),
    /Message/,
  )
})

test('normalizeAdvertiserAccountInput enforces password length and required company', () => {
  assert.throws(
    () => normalizeAdvertiserAccountInput({ email: 'a@b.com', password: 'short', companyName: 'Acme' }),
    /at least 8 characters/,
  )
  assert.throws(
    () => normalizeAdvertiserAccountInput({ email: 'a@b.com', password: 'longenough', companyName: '' }),
    /Company name is required/,
  )
})

test('normalizeAdvertiserAccountInput returns normalized fields when valid', () => {
  const result = normalizeAdvertiserAccountInput({
    email: ' A@B.com ',
    password: 'longenough',
    companyName: '  Acme  ',
    contactName: '  Jo  ',
  })
  assert.deepEqual(result, {
    email: 'a@b.com',
    password: 'longenough',
    companyName: 'Acme',
    contactName: 'Jo',
  })
})

test('toAdvertiserProfile maps DB row to client shape and never leaks the hash', () => {
  const row = {
    id: 'adv-1',
    email: 'brand@co.com',
    password_hash: 'salt:hash',
    company_name: 'Acme',
    contact_name: 'Jo',
    status: 'active',
  }
  const profile = toAdvertiserProfile(row)
  assert.deepEqual(profile, {
    id: 'adv-1',
    email: 'brand@co.com',
    companyName: 'Acme',
    contactName: 'Jo',
    status: 'active',
  })
  assert.equal('password_hash' in profile, false)
  assert.equal(toAdvertiserProfile(null), null)
})
