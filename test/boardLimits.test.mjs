import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateBoardPost,
  validateBoardReply,
  MAX_BOARD_TITLE,
  MAX_BOARD_BODY,
  MAX_BOARD_REPLY,
  BOARD_PAGE_SIZE,
  INLINE_REPLIES,
  REPLY_PAGE_SIZE,
  INLINE_REPLY_FETCH_LIMIT,
} from '../src/boardLimits.mjs'

// Issue #200 - the board capped the title and nothing else, so a post body or a
// reply could be any size the request body allowed.

test('accepts a post inside every cap', () => {
  assert.deepEqual(validateBoardPost({ title: 'Where is the best coffee?', body: 'Near WALC.' }), { ok: true })
})

test('accepts a post with no body at all', () => {
  assert.deepEqual(validateBoardPost({ title: 'Anyone in MA 261?' }), { ok: true })
  assert.deepEqual(validateBoardPost({ title: 'Anyone in MA 261?', body: '' }), { ok: true })
})

test('requires a title that is more than whitespace', () => {
  for (const title of [undefined, '', '   ', '\n\t ']) {
    const result = validateBoardPost({ title, body: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.message, 'Title is required.')
  }
})

test('rejects a title over the cap and accepts one exactly at it', () => {
  assert.deepEqual(validateBoardPost({ title: 'a'.repeat(MAX_BOARD_TITLE) }), { ok: true })
  const result = validateBoardPost({ title: 'a'.repeat(MAX_BOARD_TITLE + 1) })
  assert.equal(result.ok, false)
  assert.equal(result.message, `Title must be ${MAX_BOARD_TITLE} characters or fewer.`)
})

test('rejects a body over the cap and accepts one exactly at it', () => {
  assert.deepEqual(validateBoardPost({ title: 'ok', body: 'b'.repeat(MAX_BOARD_BODY) }), { ok: true })
  const result = validateBoardPost({ title: 'ok', body: 'b'.repeat(MAX_BOARD_BODY + 1) })
  assert.equal(result.ok, false)
  assert.equal(result.message, `Details must be ${MAX_BOARD_BODY} characters or fewer.`)
})

test('measures the trimmed text, so padding alone never fails', () => {
  const padded = `   ${'a'.repeat(MAX_BOARD_TITLE)}   `
  assert.deepEqual(validateBoardPost({ title: padded }), { ok: true })
  assert.deepEqual(validateBoardPost({ title: 'ok', body: `\n${'b'.repeat(MAX_BOARD_BODY)}\n` }), { ok: true })
})

test('reports the title before the body when both are wrong', () => {
  const result = validateBoardPost({ title: '', body: 'b'.repeat(MAX_BOARD_BODY + 1) })
  assert.equal(result.message, 'Title is required.')
})

test('requires a reply that is more than whitespace', () => {
  for (const body of [undefined, '', '   ']) {
    const result = validateBoardReply({ body })
    assert.equal(result.ok, false)
    assert.equal(result.message, 'Reply body is required.')
  }
})

test('rejects a reply over the cap and accepts one exactly at it', () => {
  assert.deepEqual(validateBoardReply({ body: 'r'.repeat(MAX_BOARD_REPLY) }), { ok: true })
  const result = validateBoardReply({ body: 'r'.repeat(MAX_BOARD_REPLY + 1) })
  assert.equal(result.ok, false)
  assert.equal(result.message, `Reply must be ${MAX_BOARD_REPLY} characters or fewer.`)
})

test('survives a call with no argument at all', () => {
  assert.equal(validateBoardPost().ok, false)
  assert.equal(validateBoardReply().ok, false)
})

test('the page sizes are the ones the website and the routes agree on', () => {
  assert.equal(BOARD_PAGE_SIZE, 20)
  assert.equal(INLINE_REPLIES, 5)
  assert.equal(REPLY_PAGE_SIZE, 50)
  // The list route reads at most this many reply rows per page of posts.
  assert.equal(INLINE_REPLY_FETCH_LIMIT, BOARD_PAGE_SIZE * INLINE_REPLIES * 2)
})
