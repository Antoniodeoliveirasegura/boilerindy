// Community text policy tests (issue #209). The filter gates every community
// write (board, lost and found, guide, study groups, marketplace, friend bio),
// so false positives on ordinary words hard-block real posts. These pin the
// trimmed word list, NFKC normalization and BOARD_BLOCKED_WORDS parsing.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  BOARD_PROFANITY_USER_MESSAGE,
  __resetProfanityMatcherForTests,
  assertBoardPostTextAllowed,
  boardTextFailsPolicy,
} from '../src/boardProfanity.mjs'

afterEach(() => {
  delete process.env.BOARD_BLOCKED_WORDS
  __resetProfanityMatcherForTests()
})

test('blocks profanity in a sentence', () => {
  assert.equal(boardTextFailsPolicy('this is fucking great'), true)
})

test('blocks regardless of case', () => {
  assert.equal(boardTextFailsPolicy('THIS IS SHIT'), true)
})

test('blocks fullwidth letters after NFKC normalization', () => {
  assert.equal(boardTextFailsPolicy('ｆｕｃｋ this class'), true)
})

test('blocks a slur inside a sentence', () => {
  assert.equal(boardTextFailsPolicy('stop calling people a faggot in the lounge'), true)
})

test('lets benign words that used to be false positives through', () => {
  for (const text of [
    'Homo sapiens lab report',
    'the flange on the pump',
    'muff coupling for ME 30800',
    'analysis of variance',
    'Scunthorpe',
    'poop deck',
  ]) {
    assert.equal(boardTextFailsPolicy(text), false, text)
  }
})

test('none of the 23 removed words is blocked on its own', () => {
  for (const word of [
    'anal',
    'anus',
    'arse',
    'bollocks',
    'boner',
    'boob',
    'bugger',
    'clitoris',
    'flange',
    'homo',
    'knobend',
    'labia',
    'muff',
    'penis',
    'piss',
    'poop',
    'pube',
    'scrotum',
    'spunk',
    'tosser',
    'turd',
    'vagina',
    'wank',
  ]) {
    assert.equal(boardTextFailsPolicy(`a sentence with ${word} in it`), false, word)
  }
})

test('empty and non-string input passes', () => {
  assert.equal(boardTextFailsPolicy(''), false)
  assert.equal(boardTextFailsPolicy(null), false)
  assert.equal(boardTextFailsPolicy(undefined), false)
  assert.equal(boardTextFailsPolicy(42), false)
})

test('assertBoardPostTextAllowed rejects a blocked title with the user message', () => {
  assert.deepEqual(assertBoardPostTextAllowed('fuck this assignment', 'normal body'), {
    ok: false,
    message: BOARD_PROFANITY_USER_MESSAGE,
  })
})

test('assertBoardPostTextAllowed rejects a blocked body', () => {
  assert.deepEqual(assertBoardPostTextAllowed('Study tips', 'this exam is shit'), {
    ok: false,
    message: BOARD_PROFANITY_USER_MESSAGE,
  })
})

test('assertBoardPostTextAllowed accepts clean text and missing fields', () => {
  assert.deepEqual(assertBoardPostTextAllowed('Homo sapiens lab report', 'the flange on the pump'), {
    ok: true,
  })
  assert.deepEqual(assertBoardPostTextAllowed(undefined, null), { ok: true })
})

test('BOARD_BLOCKED_WORDS adds trimmed words and ignores one-character entries', () => {
  process.env.BOARD_BLOCKED_WORDS = 'zorp, blat , x'
  __resetProfanityMatcherForTests()
  assert.equal(boardTextFailsPolicy('zorp'), true)
  assert.equal(boardTextFailsPolicy('BLAT again'), true)
  assert.equal(boardTextFailsPolicy('x marks the spot'), false)
  assert.equal(boardTextFailsPolicy('this is fucking great'), true)
})

test('the matcher is built once, so BOARD_BLOCKED_WORDS changes need a restart', () => {
  assert.equal(boardTextFailsPolicy('zorp'), false)
  process.env.BOARD_BLOCKED_WORDS = 'zorp'
  assert.equal(boardTextFailsPolicy('zorp'), false)
  __resetProfanityMatcherForTests()
  assert.equal(boardTextFailsPolicy('zorp'), true)
})
