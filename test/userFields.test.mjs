import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_AUTH_PROVIDERS,
  AVATAR_URL_MESSAGE,
  DISPLAY_NAME_MESSAGE,
  MAX_AVATAR_URL,
  MAX_DISPLAY_NAME,
  deriveDisplayName,
  normalizeAvatarUrl,
  normalizeDisplayName,
  normalizeProfileName,
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

test('normalizeProfileName cuts an unchanged stored name over the cap and rejects new long names', () => {
  const stored = 'f'.repeat(120)
  // Settings resends the stored name with a password change: saved, cut to 80.
  assert.deepEqual(normalizeProfileName(stored, stored), { ok: true, value: 'f'.repeat(80) })
  assert.deepEqual(normalizeProfileName(`  ${stored} `, stored), { ok: true, value: 'f'.repeat(80) })
  // A different long name is still the standard rejection.
  assert.deepEqual(normalizeProfileName('g'.repeat(120), stored), { ok: false, message: DISPLAY_NAME_MESSAGE })
  assert.deepEqual(normalizeProfileName('g'.repeat(81), 'Pete'), { ok: false, message: DISPLAY_NAME_MESSAGE })
  // Normal names, blanks and non-strings behave like normalizeDisplayName.
  assert.deepEqual(normalizeProfileName('Pete', stored), { ok: true, value: 'Pete' })
  assert.deepEqual(normalizeProfileName('', stored), { ok: true, value: null })
  assert.deepEqual(normalizeProfileName(undefined, stored), { ok: true, value: null })
  assert.deepEqual(normalizeProfileName({ name: stored }, stored), { ok: false, message: DISPLAY_NAME_MESSAGE })
})

test('deriveDisplayName caps provided and stored names and builds one from the email', () => {
  assert.equal(deriveDisplayName('pete@purdue.edu', '  Purdue  Pete '), 'Purdue Pete')
  // A stored name from before the cap is cut when the row is saved again.
  assert.equal(deriveDisplayName('pete@purdue.edu', 'h'.repeat(300)), 'h'.repeat(80))
  // Nothing usable provided: built from the email's local part.
  assert.equal(deriveDisplayName('purdue.pete_jr@purdue.edu', ''), 'Purdue Pete Jr')
  assert.equal(deriveDisplayName('purdue.pete@purdue.edu', null), 'Purdue Pete')
  assert.equal(deriveDisplayName('purdue.pete@purdue.edu', '   '), 'Purdue Pete')
  assert.equal(deriveDisplayName('purdue.pete@purdue.edu', { name: 'x' }), 'Purdue Pete')
  assert.equal(deriveDisplayName(`${'k'.repeat(200)}@purdue.edu`), `K${'k'.repeat(79)}`)
  assert.equal(deriveDisplayName('', ''), 'Student')
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
  // Stored in the parsed, normalized form.
  assert.deepEqual(normalizeAvatarUrl('HTTPS://Example.com/me pic.png'), {
    ok: true,
    value: 'https://example.com/me%20pic.png',
  })
})

test('normalizeAvatarUrl rejects other schemes, scheme-relative https, junk and non-strings', () => {
  for (const value of [
    'http://example.com/me.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//example.com/me.png',
    'not a url',
    // Parse as https: but a browser resolves them against the current page.
    'https:foo',
    'https:/x',
    'https:api/sign-out',
    'https:\\\\example.com/me.png',
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
  // The cap also applies after normalization grows the URL: 2048 characters as
  // sent, 2050 once the space becomes %20.
  const grows = `${prefix}${'a'.repeat(MAX_AVATAR_URL - prefix.length - 2)} b`
  assert.equal(grows.length, MAX_AVATAR_URL)
  assert.deepEqual(normalizeAvatarUrl(grows), { ok: false, message: AVATAR_URL_MESSAGE })
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
