import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAdminReportsRouter } from '../../src/routes/adminReports.mjs'
import { fakeSupabase, hasCall } from './fakeSupabase.mjs'

// Issue #192: the admin report queue, booted on a small app with a fake
// session, a fake admin gate, a recording limiter and a recording database.

const ADMIN = { id: '99999999-9999-4999-8999-999999999999', email: 'admin@purdue.edu', is_admin: true }
const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@purdue.edu' }
const REPORTER = '22222222-2222-4222-8222-222222222222'
const AUTHOR = '33333333-3333-4333-8333-333333333333'
const POST = '44444444-4444-4444-8444-444444444444'
const LISTING = '55555555-5555-4555-8555-555555555555'
const GROUP = '66666666-6666-4666-8666-666666666666'
const REPORT_ID = '77777777-7777-4777-8777-777777777777'

function reportRow(overrides = {}) {
  return {
    id: REPORT_ID,
    target_type: 'board_post',
    target_id: POST,
    reporter_id: REPORTER,
    reason: 'harassment',
    details: 'names a classmate',
    status: 'open',
    created_at: '2026-09-27T10:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  }
}

async function withApp({ user = ADMIN, handlers = {} } = {}, run) {
  const supabase = fakeSupabase({ content_reports: () => ({ data: [], error: null }), users: () => ({ data: [], error: null }), ...handlers })
  const limiterHits = []
  const app = express()
  app.use(express.json())
  app.use(
    createAdminReportsRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      // Same gate as server.mjs requireAdmin.
      requireAdmin: (req, res, next) => {
        if (req.currentUser?.is_admin !== true) return res.status(403).json({ error: { message: 'Admin access required.', status: 403 } })
        next()
      },
      adminWriteRateLimit: (req, _res, next) => {
        limiterHits.push(`${req.method} ${req.path}`)
        next()
      },
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
    return { status: response.status, body: await response.json() }
  }
  try {
    await run({ call, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('both routes answer 401 signed out and 403 for a student, before any query', async () => {
  for (const [user, status] of [[null, 401], [STUDENT, 403]]) {
    await withApp({ user }, async ({ call, supabase }) => {
      const list = await call('GET', '/api/admin/reports')
      assert.equal(list.status, status)
      const patch = await call('PATCH', `/api/admin/reports/${REPORT_ID}`, { status: 'resolved' })
      assert.equal(patch.status, status)
      assert.equal(supabase.queries.length, 0)
    })
  }
})

test('the queue defaults to open reports, newest first, and takes another status when asked', async () => {
  await withApp({}, async ({ call, supabase }) => {
    assert.deepEqual((await call('GET', '/api/admin/reports')).body, { reports: [] })
    const [{ chain }] = supabase.queriesOf('content_reports')
    assert.ok(hasCall(chain, 'eq', 'status', 'open'))
    assert.ok(hasCall(chain, 'order', 'created_at', { ascending: false }))
    assert.ok(hasCall(chain, 'limit', 200))
    assert.equal(supabase.queriesOf('users').length, 0, 'no name lookup for an empty page')

    await call('GET', '/api/admin/reports?status=dismissed')
    assert.ok(hasCall(supabase.queriesOf('content_reports')[1].chain, 'eq', 'status', 'dismissed'))

    const bad = await call('GET', '/api/admin/reports?status=pending')
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.body, { error: { message: 'Status must be open, resolved or dismissed.', status: 400 } })
  })
})

test('each report carries its reporter and the reported thing: title, author, deleted and hidden', async () => {
  const handlers = {
    content_reports: () => ({
      data: [
        reportRow(),
        reportRow({ id: 'r2', target_type: 'marketplace', target_id: LISTING, reason: 'scam', details: '' }),
        reportRow({ id: 'r3', target_type: 'user', target_id: AUTHOR, reason: 'spam' }),
        reportRow({ id: 'r4', target_type: 'guide', target_id: POST }),
      ],
      error: null,
    }),
    board_posts: () => ({ data: [{ id: POST, title: 'Selling notes', user_id: AUTHOR, deleted_at: '2026-09-27T11:00:00.000Z' }], error: null }),
    marketplace_listings: () => ({ data: [{ id: LISTING, title: 'Mini fridge', user_id: AUTHOR, deleted_at: null, hidden: true }], error: null }),
    guide_recommendations: () => ({ data: [], error: null }),
    // Both the user target lookup and the name lookup read users.
    users: () => ({ data: [{ id: REPORTER, display_name: 'Riley' }, { id: AUTHOR, display_name: 'Avery' }], error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/admin/reports')
    assert.equal(answer.status, 200)
    const [post, listing, user, gone] = answer.body.reports
    assert.deepEqual(post, {
      id: REPORT_ID,
      targetType: 'board_post',
      targetId: POST,
      reason: 'harassment',
      details: 'names a classmate',
      status: 'open',
      createdAt: '2026-09-27T10:00:00.000Z',
      reporter: { id: REPORTER, displayName: 'Riley' },
      target: { title: 'Selling notes', authorId: AUTHOR, authorName: 'Avery', deleted: true, hidden: false },
    })
    assert.deepEqual(listing.target, { title: 'Mini fridge', authorId: AUTHOR, authorName: 'Avery', deleted: false, hidden: true })
    assert.deepEqual(user.target, { title: 'Avery', authorId: AUTHOR, authorName: 'Avery', deleted: false, hidden: false })
    assert.equal(gone.target, null, 'a purged target reads as null')

    const [posts] = supabase.queriesOf('board_posts')
    assert.ok(hasCall(posts.chain, 'select', 'id, title, user_id, deleted_at'))
    assert.ok(hasCall(posts.chain, 'in', 'id', [POST]))
    const [listings] = supabase.queriesOf('marketplace_listings')
    assert.ok(hasCall(listings.chain, 'select', 'id, title, user_id, deleted_at, hidden'))
    // The user target is read first, then one lookup names every reporter and author.
    const [userTarget, names] = supabase.queriesOf('users')
    assert.ok(hasCall(userTarget.chain, 'in', 'id', [AUTHOR]))
    assert.ok(hasCall(names.chain, 'select', 'id, display_name'))
    assert.deepEqual(new Set(names.chain.find((c) => c.method === 'in').args[1]), new Set([REPORTER, AUTHOR]))
  })
})

test('a target table that is not installed reads as no target; study groups without deleted_at are read without it', async () => {
  const handlers = {
    content_reports: () => ({
      data: [reportRow({ target_type: 'lost_found', target_id: POST }), reportRow({ id: 'r2', target_type: 'study_group', target_id: GROUP })],
      error: null,
    }),
    lost_found_items: () => ({ data: null, error: { code: '42P01', message: 'relation "public.lost_found_items" does not exist' } }),
    study_groups: (chain) =>
      hasCall(chain, 'select', 'id, title, creator_id, deleted_at')
        ? { data: null, error: { code: '42703', message: 'column study_groups.deleted_at does not exist' } }
        : { data: [{ id: GROUP, title: 'CS 18000 cram', creator_id: AUTHOR }], error: null },
    users: () => ({ data: [{ id: AUTHOR, display_name: 'Avery' }], error: null }),
  }
  await withApp({ handlers }, async ({ call }) => {
    const answer = await call('GET', '/api/admin/reports')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.reports[0].target, null)
    assert.deepEqual(answer.body.reports[1].target, { title: 'CS 18000 cram', authorId: AUTHOR, authorName: 'Avery', deleted: false, hidden: false })
    assert.equal(answer.body.reports[0].reporter.displayName, null, 'an unnamed reporter reads as null')
  })
})

test('resolve and dismiss close an open report for the admin, behind the admin-write limiter', async () => {
  let rows = [{ id: REPORT_ID }]
  const handlers = { content_reports: () => ({ data: rows, error: null }) }
  await withApp({ handlers }, async ({ call, supabase, limiterHits }) => {
    const resolved = await call('PATCH', `/api/admin/reports/${REPORT_ID}`, { status: 'resolved' })
    assert.equal(resolved.status, 200)
    assert.deepEqual(resolved.body, { ok: true, status: 'resolved' })
    const [{ chain }] = supabase.queriesOf('content_reports')
    const values = chain.find((c) => c.method === 'update').args[0]
    assert.equal(values.status, 'resolved')
    assert.equal(values.resolved_by, ADMIN.id)
    assert.ok(!Number.isNaN(Date.parse(values.resolved_at)))
    assert.ok(hasCall(chain, 'eq', 'id', REPORT_ID))
    assert.ok(hasCall(chain, 'eq', 'status', 'open'), 'only an open report moves')

    assert.deepEqual((await call('PATCH', `/api/admin/reports/${REPORT_ID}`, { status: 'dismissed' })).body, { ok: true, status: 'dismissed' })

    const reopen = await call('PATCH', `/api/admin/reports/${REPORT_ID}`, { status: 'open' })
    assert.equal(reopen.status, 400)
    assert.deepEqual(reopen.body, { error: { message: 'Status must be resolved or dismissed.', status: 400 } })

    rows = []
    const closed = await call('PATCH', `/api/admin/reports/${REPORT_ID}`, { status: 'resolved' })
    assert.equal(closed.status, 404)
    assert.deepEqual(closed.body, { error: { message: 'No open report with that id.', status: 404 } })

    const malformed = await call('PATCH', '/api/admin/reports/not-a-uuid', { status: 'resolved' })
    assert.equal(malformed.status, 404)
    assert.deepEqual(malformed.body, { error: { message: 'Not found.', status: 404 } })
    assert.equal(limiterHits.length, 5)
  })
})

test('a missing content_reports table answers 503 content_reports_schema_missing', async (t) => {
  t.mock.method(console, 'error', () => {})
  const handlers = { content_reports: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.content_reports' in the schema cache" } }) }
  await withApp({ handlers }, async ({ call }) => {
    const answer = await call('GET', '/api/admin/reports')
    assert.equal(answer.status, 503)
    assert.equal(answer.body.error.code, 'content_reports_schema_missing')
  })
  const broken = { content_reports: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) }
  await withApp({ handlers: broken }, async ({ call }) => {
    const answer = await call('GET', '/api/admin/reports')
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not load the reports. Please try again.', status: 500 } })
  })
})
