// Reply cleanup for the campus assistant (issue #252): markdown the chat
// bubble cannot render is stripped, and em/en dashes never reach the student.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tidyAssistantReply } from '../src/assistantReply.mjs'

test('strips bold, italics and headings the plain-text bubble would show raw', () => {
  assert.equal(tidyAssistantReply('Grab a bite at **Tower Dining** before the rush.'), 'Grab a bite at Tower Dining before the rush.')
  assert.equal(tidyAssistantReply('It is *really* quiet there.'), 'It is really quiet there.')
  assert.equal(tidyAssistantReply('### Your afternoon\nLibrary first.'), 'Your afternoon\nLibrary first.')
  // A lone asterisk that is not markup stays.
  assert.equal(tidyAssistantReply('5 * 3 = 15'), '5 * 3 = 15')
})

test('turns a dash between times or numbers into "to" and any other dash into a comma', () => {
  assert.equal(tidyAssistantReply('11:45 AM \u2013 12:15 PM: lunch at Tower.'), '11:45 AM to 12:15 PM: lunch at Tower.')
  assert.equal(tidyAssistantReply('Open 9\u201317 daily'), 'Open 9 to 17 daily')
  assert.equal(tidyAssistantReply('ET Building or SL\u2014great spots for STEM work.'), 'ET Building or SL, great spots for STEM work.')
  assert.equal(tidyAssistantReply('Lily Day \u2013 live music until 8 PM'), 'Lily Day, live music until 8 PM')
  assert.equal(tidyAssistantReply('Non\u2011breaking hyphen'), 'Non-breaking hyphen')
})

test('normalises bullet glyphs and dash bullets to "- " and leaves no stray comma', () => {
  assert.equal(tidyAssistantReply('• Lunch\n\u2013 Library\n* Park'), '- Lunch\n- Library\n- Park')
  assert.equal(tidyAssistantReply('\u2014 that is all'), '- that is all')
  assert.equal(tidyAssistantReply('\u2014that is all'), 'that is all')
})

test('collapses trailing spaces and runs of blank lines, keeps "- " lists intact', () => {
  assert.equal(tidyAssistantReply('One.   \n\n\n\nTwo.\n- a\n- b'), 'One.\n\nTwo.\n- a\n- b')
})

test('handles empty and non-string input', () => {
  assert.equal(tidyAssistantReply(null), null)
  assert.equal(tidyAssistantReply(undefined), null)
  assert.equal(tidyAssistantReply('   '), null)
  assert.equal(tidyAssistantReply(42), '42')
})

test('is idempotent', () => {
  const once = tidyAssistantReply('**Plan** \u2014 11:45 AM \u2013 12:15 PM at *Tower*.\n\n\n• Then the library')
  assert.equal(tidyAssistantReply(once), once)
  assert.equal(once, 'Plan, 11:45 AM to 12:15 PM at Tower.\n\n- Then the library')
})
