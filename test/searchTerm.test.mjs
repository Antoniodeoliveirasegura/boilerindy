import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSearchTerm } from '../src/searchTerm.mjs'

// Issue #191: the search-term rule the lost-and-found and marketplace lists
// share, moved out of server.mjs with the first router that needs it.

test('strips the PostgREST separators and ILIKE wildcards', () => {
  assert.equal(sanitizeSearchTerm('50%_off'), '50  off')
  assert.equal(sanitizeSearchTerm('a,title.ilike.x'), 'a title.ilike.x')
  assert.equal(sanitizeSearchTerm('(keys)'), 'keys')
  assert.equal(sanitizeSearchTerm('back\\slash'), 'back slash')
  // Nothing left of an injected clause but plain words.
  assert.equal(sanitizeSearchTerm('x%,user_id.eq.1)'), 'x  user id.eq.1')
})

test('trims and caps the term at 120 characters', () => {
  assert.equal(sanitizeSearchTerm('  wallet  '), 'wallet')
  assert.equal(sanitizeSearchTerm('%%%'), '')
  const long = 'a'.repeat(200)
  assert.equal(sanitizeSearchTerm(long).length, 120)
  assert.equal(sanitizeSearchTerm(` ${'b'.repeat(130)}`), 'b'.repeat(120))
})

test('null and undefined give an empty string, other values are stringified', () => {
  assert.equal(sanitizeSearchTerm(null), '')
  assert.equal(sanitizeSearchTerm(undefined), '')
  assert.equal(sanitizeSearchTerm(42), '42')
})
