import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createReportsRouter } from '../../src/routes/reports.mjs'
import { REPORT_TARGETS } from '../../src/contentReports.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #192: POST /api/reports, one route for every surface students post
// to, booted on a small app with a fake session, a recording limiter and a
// recording database.

const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'me@purdue.edu' }
const AUTHOR = '22222222-2222-4222-8222-222222222222'
const TARGET = '66666666-6666-4666-8666-666666666666'

async function withApp({ user = ME, handlers = {} } = {}, run) {
  const supabase = fakeSupabase({ content_reports: () => ({ data: null, error: null }), ...handlers })
  const limiterHits = []
  const app = express()
  app.use(express.json())
  app.use(
    createReportsRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      reportRateLimit: (req, _res, next) => {
        limiterHits.push(`${req.method} ${req.path}`)
        next()
      },
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const report = async (body) => {
    const response = await fetch(`${base}/api/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  try {
    await run({ report, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// A live row by the other author in every target table.
function tablesWith(row = (config) => ({ id: TARGET, [config.authorColumn]: AUTHOR })) {
  const handlers = {}
  for (const config of Object.values(REPORT_TARGETS)) {
    handlers[config.table] = () => ({ data: row(config), error: null })
  }
  return handlers
}

test('the route sits behind the report limiter and requireAuth', async () => {
  await withApp({ user: null }, async ({ report, supabase, limiterHits }) => {
    const answer = await report({ targetType: 'board_post', targetId: TARGET, reason: 'spam' })
    assert.equal(answer.status, 401)
    assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    assert.deepEqual(limiterHits, ['POST /api/reports'], 'the limiter runs first, so a signed-out flood is metered too')
    assert.equal(supabase.queries.length, 0)
  })
})

test('a bad body answers the parser\'s 400 before any query', async () => {
  await withApp({}, async ({ report, supabase }) => {
    for (const [body, message] of [
      [{ targetType: 'comment', targetId: TARGET, reason: 'spam' }, 'Choose what you are reporting.'],
      [{ targetType: 'guide', targetId: 'abc', reason: 'spam' }, 'That id is not valid.'],
      [{ targetType: 'guide', targetId: TARGET }, 'Choose a reason for the report.'],
      [{ targetType: 'guide', targetId: TARGET, reason: 'rude' }, 'Reason must be one of: spam, scam, harassment, prohibited, other.'],
    ]) {
      const answer = await report(body)
      assert.equal(answer.status, 400, message)
      assert.deepEqual(answer.body, { error: { message, status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('nobody can report themselves or their own content', async () => {
  await withApp({ handlers: tablesWith() }, async ({ report, supabase }) => {
    const self = await report({ targetType: 'user', targetId: ME.id.toUpperCase(), reason: 'spam' })
    assert.equal(self.status, 400)
    assert.deepEqual(self.body, { error: { message: 'You cannot report yourself.', status: 400 } })
    assert.equal(supabase.queries.length, 0)
  })
  await withApp({ handlers: tablesWith((config) => ({ id: TARGET, [config.authorColumn]: ME.id })) }, async ({ report, supabase }) => {
    for (const targetType of ['board_post', 'board_reply', 'lost_found', 'guide', 'study_group', 'marketplace']) {
      const answer = await report({ targetType, targetId: TARGET, reason: 'spam' })
      assert.equal(answer.status, 400, targetType)
      assert.deepEqual(answer.body, { error: { message: 'You cannot report your own content.', status: 400 } })
    }
    assert.equal(supabase.queriesOf('content_reports').length, 0)
    assert.equal(supabase.queriesOf('marketplace_reports').length, 0)
  })
})

test('a deleted or unknown target is a 404; soft-deleting tables are read live, the others plainly', async () => {
  await withApp({ handlers: tablesWith(() => null) }, async ({ report, supabase }) => {
    for (const targetType of Object.keys(REPORT_TARGETS)) {
      const answer = await report({ targetType, targetId: TARGET, reason: 'spam' })
      assert.equal(answer.status, 404, targetType)
      assert.deepEqual(answer.body, { error: { message: 'That content is no longer available.', status: 404 } })
    }
    for (const config of Object.values(REPORT_TARGETS)) {
      const [lookup] = supabase.queriesOf(config.table)
      assert.ok(hasCall(lookup.chain, 'eq', 'id', TARGET), config.table)
      assert.equal(hasCall(lookup.chain, 'is', 'deleted_at', null), config.softDelete, `${config.table} live filter`)
    }
    assert.equal(supabase.queriesOf('content_reports').length, 0)
  })
})

test('a study group is still found before its deleted_at migration runs', async () => {
  const handlers = {
    study_groups: (chain) =>
      hasCall(chain, 'is', 'deleted_at', null)
        ? { data: null, error: { code: '42703', message: 'column study_groups.deleted_at does not exist' } }
        : { data: { id: TARGET, creator_id: AUTHOR }, error: null },
  }
  await withApp({ handlers }, async ({ report, supabase }) => {
    const answer = await report({ targetType: 'study_group', targetId: TARGET, reason: 'harassment' })
    assert.deepEqual(answer.body, { ok: true })
    assert.equal(supabase.queriesOf('study_groups').length, 2)
  })
})

test('a report on anything but a listing is one content_reports row; a second one is a duplicate', async () => {
  let duplicate = false
  const handlers = {
    ...tablesWith(),
    content_reports: () => ({ data: null, error: duplicate ? { code: '23505', message: 'duplicate key value' } : null }),
  }
  await withApp({ handlers }, async ({ report, supabase }) => {
    const answer = await report({ targetType: 'board_reply', targetId: TARGET.toUpperCase(), reason: 'harassment', details: '  keeps naming me  ' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    const [{ chain }] = supabase.queriesOf('content_reports')
    const row = chain.find((c) => c.method === 'insert').args[0]
    assert.deepEqual(
      { ...row, created_at: typeof row.created_at },
      { target_type: 'board_reply', target_id: TARGET, reporter_id: ME.id, reason: 'harassment', details: 'keeps naming me', created_at: 'string' },
    )
    assert.equal(supabase.queriesOf('marketplace_reports').length, 0)

    duplicate = true
    const again = await report({ targetType: 'board_reply', targetId: TARGET, reason: 'spam' })
    assert.equal(again.status, 200)
    assert.deepEqual(again.body, { ok: true, duplicate: true })
  })
})

test('a user can be reported, and the answer never names an author', async () => {
  await withApp({ handlers: tablesWith() }, async ({ report, supabase }) => {
    const answer = await report({ targetType: 'user', targetId: AUTHOR, reason: 'harassment' })
    assert.deepEqual(answer.body, { ok: true })
    const [lookup] = supabase.queriesOf('users')
    assert.ok(hasCall(lookup.chain, 'select', 'id'))
    const anonymousPost = await report({ targetType: 'board_post', targetId: TARGET, reason: 'spam' })
    assert.deepEqual(anonymousPost.body, { ok: true }, 'only ok, never who wrote it')
  })
})

test('a listing report goes through recordListingReport and hides the listing at the third reporter', async () => {
  let reporters = 0
  const handlers = {
    marketplace_listings: (chain) => (operation(chain) === 'update' ? { data: null, error: null } : { data: { id: TARGET, user_id: AUTHOR }, error: null }),
    marketplace_reports: (chain) => {
      if (operation(chain) === 'insert') {
        reporters += 1
        return { data: null, error: reporters > 3 ? { code: '23505', message: 'duplicate key value' } : null }
      }
      return { count: reporters, error: null }
    },
  }
  await withApp({ handlers }, async ({ report, supabase }) => {
    assert.deepEqual((await report({ targetType: 'marketplace', targetId: TARGET, reason: 'scam', details: 'asked for a deposit' })).body, { ok: true })
    assert.deepEqual((await report({ targetType: 'marketplace', targetId: TARGET, reason: 'scam' })).body, { ok: true })
    assert.equal(supabase.queriesOf('marketplace_listings').filter((q) => operation(q.chain) === 'update').length, 0)
    assert.deepEqual((await report({ targetType: 'marketplace', targetId: TARGET, reason: 'spam' })).body, { ok: true })
    const hide = supabase.queriesOf('marketplace_listings').find((q) => operation(q.chain) === 'update')
    assert.ok(hasCall(hide.chain, 'update', { hidden: true }))
    const first = supabase.queriesOf('marketplace_reports')[0].chain.find((c) => c.method === 'insert').args[0]
    assert.equal(first.reason, 'scam: asked for a deposit')
    assert.equal(supabase.queriesOf('content_reports').length, 3, 'each report also reaches the queue')

    assert.deepEqual((await report({ targetType: 'marketplace', targetId: TARGET, reason: 'spam' })).body, { ok: true, duplicate: true })
  })
})

test('a missing table answers 503 content_reports_schema_missing, any other failure the 500', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const noQueue = { ...tablesWith(), content_reports: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.content_reports' in the schema cache" } }) }
  await withApp({ handlers: noQueue }, async ({ report }) => {
    const answer = await report({ targetType: 'guide', targetId: TARGET, reason: 'spam' })
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, { error: { message: 'Reporting content is not set up yet. Please try again later.', code: 'content_reports_schema_missing', status: 503 } })
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-report-and-block\.sql/)

  const broken = { ...tablesWith(), content_reports: () => ({ data: null, error: { code: '23514', message: 'check constraint' } }) }
  await withApp({ handlers: broken }, async ({ report }) => {
    const answer = await report({ targetType: 'guide', targetId: TARGET, reason: 'spam' })
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not send the report. Please try again.', status: 500 } })
  })
})
