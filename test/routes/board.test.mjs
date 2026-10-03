import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createBoardRouter } from '../../src/routes/board.mjs'
import { BOARD_PAGE_SIZE, INLINE_REPLIES, INLINE_REPLY_FETCH_LIMIT, REPLY_PAGE_SIZE } from '../../src/boardLimits.mjs'
import { BOARD_PROFANITY_USER_MESSAGE } from '../../src/boardProfanity.mjs'
import { mapBoardReply } from '../../src/boardReplies.mjs'
import { GroqUpstreamError } from '../../src/groqClient.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the campus board routes as a feature router, booted on a small
// app with a fake session, recording limiters, a recording database, fakes of
// the community counters and the auto-tagger's window, and a scripted stand-in
// for the Groq client, so nothing here reaches a model.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com', display_name: 'Sam Student' }
const OTHER = '22222222-2222-4222-8222-222222222222'
const ADMIN = { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.com', display_name: 'Ada Admin', is_admin: true }
const ANON_AUTHOR = '44444444-4444-4444-8444-444444444444'
const BLOCKED = '55555555-5555-4555-8555-555555555555'
const POST_ID = '66666666-6666-4666-8666-666666666666'
const POST_2 = '77777777-7777-4777-8777-777777777777'
const NAMES = { [STUDENT.id]: 'Sam Student', [OTHER]: 'Olive Other' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function postRow(overrides = {}) {
  return {
    id: POST_ID,
    user_id: STUDENT.id,
    title: 'Where is the quietest study spot?',
    body: 'The library is packed after 2pm',
    is_anon: false,
    pinned: false,
    upvote_count: 2,
    reply_count: 0,
    tags: ['library'],
    created_at: '2026-10-01T12:00:00.000Z',
    edited_at: null,
    ...overrides,
  }
}

function replyRow(n, overrides = {}) {
  return {
    id: `reply-${n}`,
    post_id: POST_ID,
    body: `Reply ${n}`,
    is_anon: false,
    user_id: OTHER,
    created_at: new Date(Date.UTC(2026, 9, 1, 13, n)).toISOString(),
    ...overrides,
  }
}

const isUserAdmin = (user) => user?.is_admin === true

// Stands in for createGroqClient: `answer(options)` gives the reply text, or
// throws, and every call is recorded with what the route asked for.
function scriptedAi(answer = () => null, { enabled = true } = {}) {
  const calls = []
  return {
    enabled,
    calls,
    async reply(options) {
      calls.push(options)
      return answer(options)
    },
  }
}

async function waitFor(predicate, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function withApp(
  { user = STUDENT, handlers = {}, ai = scriptedAi(), tagWindowAllows = true, replySync = { count: 1 }, upvoteCounts = [4] } = {},
  run,
) {
  const supabase = fakeSupabase({
    board_posts: () => ({ data: [], error: null }),
    board_replies: () => ({ data: [], error: null }),
    board_upvotes: () => ({ data: [], error: null }),
    users: (chain) => {
      const ids = chain.find((c) => c.method === 'in')?.args[1] || []
      return { data: ids.filter((id) => NAMES[id]).map((id) => ({ id, display_name: NAMES[id] })), error: null }
    },
    // Nobody is blocked unless a test says so (#192).
    blocked_users: () => ({ data: [], error: null }),
    ...handlers,
  })
  const limiterHits = []
  const recounts = []
  const windowHits = []
  const communityCounters = {
    async syncBoardPostReplies(postId) {
      recounts.push(`replies ${postId}`)
      return replySync
    },
    async syncBoardPostUpvotes(postId) {
      recounts.push(`upvotes ${postId}`)
      const n = recounts.filter((r) => r.startsWith('upvotes')).length
      return { count: upvoteCounts[Math.min(n - 1, upvoteCounts.length - 1)], error: null }
    },
  }
  const boardTagWindow = {
    hit(key) {
      windowHits.push(key)
      return { allowed: tagWindowAllows }
    },
  }
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createBoardRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        // What express-session holds for a signed-in student; the auto-tagger meters by it.
        req.session = { userId: user.id }
        next()
      },
      isUserAdmin,
      communityCounters,
      ai,
      boardAiRateLimit: limiter('boardAiRateLimit'),
      boardTagWindow,
      boardWriteRateLimit: limiter('boardWriteRateLimit'),
      userWriteRateLimit: limiter('userWriteRateLimit'),
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  try {
    await run({ call, supabase, limiterHits, recounts, windowHits, ai })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const NEW_POST = { title: '  Where is the quietest study spot?  ', body: ' The library is packed after 2pm ' }
const EVERY_ROUTE = [
  ['GET', '/api/board/posts'],
  ['GET', `/api/board/posts/${POST_ID}/replies`],
  ['POST', '/api/board/ai-suggestions'],
  ['POST', '/api/board/posts'],
  ['POST', `/api/board/posts/${POST_ID}/reply`],
  ['POST', `/api/board/posts/${POST_ID}/upvote`],
  ['PATCH', `/api/board/posts/${POST_ID}`],
  ['DELETE', `/api/board/posts/${POST_ID}`],
]

// ── Session and limiters ────────────────────────────────────────────────────

test('every route sits behind requireAuth, with the write limiters ahead of it and the AI limiter behind it', async () => {
  const ai = scriptedAi(() => '{}')
  await withApp({ user: null, ai }, async ({ call, supabase, limiterHits }) => {
    for (const [method, path] of EVERY_ROUTE) {
      const answer = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : { ...NEW_POST, body: 'A reply body' })
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.equal(ai.calls.length, 0)
    assert.deepEqual(limiterHits, [
      'boardWriteRateLimit POST /api/board/posts',
      `boardWriteRateLimit POST /api/board/posts/${POST_ID}/reply`,
      `boardWriteRateLimit POST /api/board/posts/${POST_ID}/upvote`,
      `boardWriteRateLimit PATCH /api/board/posts/${POST_ID}`,
      `userWriteRateLimit DELETE /api/board/posts/${POST_ID}`,
    ])
  })
})

test('each route passes its limiter: board-write for the four writes, user-write for delete, ai-board for suggestions, none for the reads', async () => {
  const handlers = {
    board_posts: (chain) => {
      const op = operation(chain)
      if (op === 'insert') return { data: postRow(), error: null }
      if (op === 'update') return { data: [postRow()], error: null }
      return { data: hasCall(chain, 'maybeSingle') ? { id: POST_ID } : [], error: null }
    },
    board_replies: (chain) => (operation(chain) === 'insert' ? { data: replyRow(1), error: null } : { data: [], error: null }),
  }
  await withApp({ handlers, ai: scriptedAi(() => '{}', { enabled: false }) }, async ({ call, limiterHits }) => {
    const statuses = []
    for (const [method, path] of EVERY_ROUTE) {
      const answer = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : { ...NEW_POST, body: 'A reply body' })
      statuses.push(answer.status)
    }
    assert.deepEqual(statuses, [200, 200, 503, 201, 201, 200, 200, 204])
    assert.deepEqual(limiterHits, [
      'boardAiRateLimit POST /api/board/ai-suggestions',
      'boardWriteRateLimit POST /api/board/posts',
      `boardWriteRateLimit POST /api/board/posts/${POST_ID}/reply`,
      `boardWriteRateLimit POST /api/board/posts/${POST_ID}/upvote`,
      `boardWriteRateLimit PATCH /api/board/posts/${POST_ID}`,
      `userWriteRateLimit DELETE /api/board/posts/${POST_ID}`,
    ])
  })
})

// ── GET /api/board/posts ────────────────────────────────────────────────────

test('the list maps a page of live posts with reply previews, names for named authors only and the caller\'s upvotes', async () => {
  const mine = postRow({ upvote_count: 12, reply_count: 2 })
  const anon = postRow({
    id: POST_2,
    user_id: ANON_AUTHOR,
    title: 'Is the Michigan St garage full?',
    is_anon: true,
    pinned: true,
    upvote_count: 15,
    reply_count: 7,
    tags: null,
    edited_at: '2026-10-02T09:00:00.000Z',
  })
  const myReplies = [replyRow(2, { is_anon: true, user_id: STUDENT.id }), replyRow(1)]
  const busyThread = Array.from({ length: INLINE_REPLIES + 1 }, (_, i) => replyRow(10 + i, { id: `busy-${i}`, post_id: POST_2 })).reverse()
  const handlers = {
    board_posts: () => ({ data: [mine, anon], error: null }),
    // Newest first, as the route asks for them.
    board_replies: () => ({ data: [...busyThread, ...myReplies], error: null }),
    board_upvotes: () => ({ data: [{ post_id: POST_2 }], error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/board/posts')
    assert.equal(answer.status, 200)
    const shown = (rows) => rows.map((r) => mapBoardReply(r, NAMES, STUDENT.id))
    assert.deepEqual(answer.body, {
      posts: [
        {
          id: POST_ID,
          title: mine.title,
          body: mine.body,
          anon: false,
          user: 'Sam Student',
          upvotes: 12,
          pinned: false,
          hot: true,
          time: mine.created_at,
          tags: ['library'],
          editedTime: null,
          upvotedByMe: false,
          isMine: true,
          replies: shown([replyRow(1), replyRow(2, { is_anon: true, user_id: STUDENT.id })]),
          replyCount: 2,
          hasMoreReplies: false,
        },
        {
          id: POST_2,
          title: anon.title,
          body: anon.body,
          anon: true,
          user: 'Anonymous',
          upvotes: 15,
          pinned: true,
          hot: false,
          time: anon.created_at,
          tags: [],
          editedTime: '2026-10-02T09:00:00.000Z',
          upvotedByMe: true,
          isMine: false,
          replies: shown([...busyThread].reverse().slice(1)),
          replyCount: 7,
          hasMoreReplies: true,
        },
      ],
      page: 0,
      hasMore: false,
    })

    const [list] = supabase.queriesOf('board_posts')
    assert.ok(hasCall(list.chain, 'select', '*'))
    assert.ok(hasCall(list.chain, 'is', 'deleted_at', null))
    assert.deepEqual(list.chain.filter((c) => c.method === 'order').map((c) => c.args), [
      ['pinned', { ascending: false }],
      ['created_at', { ascending: false }],
    ])
    assert.ok(hasCall(list.chain, 'range', 0, BOARD_PAGE_SIZE - 1))
    const [replies] = supabase.queriesOf('board_replies')
    assert.ok(hasCall(replies.chain, 'select', 'id, post_id, body, is_anon, created_at, user_id'))
    assert.ok(hasCall(replies.chain, 'in', 'post_id', [POST_ID, POST_2]))
    assert.ok(hasCall(replies.chain, 'order', 'created_at', { ascending: false }))
    assert.ok(hasCall(replies.chain, 'limit', INLINE_REPLY_FETCH_LIMIT))
    const [names] = supabase.queriesOf('users')
    const looked = names.chain.find((c) => c.method === 'in').args[1]
    assert.deepEqual([...looked].sort(), [STUDENT.id, OTHER].sort(), 'the anonymous author is never looked up')
    const [votes] = supabase.queriesOf('board_upvotes')
    assert.ok(hasCall(votes.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(votes.chain, 'in', 'post_id', [POST_ID, POST_2]))
  })
})

test('the popular sort orders by votes, pages by BOARD_PAGE_SIZE, and a spent reply budget marks every short thread', async () => {
  const fullPage = Array.from({ length: BOARD_PAGE_SIZE }, (_, i) => postRow({ id: `post-${i}`, user_id: OTHER }))
  const budget = Array.from({ length: INLINE_REPLY_FETCH_LIMIT }, (_, i) => replyRow(i % 60, { id: `r-${i}`, post_id: 'post-0' }))
  const handlers = {
    board_posts: () => ({ data: fullPage, error: null }),
    board_replies: () => ({ data: budget, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/board/posts?sort=popular&page=2')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.page, 2)
    assert.equal(answer.body.hasMore, true)
    assert.equal(answer.body.posts[0].replies.length, INLINE_REPLIES)
    assert.ok(answer.body.posts.every((p) => p.hasMoreReplies), 'a thread starved by the global budget keeps its marker')
    const [list] = supabase.queriesOf('board_posts')
    assert.deepEqual(list.chain.filter((c) => c.method === 'order').map((c) => c.args[0]), ['pinned', 'upvote_count', 'created_at'])
    assert.ok(hasCall(list.chain, 'range', 2 * BOARD_PAGE_SIZE, 3 * BOARD_PAGE_SIZE - 1))
  })
})

test('the list leaves out users on either side of a block in the queries, and an empty page reads nothing more (#192)', async () => {
  const handlers = {
    blocked_users: () => ({ data: [{ blocker_id: BLOCKED, blocked_id: STUDENT.id }], error: null }),
    board_posts: () => ({ data: [postRow()], error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    assert.equal((await call('GET', '/api/board/posts')).status, 200)
    const [blocks] = supabase.queriesOf('blocked_users')
    assert.ok(hasCall(blocks.chain, 'or', `blocker_id.eq.${STUDENT.id},blocked_id.eq.${STUDENT.id}`))
    assert.ok(hasCall(supabase.queriesOf('board_posts')[0].chain, 'not', 'user_id', 'in', `(${BLOCKED})`))
    assert.ok(hasCall(supabase.queriesOf('board_replies')[0].chain, 'not', 'user_id', 'in', `(${BLOCKED})`))
  })
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/board/posts')
    assert.deepEqual(answer.body, { posts: [], page: 0, hasMore: false })
    assert.deepEqual(supabase.queries.map((q) => q.table), ['blocked_users', 'board_posts'])
  })
})

// ── GET /api/board/posts/:id/replies ────────────────────────────────────────

test('the replies route pages a live thread oldest first without blocked users, and 404s a missing post', async () => {
  const page = Array.from({ length: REPLY_PAGE_SIZE }, (_, i) => replyRow(i % 60, { id: `r-${i}` }))
  const handlers = {
    blocked_users: () => ({ data: [{ blocker_id: STUDENT.id, blocked_id: BLOCKED }], error: null }),
    board_posts: () => ({ data: { id: POST_ID }, error: null }),
    board_replies: () => ({ data: page, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', `/api/board/posts/${POST_ID}/replies?page=1`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { replies: page.map((r) => mapBoardReply(r, NAMES, STUDENT.id)), page: 1, hasMore: true })
    const [post] = supabase.queriesOf('board_posts')
    assert.ok(hasCall(post.chain, 'eq', 'id', POST_ID))
    assert.ok(hasCall(post.chain, 'is', 'deleted_at', null))
    const [{ chain }] = supabase.queriesOf('board_replies')
    assert.ok(hasCall(chain, 'eq', 'post_id', POST_ID))
    assert.ok(hasCall(chain, 'not', 'user_id', 'in', `(${BLOCKED})`))
    assert.ok(hasCall(chain, 'order', 'created_at', { ascending: true }))
    assert.ok(hasCall(chain, 'range', REPLY_PAGE_SIZE, 2 * REPLY_PAGE_SIZE - 1))
  })
  await withApp({ handlers: { board_posts: () => ({ data: null, error: null }) } }, async ({ call, supabase }) => {
    const answer = await call('GET', `/api/board/posts/${POST_ID}/replies`)
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Post not found.', status: 404 } })
    assert.equal(supabase.queriesOf('board_replies').length, 0)
  })
})

// ── POST /api/board/ai-suggestions ──────────────────────────────────────────

test('suggestions answer 503 without a Groq key, and skip the model for a draft too short to help', async () => {
  const off = scriptedAi(() => '{}', { enabled: false })
  await withApp({ ai: off }, async ({ call }) => {
    const answer = await call('POST', '/api/board/ai-suggestions', { title: 'Where is the quietest study spot?' })
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, { error: { message: 'AI suggestions are not configured.', status: 503 } })
  })
  assert.equal(off.calls.length, 0)

  const ai = scriptedAi(() => '{}')
  await withApp({ ai }, async ({ call }) => {
    assert.deepEqual((await call('POST', '/api/board/ai-suggestions', { title: 'Help', body: 'short' })).body, { betterTitle: null, bodyAddOn: null, tags: [] })
    assert.deepEqual((await call('POST', '/api/board/ai-suggestions', { context: 'reply', draft: 'ok' })).body, { replyTip: null })
  })
  assert.equal(ai.calls.length, 0)
})

test('compose suggestions pull the JSON out of the reply and keep only known tags, lowercased, three at most', async () => {
  const ai = scriptedAi(
    () => 'Here you go:\n```json\n{"betterTitle":"  Quiet study spots near ET?  ","bodyAddOn":" Say which building. ","tags":["Library","study-spots","bogus","tech","classes"]}\n```',
  )
  await withApp({ ai }, async ({ call }) => {
    const answer = await call('POST', '/api/board/ai-suggestions', { title: 'Where is the quietest study spot?', body: '' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { betterTitle: 'Quiet study spots near ET?', bodyAddOn: 'Say which building.', tags: ['library', 'study-spots', 'tech'] })
  })
  const [asked] = ai.calls
  assert.equal(asked.system, undefined)
  assert.equal(asked.maxOutputTokens, 350)
  assert.equal(asked.temperature, 0.35)
  assert.match(asked.messages[0].content, /Title \(draft\):\nWhere is the quietest study spot\?\n\nBody \(draft\):\n\(empty\)/)
  assert.match(asked.messages[0].content, /each must be exactly one of: dining, parking, tutoring, /)
})

test('reply tips come back trimmed, and an unreadable reply answers the empty suggestion', async () => {
  const replies = ['{"replyTip":"  Say which floor you mean.  "}', 'no JSON here', '{"replyTip": oops}']
  const ai = scriptedAi(() => replies.shift())
  await withApp({ ai }, async ({ call }) => {
    const reply = { context: 'reply', postTitle: 'Quiet floors?', postBody: 'Need one', draft: 'Try the fourth floor' }
    assert.deepEqual((await call('POST', '/api/board/ai-suggestions', reply)).body, { replyTip: 'Say which floor you mean.' })
    assert.deepEqual((await call('POST', '/api/board/ai-suggestions', { title: 'Where is the quietest study spot?' })).body, { betterTitle: null, bodyAddOn: null, tags: [] })
    assert.deepEqual((await call('POST', '/api/board/ai-suggestions', reply)).body, { replyTip: null })
  })
  assert.match(ai.calls[0].messages[0].content, /^Campus board thread title: Quiet floors\?\nOriginal post:\nNeed one\n\nStudent's reply draft:\nTry the fourth floor/)
})

test('a Groq error answers 502, anything else 500', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const errors = [new GroqUpstreamError(429, 'rate limited'), new Error('socket hang up')]
  const ai = scriptedAi(() => {
    throw errors.shift()
  })
  await withApp({ ai }, async ({ call }) => {
    const upstream = await call('POST', '/api/board/ai-suggestions', { title: 'Where is the quietest study spot?' })
    assert.equal(upstream.status, 502)
    assert.deepEqual(upstream.body, { error: { message: 'AI service error', status: 502 } })
    const other = await call('POST', '/api/board/ai-suggestions', { title: 'Where is the quietest study spot?' })
    assert.equal(other.status, 500)
    assert.deepEqual(other.body, { error: { message: 'Suggestion request failed', status: 500 } })
  })
  assert.deepEqual(log.mock.calls.map((c) => c.arguments), [
    ['Board AI suggestions:', 'rate limited'],
    ['Board AI suggestions:', 'socket hang up'],
  ])
})

// ── POST /api/board/posts and the auto-tagger ───────────────────────────────

function createHandlers(inserted = postRow({ tags: null, reply_count: 0, upvote_count: 0 })) {
  return {
    board_posts: (chain) => (operation(chain) === 'insert' ? { data: inserted, error: null } : { data: null, error: null }),
  }
}

test('a new post is validated and run through the profanity policy before any write', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const noTitle = await call('POST', '/api/board/posts', { title: '   ', body: 'x' })
    assert.equal(noTitle.status, 400)
    assert.deepEqual(noTitle.body, { error: { message: 'Title is required.', status: 400 } })
    const profane = await call('POST', '/api/board/posts', { title: 'Help', body: 'what an asshole' })
    assert.equal(profane.status, 400)
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
    assert.equal(supabase.queries.length, 0)
  })
})

test('a new post is saved for the caller and comes back with the tags a quick tagger picked', async () => {
  const ai = scriptedAi(() => '["Library", "study-spots", "bogus"]')
  await withApp({ ai, handlers: createHandlers() }, async ({ call, supabase, windowHits }) => {
    const answer = await call('POST', '/api/board/posts', { ...NEW_POST, anon: 'false' })
    assert.equal(answer.status, 201)
    assert.deepEqual(answer.body, {
      post: {
        id: POST_ID,
        title: 'Where is the quietest study spot?',
        body: 'The library is packed after 2pm',
        anon: false,
        user: 'Sam Student',
        upvotes: 0,
        pinned: false,
        hot: false,
        time: '2026-10-01T12:00:00.000Z',
        upvotedByMe: false,
        isMine: true,
        tags: ['library', 'study-spots'],
        replies: [],
      },
    })
    const [insert, tagWrite] = supabase.queriesOf('board_posts')
    assert.ok(hasCall(insert.chain, 'insert', { user_id: STUDENT.id, title: 'Where is the quietest study spot?', body: 'The library is packed after 2pm', is_anon: false }))
    assert.ok(hasCall(insert.chain, 'select', 'id, title, body, is_anon, pinned, upvote_count, reply_count, created_at'))
    assert.ok(hasCall(tagWrite.chain, 'update', { tags: ['library', 'study-spots'] }))
    assert.ok(hasCall(tagWrite.chain, 'eq', 'id', POST_ID))
    assert.deepEqual(windowHits, [STUDENT.id], 'the tagger meters by the session user')
  })
  const [asked] = ai.calls
  assert.match(asked.system, /auto-tagger.*dining, parking, tutoring/)
  assert.deepEqual(asked.messages, [{ role: 'user', content: 'Where is the quietest study spot?\nThe library is packed after 2pm' }])
  assert.equal(asked.maxOutputTokens, 200)
  assert.equal(asked.temperature, 0.1)
})

test('a slow tagger does not hold the post: it answers untagged after 200 ms and the tags land afterwards', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ai = scriptedAi(() => gate)
  await withApp({ ai, handlers: createHandlers(postRow({ is_anon: true })) }, async ({ call, supabase }) => {
    const answer = await call('POST', '/api/board/posts', { ...NEW_POST, anon: true })
    assert.equal(answer.status, 201)
    assert.equal(answer.body.post.anon, true)
    assert.equal(answer.body.post.user, 'Anonymous')
    assert.deepEqual(answer.body.post.tags, [])
    assert.equal(supabase.queriesOf('board_posts').length, 1, 'only the insert so far')

    release('["dining"]')
    await waitFor(() => supabase.queriesOf('board_posts').length === 2, 'the tag write')
    assert.ok(hasCall(supabase.queriesOf('board_posts')[1].chain, 'update', { tags: ['dining'] }))
  })
})

test('the tagger stands down without a Groq key and over its window, and the post is saved untagged', async () => {
  const off = scriptedAi(() => '["dining"]', { enabled: false })
  await withApp({ ai: off, handlers: createHandlers() }, async ({ call, supabase, windowHits }) => {
    const answer = await call('POST', '/api/board/posts', NEW_POST)
    assert.equal(answer.status, 201)
    assert.deepEqual(answer.body.post.tags, [])
    assert.deepEqual(windowHits, [], 'no key, so the window is not spent')
    assert.equal(supabase.queriesOf('board_posts').length, 1)
  })
  assert.equal(off.calls.length, 0)

  const spent = scriptedAi(() => '["dining"]')
  await withApp({ ai: spent, tagWindowAllows: false, handlers: createHandlers() }, async ({ call, supabase, windowHits }) => {
    const answer = await call('POST', '/api/board/posts', NEW_POST)
    assert.equal(answer.status, 201)
    assert.deepEqual(answer.body.post.tags, [])
    assert.deepEqual(windowHits, [STUDENT.id])
    assert.equal(supabase.queriesOf('board_posts').length, 1)
  })
  assert.equal(spent.calls.length, 0)
})

// ── POST /api/board/posts/:id/reply ─────────────────────────────────────────

test('a reply is validated, needs a live post, is saved with a fresh id and recounts the thread', async (t) => {
  const handlers = {
    board_posts: () => ({ data: { id: POST_ID }, error: null }),
    board_replies: (chain) => {
      const values = chain.find((c) => c.method === 'insert').args[0]
      return { data: { id: values.id, body: values.body, is_anon: values.is_anon, created_at: values.created_at }, error: null }
    },
  }
  await withApp({ handlers }, async ({ call, supabase, recounts }) => {
    const empty = await call('POST', `/api/board/posts/${POST_ID}/reply`, { body: '   ' })
    assert.deepEqual(empty.body, { error: { message: 'Reply body is required.', status: 400 } })
    const profane = await call('POST', `/api/board/posts/${POST_ID}/reply`, { body: 'what an asshole' })
    assert.equal(profane.status, 400)
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const answer = await call('POST', `/api/board/posts/${POST_ID}/reply`, { body: '  Fourth floor, east side  ' })
    assert.equal(answer.status, 201)
    const [{ chain }] = supabase.queriesOf('board_replies')
    const values = chain.find((c) => c.method === 'insert').args[0]
    assert.match(values.id, UUID_RE)
    assert.ok(!Number.isNaN(Date.parse(values.created_at)))
    assert.deepEqual(values, { id: values.id, post_id: POST_ID, user_id: STUDENT.id, body: 'Fourth floor, east side', is_anon: false, created_at: values.created_at })
    assert.deepEqual(answer.body, {
      reply: { id: values.id, body: 'Fourth floor, east side', user: 'Sam Student', anon: false, isMine: true, time: values.created_at },
    })
    assert.deepEqual(recounts, [`replies ${POST_ID}`])
    assert.ok(hasCall(supabase.queriesOf('board_posts')[0].chain, 'is', 'deleted_at', null))

    const anon = await call('POST', `/api/board/posts/${POST_ID}/reply`, { body: 'Basement', anon: 'true' })
    assert.equal(anon.body.reply.user, 'Anonymous')
  })

  // A failed recount is logged, and the saved reply still answers 201.
  const log = t.mock.method(console, 'error', () => {})
  await withApp({ handlers, replySync: { error: { message: 'rpc down' } } }, async ({ call }) => {
    assert.equal((await call('POST', `/api/board/posts/${POST_ID}/reply`, { body: 'Basement' })).status, 201)
  })
  assert.deepEqual(log.mock.calls.map((c) => c.arguments), [['board reply_count sync failed:', 'rpc down']])

  await withApp({ handlers: { board_posts: () => ({ data: null, error: null }) } }, async ({ call, supabase, recounts }) => {
    const missing = await call('POST', `/api/board/posts/${POST_ID}/reply`, { body: 'Basement' })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Post not found.', status: 404 } })
    assert.equal(supabase.queriesOf('board_replies').length, 0)
    assert.deepEqual(recounts, [])
  })
})

// ── POST /api/board/posts/:id/upvote ────────────────────────────────────────

test('upvote inserts a vote, a 23505 duplicate removes it, and each toggle recounts through the counters', async () => {
  let voteExists = false
  const handlers = {
    board_posts: () => ({ data: { id: POST_ID }, error: null }),
    board_upvotes: (chain) => {
      if (operation(chain) === 'insert') {
        if (voteExists) return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        voteExists = true
        return { data: null, error: null }
      }
      if (operation(chain) === 'delete') voteExists = false
      return { data: null, error: null }
    },
  }
  await withApp({ handlers, upvoteCounts: [4, 3] }, async ({ call, supabase, recounts }) => {
    const first = await call('POST', `/api/board/posts/${POST_ID}/upvote`)
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { upvotes: 4, upvotedByMe: true })
    const values = supabase.queriesOf('board_upvotes')[0].chain.find((c) => c.method === 'insert').args[0]
    assert.equal(values.post_id, POST_ID)
    assert.equal(values.user_id, STUDENT.id)
    assert.ok(!Number.isNaN(Date.parse(values.created_at)), 'the vote row carries an ISO timestamp')

    const second = await call('POST', `/api/board/posts/${POST_ID}/upvote`)
    assert.deepEqual(second.body, { upvotes: 3, upvotedByMe: false })
    const removal = supabase.queriesOf('board_upvotes').find((q) => operation(q.chain) === 'delete')
    assert.ok(hasCall(removal.chain, 'eq', 'post_id', POST_ID))
    assert.ok(hasCall(removal.chain, 'eq', 'user_id', STUDENT.id))
    assert.deepEqual(recounts, [`upvotes ${POST_ID}`, `upvotes ${POST_ID}`])
    assert.ok(hasCall(supabase.queriesOf('board_posts')[0].chain, 'is', 'deleted_at', null), 'a deleted post cannot be upvoted')
  })
  await withApp({ handlers: { board_posts: () => ({ data: null, error: null }) } }, async ({ call, supabase, recounts }) => {
    const missing = await call('POST', `/api/board/posts/${POST_ID}/upvote`)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Post not found.', status: 404 } })
    assert.equal(supabase.queriesOf('board_upvotes').length, 0)
    assert.deepEqual(recounts, [])
  })
})

// ── PATCH /api/board/posts/:id ──────────────────────────────────────────────

test('an edit is owner only, even for an admin, stamps edited_at, and 404s a post that is not theirs or is gone', async () => {
  let rows = null
  const handlers = {
    board_posts: (chain) => {
      const values = chain.find((c) => c.method === 'update').args[0]
      return { data: rows ?? [postRow({ title: values.title, body: values.body, edited_at: values.edited_at })], error: null }
    },
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const invalid = await call('PATCH', `/api/board/posts/${POST_ID}`, { title: '', body: 'x' })
    assert.deepEqual(invalid.body, { error: { message: 'Title is required.', status: 400 } })
    const profane = await call('PATCH', `/api/board/posts/${POST_ID}`, { title: 'Help', body: 'what an asshole' })
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const answer = await call('PATCH', `/api/board/posts/${POST_ID}`, { title: ' Quiet floors? ', body: ' Any tips ' })
    assert.equal(answer.status, 200)
    const [{ chain }] = supabase.queriesOf('board_posts')
    const values = chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(values), ['title', 'body', 'edited_at', 'updated_at'])
    assert.equal(values.edited_at, values.updated_at)
    assert.ok(hasCall(chain, 'eq', 'id', POST_ID))
    assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'select', '*'))
    assert.deepEqual(answer.body, { post: { id: POST_ID, title: 'Quiet floors?', body: 'Any tips', editedTime: values.edited_at } })
  })
  await withApp({ user: ADMIN, handlers }, async ({ call, supabase }) => {
    rows = []
    const answer = await call('PATCH', `/api/board/posts/${POST_ID}`, { title: 'Quiet floors?', body: '' })
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Post not found or you can only edit your own posts.', status: 404 } })
    assert.ok(hasCall(supabase.queriesOf('board_posts')[0].chain, 'eq', 'user_id', ADMIN.id), 'no admin bypass on edit')
  })
})

test('an edit retries without edited_at when that optional column is not there yet', async () => {
  const handlers = {
    board_posts: (chain) => {
      const values = chain.find((c) => c.method === 'update').args[0]
      if ('edited_at' in values) {
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'edited_at' column of 'board_posts' in the schema cache" } }
      }
      const row = postRow({ title: values.title, body: values.body })
      delete row.edited_at
      return { data: [row], error: null }
    },
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('PATCH', `/api/board/posts/${POST_ID}`, { title: 'Quiet floors?', body: 'Any tips' })
    assert.equal(answer.status, 200)
    const [first, retry] = supabase.queriesOf('board_posts')
    const firstValues = first.chain.find((c) => c.method === 'update').args[0]
    const retryValues = retry.chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(retryValues), ['title', 'body', 'updated_at'])
    assert.equal(retryValues.updated_at, firstValues.edited_at)
    assert.ok(hasCall(retry.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(retry.chain, 'is', 'deleted_at', null))
    assert.deepEqual(answer.body, { post: { id: POST_ID, title: 'Quiet floors?', body: 'Any tips', editedTime: firstValues.edited_at } })
  })
})

// ── DELETE /api/board/posts/:id ─────────────────────────────────────────────

test('delete is a soft delete through ownerOrAdminScope: a student is scoped to their posts, an admin is not', async () => {
  let rows = [{ id: POST_ID }]
  const handlers = { board_posts: () => ({ data: rows, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/board/posts/${POST_ID}`)
    assert.equal(answer.status, 204)
    const [{ chain }] = supabase.queriesOf('board_posts')
    const values = chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(values), ['deleted_at'])
    assert.ok(!Number.isNaN(Date.parse(values.deleted_at)))
    assert.ok(hasCall(chain, 'eq', 'id', POST_ID))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(chain, 'select', 'id'))

    rows = []
    const missing = await call('DELETE', `/api/board/posts/${POST_ID}`)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Post not found or you can only delete your own posts.', status: 404 } })
  })
  rows = [{ id: POST_ID }]
  await withApp({ user: ADMIN, handlers }, async ({ call, supabase }) => {
    assert.equal((await call('DELETE', `/api/board/posts/${POST_ID}`)).status, 204)
    assert.ok(!hasCall(supabase.queriesOf('board_posts')[0].chain, 'eq', 'user_id'), 'an admin takedown has no owner filter')
  })
})

// ── Failures ────────────────────────────────────────────────────────────────

test('database failures: board_schema_missing for a missing table or deleted_at column, 500 otherwise', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const schemaMissing = { error: { message: 'The campus board is not set up yet. Please try again later.', code: 'board_schema_missing', status: 503 } }
  const fallback = { error: { message: 'Something went wrong. Please try again.', status: 500 } }

  const noTable = { board_posts: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.board_posts' in the schema cache" } }) }
  await withApp({ handlers: noTable }, async ({ call }) => {
    const answer = await call('GET', '/api/board/posts')
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, schemaMissing)
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-board-only\.sql/)

  const noColumn = { board_posts: () => ({ data: null, error: { code: '42703', message: 'column board_posts.deleted_at does not exist' } }) }
  await withApp({ handlers: noColumn }, async ({ call }) => {
    const answer = await call('DELETE', `/api/board/posts/${POST_ID}`)
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, schemaMissing)
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-soft-delete\.sql/, 'the log names the soft-delete migration')

  const brokenInsert = { board_posts: () => ({ data: null, error: { code: '23514', message: 'check constraint' } }) }
  await withApp({ handlers: brokenInsert }, async ({ call }) => {
    const answer = await call('POST', '/api/board/posts', NEW_POST)
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, fallback)
  })

  const brokenBlocks = { blocked_users: () => ({ data: null, error: { code: 'XX000', message: 'blocks unavailable' } }) }
  await withApp({ handlers: brokenBlocks }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/board/posts')
    assert.equal(answer.status, 500, 'a failed block lookup fails the read rather than show blocked users')
    assert.deepEqual(answer.body, fallback)
    assert.equal(supabase.queriesOf('board_posts').length, 0)
  })
})

test('a malformed :id answers the 404 envelope before any query', async () => {
  await withApp({ user: ADMIN }, async ({ call, supabase }) => {
    for (const [method, path] of [
      ['GET', '/api/board/posts/not-a-uuid/replies'],
      ['POST', '/api/board/posts/not-a-uuid/reply'],
      ['POST', '/api/board/posts/not-a-uuid/upvote'],
      ['PATCH', '/api/board/posts/not-a-uuid'],
      ['DELETE', '/api/board/posts/not-a-uuid'],
    ]) {
      const answer = await call(method, path, method === 'POST' || method === 'PATCH' ? { title: 'Quiet floors?', body: 'Any tips' } : undefined)
      assert.equal(answer.status, 404, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})
