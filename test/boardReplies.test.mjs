import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupRepliesByPost, mapBoardReply } from '../src/boardReplies.mjs'
import {
  BOARD_PAGE_SIZE,
  INLINE_REPLIES,
  INLINE_REPLY_FETCH_LIMIT,
  REPLY_PAGE_SIZE,
} from '../src/boardLimits.mjs'

// Issue #200 - GET /api/board/posts read every reply of every post it returned.
// It now previews the newest few per post and marks the threads that carry more.

const at = (minutes) => new Date(Date.UTC(2026, 8, 22, 0, minutes)).toISOString()
const reply = (postId, n, minutes) => ({ id: `${postId}-r${n}`, post_id: postId, created_at: at(minutes) })

test('keeps the newest replies per post, oldest first', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => reply('p1', n, n))
  const { byPost, truncatedPostIds } = groupRepliesByPost(rows, { perPost: 3 })
  assert.deepEqual(byPost.p1.map((r) => r.id), ['p1-r5', 'p1-r6', 'p1-r7'])
  assert.deepEqual(truncatedPostIds, ['p1'])
})

test('reads the rows in any order, so the query can fetch them newest first', () => {
  const ascending = [1, 2, 3, 4, 5].map((n) => reply('p1', n, n))
  const descending = [...ascending].reverse()
  const shuffled = [ascending[3], ascending[0], ascending[4], ascending[2], ascending[1]]
  const ids = (rows) => groupRepliesByPost(rows, { perPost: 2 }).byPost.p1.map((r) => r.id)
  assert.deepEqual(ids(ascending), ['p1-r4', 'p1-r5'])
  assert.deepEqual(ids(descending), ['p1-r4', 'p1-r5'])
  assert.deepEqual(ids(shuffled), ['p1-r4', 'p1-r5'])
})

test('leaves a short thread whole and out of the truncated list', () => {
  const rows = [reply('p1', 1, 1), reply('p1', 2, 2)]
  const { byPost, truncatedPostIds } = groupRepliesByPost(rows, { perPost: INLINE_REPLIES })
  assert.equal(byPost.p1.length, 2)
  assert.deepEqual(truncatedPostIds, [])
})

test('a thread sitting exactly on the cap is not truncated', () => {
  const rows = Array.from({ length: INLINE_REPLIES }, (_, i) => reply('p1', i, i))
  const { byPost, truncatedPostIds } = groupRepliesByPost(rows, { perPost: INLINE_REPLIES })
  assert.equal(byPost.p1.length, INLINE_REPLIES)
  assert.deepEqual(truncatedPostIds, [])
})

test('truncates each post on its own count', () => {
  const rows = [
    ...[1, 2, 3, 4].map((n) => reply('busy', n, n)),
    ...[1, 2].map((n) => reply('quiet', n, n)),
  ]
  const { byPost, truncatedPostIds } = groupRepliesByPost(rows, { perPost: 3 })
  assert.deepEqual(byPost.busy.map((r) => r.id), ['busy-r2', 'busy-r3', 'busy-r4'])
  assert.deepEqual(byPost.quiet.map((r) => r.id), ['quiet-r1', 'quiet-r2'])
  assert.deepEqual(truncatedPostIds, ['busy'])
})

test('skips rows with no post id and tolerates a missing list', () => {
  const rows = [{ id: 'orphan', created_at: at(1) }, null, reply('p1', 1, 2)]
  const { byPost } = groupRepliesByPost(rows, { perPost: 3 })
  assert.deepEqual(Object.keys(byPost), ['p1'])
  assert.deepEqual(groupRepliesByPost(undefined), { byPost: {}, truncatedPostIds: [] })
  assert.deepEqual(groupRepliesByPost(null), { byPost: {}, truncatedPostIds: [] })
})

test('defaults to INLINE_REPLIES, and perPost 0 previews nothing', () => {
  const rows = Array.from({ length: INLINE_REPLIES + 3 }, (_, i) => reply('p1', i, i))
  assert.equal(groupRepliesByPost(rows).byPost.p1.length, INLINE_REPLIES)
  const none = groupRepliesByPost(rows, { perPost: 0 })
  assert.deepEqual(none.byPost.p1, [])
  assert.deepEqual(none.truncatedPostIds, ['p1'])
})

test('keeps the input order when a timestamp is unreadable', () => {
  const rows = [
    { id: 'a', post_id: 'p1', created_at: 'not a date' },
    { id: 'b', post_id: 'p1', created_at: 'also not a date' },
  ]
  assert.deepEqual(groupRepliesByPost(rows, { perPost: 5 }).byPost.p1.map((r) => r.id), ['a', 'b'])
})

// The acceptance case from the issue: 30 posts, 50 replies each. Page 0 carries
// BOARD_PAGE_SIZE posts, each previewing INLINE_REPLIES, and every reply is
// still reachable a page at a time from GET /api/board/posts/:id/replies.
test('30 posts by 50 replies: 5 inline each, every reply reachable by page', () => {
  const postIds = Array.from({ length: 30 }, (_, i) => `post-${String(i).padStart(2, '0')}`)
  const every = []
  // Round robin, so no single post owns a run of the newest rows.
  for (let n = 0; n < 50; n++) {
    postIds.forEach((postId, i) => every.push(reply(postId, n, n * 30 + i)))
  }
  assert.equal(every.length, 1500)

  // What the list route reads for page 0: replies of those posts only, newest
  // first, capped by the query's own limit.
  const pageOfPosts = postIds.slice(0, BOARD_PAGE_SIZE)
  const onPage = new Set(pageOfPosts)
  const fetched = every
    .filter((r) => onPage.has(r.post_id))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, INLINE_REPLY_FETCH_LIMIT)
  assert.equal(fetched.length, INLINE_REPLY_FETCH_LIMIT)

  const { byPost, truncatedPostIds } = groupRepliesByPost(fetched, { perPost: INLINE_REPLIES })
  assert.equal(pageOfPosts.length, BOARD_PAGE_SIZE)
  assert.deepEqual(truncatedPostIds.sort(), [...pageOfPosts].sort())
  for (const postId of pageOfPosts) {
    assert.equal(byPost[postId].length, INLINE_REPLIES, `${postId} should preview ${INLINE_REPLIES} replies`)
    const times = byPost[postId].map((r) => Date.parse(r.created_at))
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${postId} previews should be oldest first`)
  }

  // GET /api/board/posts/:id/replies pages the whole thread with .range().
  const thread = every.filter((r) => r.post_id === 'post-00')
  const seen = []
  for (let page = 0; ; page++) {
    const rows = thread.slice(page * REPLY_PAGE_SIZE, page * REPLY_PAGE_SIZE + REPLY_PAGE_SIZE)
    seen.push(...rows)
    if (rows.length < REPLY_PAGE_SIZE) break
  }
  assert.equal(seen.length, 50)
  assert.deepEqual(new Set(seen.map((r) => r.id)).size, 50)
})

// Both board routes shape a reply row through the same mapper, so an inline
// preview and a page of the full thread are the same object to the client.
test('names a non-anonymous author from the batch lookup', () => {
  const row = { id: 'r1', body: 'hi', is_anon: false, user_id: 'u1', created_at: at(1) }
  assert.deepEqual(mapBoardReply(row, { u1: 'Jo Doe' }), { id: 'r1', body: 'hi', user: 'Jo Doe', time: at(1) })
})

test('falls back to Student when the name lookup missed', () => {
  const row = { id: 'r1', body: 'hi', is_anon: false, user_id: 'u1', created_at: at(1) }
  assert.equal(mapBoardReply(row, {}).user, 'Student')
  assert.equal(mapBoardReply(row).user, 'Student')
})

test('never leaks the author of an anonymous reply', () => {
  const row = { id: 'r1', body: 'hi', is_anon: true, user_id: 'u1', created_at: at(1) }
  const mapped = mapBoardReply(row, { u1: 'Jo Doe' })
  assert.equal(mapped.user, 'Anonymous')
  assert.ok(!Object.values(mapped).includes('u1'), 'the user id must not reach the client')
})
