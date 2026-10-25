import test from 'node:test'
import assert from 'node:assert/strict'
import { SIGNUP_REF_MAX_LENGTH, SIGNUP_REF_PARAMS, sanitizeSignupRef, signupRefFromSearch } from '../src/signupRef.mjs'

// The sign-up source (users.signup_ref): the slug rule the website and the API
// share, and the query parameters it is read from. The report's counts are in
// signupRefReport.test.mjs.

test('a ref becomes a lowercase slug of letters, digits and single hyphens', () => {
  const cases = [
    ['flyer-a', 'flyer-a'],
    ['Flyer_A', 'flyer-a'],
    ['  flyer   a  ', 'flyer-a'],
    ['IG.Story+2', 'ig-story-2'],
    ['--amb--jane--', 'amb-jane'],
    ['Café', 'cafe'],
    ['ｆｌｙｅｒ', 'flyer'],
    ['gc/cs-180', 'gc-cs-180'],
    ['42', '42'],
  ]
  for (const [raw, slug] of cases) assert.equal(sanitizeSignupRef(raw), slug, raw)
})

test('a ref is cut at 40 characters, never ending on a hyphen', () => {
  assert.equal(SIGNUP_REF_MAX_LENGTH, 40)
  assert.equal(sanitizeSignupRef('a'.repeat(60)), 'a'.repeat(40))
  // The cut lands just after a hyphen, which goes too.
  assert.equal(sanitizeSignupRef(`${'b'.repeat(39)}-tail`), 'b'.repeat(39))
  for (const raw of ['x'.repeat(41), `${'y'.repeat(20)} ${'z'.repeat(30)}`, 'Ünïcödé '.repeat(10)]) {
    const slug = sanitizeSignupRef(raw)
    assert.ok(slug.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug), `${raw} -> ${slug}`)
  }
})

test('nothing usable, an email address or a value that is not text gives no ref', () => {
  for (const raw of ['', '   ', '---', '@', 'jane@purdue.edu', 'Jane.Doe@gmail.com', '!!!', '日本語', null, undefined, 42, ['flyer-a'], { ref: 'x' }]) {
    assert.equal(sanitizeSignupRef(raw), null, String(raw))
  }
})

test('the query string gives ?ref= first, then ?utm_source=, each sanitized', () => {
  assert.deepEqual(SIGNUP_REF_PARAMS, ['ref', 'utm_source'])
  assert.equal(signupRefFromSearch('?ref=flyer-a'), 'flyer-a')
  assert.equal(signupRefFromSearch('ref=flyer-a'), 'flyer-a')
  assert.equal(signupRefFromSearch('?utm_source=Instagram&utm_medium=bio'), 'instagram')
  assert.equal(signupRefFromSearch('?utm_source=instagram&ref=amb-jane'), 'amb-jane')
  // An unusable ref lets a good utm_source through.
  assert.equal(signupRefFromSearch('?ref=%40%40&utm_source=qr_flyer'), 'qr-flyer')
  assert.equal(signupRefFromSearch('?ref=Flyer%20B&tab=signup'), 'flyer-b')
  // A repeated parameter: the first one, as URLSearchParams.get reads it.
  assert.equal(signupRefFromSearch('?ref=one&ref=two'), 'one')
  for (const search of ['', '?', '?tab=signup', '?ref=', '?ref=jane%40purdue.edu', '?utm_medium=bio', '?REF=upper']) {
    assert.equal(signupRefFromSearch(search), null, search)
  }
})
