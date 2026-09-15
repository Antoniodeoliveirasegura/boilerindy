import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_AUTH_PROVIDERS,
  AVATAR_URL_MESSAGE,
  DISPLAY_NAME_MESSAGE,
  MAX_AVATAR_URL,
  MAX_DISPLAY_NAME,
  normalizeAvatarUrl,
  normalizeDisplayName,
  normalizeProvider,
} from '../src/userFields.mjs'

// Issue #199: display names, avatar URLs and auth providers are validated before
// register, supabase-sync and PATCH /api/me/profile store them.

test('normalizeDisplayName treats missing and blank names as null', () => {
  assert.deepEqual(normalizeDisplayName(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeDisplayName(null), { ok: true, value: null })
  assert.deepEqual(normalizeDisplayName(''), { ok: true, value: null })
  assert.deepEqual(normalizeDisplayName(' \n\t '), { ok: true, value: null })
})

test('normalizeDisplayName trims and collapses inner whitespace', () => {
  assert.deepEqual(normalizeDisplayName('  Purdue   Pete\n\tJr  '), { ok: true, value: 'Purdue Pete Jr' })
  assert.deepEqual(normalizeDisplayName('Pete'), { ok: true, value: 'Pete' })
})

test('normalizeDisplayName rejects non-string input instead of throwing', () => {
  for (const value of [{ first: 'Pete' }, ['Pete'], 42, true]) {
    assert.deepEqual(normalizeDisplayName(value), { ok: false, message: DISPLAY_NAME_MESSAGE })
    assert.deepEqual(normalizeDisplayName(value, { truncate: true }), { ok: false, message: DISPLAY_NAME_MESSAGE })
  }
})

test('normalizeDisplayName caps names at 80 characters', () => {
  assert.equal(MAX_DISPLAY_NAME, 80)
  const exact = 'a'.repeat(80)
  assert.deepEqual(normalizeDisplayName(exact), { ok: true, value: exact })
  assert.deepEqual(normalizeDisplayName('a'.repeat(81)), { ok: false, message: DISPLAY_NAME_MESSAGE })
  // Measured after trimming and collapsing, so padding alone is not a violation.
  assert.deepEqual(normalizeDisplayName(`   ${exact}   `), { ok: true, value: exact })
})

test('normalizeDisplayName with truncate cuts an over-long name to the cap', () => {
  assert.deepEqual(normalizeDisplayName('b'.repeat(500), { truncate: true }), { ok: true, value: 'b'.repeat(80) })
  // A space landing on the cut is trimmed off.
  assert.deepEqual(normalizeDisplayName(`${'c'.repeat(79)} dddd`, { truncate: true }), { ok: true, value: 'c'.repeat(79) })
  // An emoji straddling the cut is dropped whole, not split into a lone surrogate.
  const cut = normalizeDisplayName(`${'e'.repeat(79)}\u{1F600}`, { truncate: true })
  assert.deepEqual(cut, { ok: true, value: 'e'.repeat(79) })
})

test('normalizeAvatarUrl accepts https URLs and null', () => {
  assert.deepEqual(normalizeAvatarUrl(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeAvatarUrl(null), { ok: true, value: null })
  assert.deepEqual(normalizeAvatarUrl(''), { ok: true, value: null })
  // What Google and GitHub OAuth put in user_metadata.avatar_url.
  const google = 'https://lh3.googleusercontent.com/a/ACg8ocJ-example=s96-c'
  const github = 'https://avatars.githubusercontent.com/u/12345678?v=4'
  assert.deepEqual(normalizeAvatarUrl(google), { ok: true, value: google })
  assert.deepEqual(normalizeAvatarUrl(` ${github} `), { ok: true, value: github })
})

test('normalizeAvatarUrl rejects other schemes, junk and non-strings', () => {
  for (const value of [
    'http://example.com/me.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//example.com/me.png',
    'not a url',
    { href: 'https://example.com' },
    42,
  ]) {
    assert.deepEqual(normalizeAvatarUrl(value), { ok: false, message: AVATAR_URL_MESSAGE }, String(value))
  }
})

test('normalizeAvatarUrl caps URLs at 2048 characters', () => {
  assert.equal(MAX_AVATAR_URL, 2048)
  const prefix = 'https://example.com/'
  const exact = prefix + 'a'.repeat(MAX_AVATAR_URL - prefix.length)
  assert.deepEqual(normalizeAvatarUrl(exact), { ok: true, value: exact })
  assert.deepEqual(normalizeAvatarUrl(`${exact}a`), { ok: false, message: AVATAR_URL_MESSAGE })
})

test('normalizeProvider keeps allowlisted providers and falls back otherwise', () => {
  for (const provider of ALLOWED_AUTH_PROVIDERS) {
    assert.equal(normalizeProvider(provider, 'supabase'), provider)
  }
  assert.equal(normalizeProvider(' Google ', 'supabase'), 'google')
  assert.equal(normalizeProvider('evil-provider', 'supabase'), 'supabase')
  assert.equal(normalizeProvider('', 'email'), 'email')
  assert.equal(normalizeProvider(undefined, 'email'), 'email')
  assert.equal(normalizeProvider({ provider: 'google' }, 'local'), 'local')
})
