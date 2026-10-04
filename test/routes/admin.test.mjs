import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAdminRouter } from '../../src/routes/admin.mjs'
import { mapAdminAdvertiserRow, mapAdminCampaignRow, mapLeadRow } from '../../src/adminPortal.mjs'
import { createFinalErrorHandler } from '../../src/finalErrorHandler.mjs'
import { verifyPassword } from '../../src/passwordHash.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the platform admin routes as a feature router, booted on a small
// app with a fake session, a fake admin gate, a recording limiter, a recording
// database, a recording Purdue link release and the real final error handler
// mounted after the router, as server.mjs mounts it after every router.

const ADMIN = { id: '99999999-9999-4999-8999-999999999999', email: 'admin@purdue.edu', is_admin: true }
const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@purdue.edu' }
const LEAD = '22222222-2222-4222-8222-222222222222'
const CAMPAIGN = '33333333-3333-4333-8333-333333333333'
const ADVERTISER = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'
const USER_2 = '56565656-5656-4565-8565-565656565656'
const ITEM = '66666666-6666-4666-8666-666666666666'
const LISTING = '77777777-7777-4777-8777-777777777777'
const LISTING_2 = '78787878-7878-4787-8787-787878787878'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The two lines of server.mjs normalizeEmail, which the auth code keeps.
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function fakeLog() {
  const lines = { warn: [], error: [] }
  return {
    lines,
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
  }
}

async function withApp({ user = ADMIN, handlers = {} } = {}, run) {
  const supabase = fakeSupabase(handlers)
  const limiterHits = []
  const cleared = []
  const log = fakeLog()
  const app = express()
  app.use(express.json())
  app.use(
    createAdminRouter({
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
      normalizeEmail,
      clearPurdueLinkOnUser: async (userId) => {
        cleared.push(userId)
      },
    }),
  )
  app.use(createFinalErrorHandler({ log }))
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
    await run({ call, supabase, limiterHits, cleared, log })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// A body every write would accept, so a missing gate would reach the database.
const WRITE_BODY = {
  status: 'contacted',
  email: 'ads@bean.example',
  password: 'correct horse battery',
  companyName: 'Bean There',
  purdueEmail: 'pete@purdue.edu',
}
const bodyFor = (method) => (method === 'GET' || method === 'DELETE' ? undefined : WRITE_BODY)

// All sixteen routes, with valid ids. The eight writes carry the admin-write limiter.
const READS = [
  ['GET', '/api/admin/overview'],
  ['GET', '/api/admin/leads'],
  ['GET', '/api/admin/campaigns'],
  ['GET', '/api/admin/advertisers'],
  ['GET', '/api/admin/deleted/board'],
  ['GET', `/api/admin/content/board/${ITEM}`],
  ['GET', '/api/admin/hidden/marketplace'],
  ['GET', '/api/admin/sentry-test?confirm=1'],
]
const WRITES = [
  ['PATCH', `/api/admin/leads/${LEAD}`],
  ['PATCH', `/api/admin/campaigns/${CAMPAIGN}`],
  ['POST', '/api/admin/advertisers'],
  ['POST', '/api/admin/purdue-links/clear'],
  ['POST', `/api/admin/deleted/board/${ITEM}/restore`],
  ['DELETE', `/api/admin/deleted/board/${ITEM}`],
  ['POST', `/api/admin/hidden/marketplace/${LISTING}/unhide`],
  ['POST', `/api/admin/hidden/marketplace/${LISTING}/takedown`],
]

test('all sixteen routes answer 401 signed out and 403 for a student with no query, and only the eight writes pass the limiter, ahead of auth', async () => {
  for (const [user, status, message] of [
    [null, 401, 'You must sign in to access this resource.'],
    [STUDENT, 403, 'Admin access required.'],
  ]) {
    await withApp({ user }, async ({ call, supabase, limiterHits, cleared, log }) => {
      for (const [method, path] of [...READS, ...WRITES]) {
        const answer = await call(method, path, bodyFor(method))
        assert.equal(answer.status, status, `${method} ${path}`)
        assert.deepEqual(answer.body, { error: { message, status } }, `${method} ${path}`)
      }
      assert.equal(supabase.queries.length, 0)
      assert.deepEqual(cleared, [])
      assert.deepEqual(log.lines.error, [], 'the Sentry test never raised')
      assert.deepEqual(limiterHits, WRITES.map(([method, path]) => `${method} ${path}`))
    })
  }
})

const MALFORMED = [
  ['PATCH', '/api/admin/leads/not-a-uuid'],
  ['PATCH', '/api/admin/campaigns/not-a-uuid'],
  ['GET', '/api/admin/content/board/not-a-uuid'],
  ['POST', '/api/admin/deleted/board/not-a-uuid/restore'],
  ['DELETE', '/api/admin/deleted/board/not-a-uuid'],
  ['POST', '/api/admin/hidden/marketplace/not-a-uuid/unhide'],
  ['POST', '/api/admin/hidden/marketplace/not-a-uuid/takedown'],
]

test('a malformed :id answers 404 Not found. before auth on all seven :id routes, after the limiter on the six writes', async () => {
  for (const user of [null, ADMIN]) {
    await withApp({ user }, async ({ call, supabase, limiterHits }) => {
      for (const [method, path] of MALFORMED) {
        const answer = await call(method, path, bodyFor(method))
        assert.equal(answer.status, 404, `${method} ${path}`)
        assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } }, `${method} ${path}`)
      }
      assert.equal(supabase.queries.length, 0)
      assert.deepEqual(
        limiterHits,
        MALFORMED.filter(([method]) => method !== 'GET').map(([method, path]) => `${method} ${path}`),
      )
    })
  }
})

// ---- Overview -----------------------------------------------------------------

const HEAD_COUNT = { method: 'select', args: ['*', { count: 'exact', head: true }] }

test('the overview counts new leads, pending and active campaigns and advertisers', async () => {
  const handlers = {
    advertiser_leads: () => ({ count: 3, error: null }),
    campaigns: (chain) => ({ count: hasCall(chain, 'eq', 'status', 'active') ? 5 : 2, error: null }),
    // No rows reads as 0.
    advertisers: () => ({ count: null, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/admin/overview')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { overview: { newLeads: 3, pendingCampaigns: 2, activeCampaigns: 5, advertisers: 0 } })
    const [leads] = supabase.queriesOf('advertiser_leads')
    assert.deepEqual(leads.chain, [HEAD_COUNT, { method: 'eq', args: ['status', 'new'] }])
    const [pending, active] = supabase.queriesOf('campaigns')
    assert.deepEqual(pending.chain, [HEAD_COUNT, { method: 'eq', args: ['status', 'pending_review'] }])
    assert.deepEqual(active.chain, [HEAD_COUNT, { method: 'eq', args: ['status', 'active'] }])
    const [advertisers] = supabase.queriesOf('advertisers')
    assert.deepEqual(advertisers.chain, [HEAD_COUNT])
  })
})

test('a missing advertiser table answers 503 advertiser_schema_missing; another error answers the 500 fallback', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.advertiser_leads' in the schema cache (admin overview)" }
  const handlers = {
    advertiser_leads: () => ({ count: null, error: missing }),
    campaigns: () => ({ count: 0, error: null }),
    advertisers: () => ({ count: 0, error: null }),
  }
  await withApp({ handlers }, async ({ call }) => {
    const answer = await call('GET', '/api/admin/overview')
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, {
      error: { message: 'The advertiser portal is not set up yet. Please try again later.', code: 'advertiser_schema_missing', status: 503 },
    })
  })
  assert.equal(logged.mock.calls.length, 1)
  assert.match(logged.mock.calls[0].arguments[0], /run db\/supabase-advertiser-portal\.sql and db\/supabase-advertiser-campaigns\.sql/)

  const broken = { advertisers: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) }
  await withApp({ handlers: broken }, async ({ call }) => {
    const answer = await call('GET', '/api/admin/advertisers')
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Something went wrong. Please try again.', status: 500 } })
  })
})

// ---- Leads and campaigns ------------------------------------------------------

const NEWEST_200 = [
  { method: 'order', args: ['created_at', { ascending: false }] },
  { method: 'limit', args: [200] },
]

function leadRow(overrides = {}) {
  return {
    id: LEAD,
    email: 'owner@bean.example',
    company_name: 'Bean There',
    message: 'We would like a spot on the home screen.',
    status: 'new',
    created_at: '2026-10-01T12:00:00.000Z',
    ...overrides,
  }
}

function campaignRow(overrides = {}) {
  return {
    id: CAMPAIGN,
    advertiser_id: ADVERTISER,
    name: 'Fall latte promo',
    placement: 'home-widget',
    status: 'pending_review',
    starts_on: '2026-10-05',
    ends_on: '2026-10-31',
    creative: { headline: 'Two for one' },
    created_at: '2026-10-01T12:00:00.000Z',
    updated_at: '2026-10-01T12:00:00.000Z',
    advertisers: { email: 'owner@bean.example', company_name: 'Bean There' },
    ...overrides,
  }
}

test('leads list newest first, at most 200, and filter by status only when one is given', async () => {
  const handlers = { advertiser_leads: () => ({ data: [leadRow()], error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/admin/leads')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { leads: [mapLeadRow(leadRow())] })
    await call('GET', '/api/admin/leads?status=all')
    await call('GET', '/api/admin/leads?status=new')
    const [plain, all, onlyNew] = supabase.queriesOf('advertiser_leads')
    assert.deepEqual(plain.chain, [{ method: 'select', args: ['*'] }, ...NEWEST_200])
    assert.deepEqual(all.chain, plain.chain)
    assert.deepEqual(onlyNew.chain, [...plain.chain, { method: 'eq', args: ['status', 'new'] }])

    const bogus = await call('GET', '/api/admin/leads?status=bogus')
    assert.equal(bogus.status, 400)
    assert.deepEqual(bogus.body, { error: { message: 'Invalid filter. Use one of: all, new, contacted, closed.', status: 400 } })
    assert.equal(supabase.queries.length, 3, 'a bad filter runs no query')
  })
})

test('campaigns list with their advertiser, newest first, at most 200, filtered by status only when one is given', async () => {
  const handlers = { campaigns: () => ({ data: [campaignRow()], error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/admin/campaigns?status=pending_review')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { campaigns: [mapAdminCampaignRow(campaignRow())] })
    assert.equal(answer.body.campaigns[0].advertiserEmail, 'owner@bean.example')
    await call('GET', '/api/admin/campaigns')
    const [filtered, plain] = supabase.queriesOf('campaigns')
    assert.deepEqual(plain.chain, [{ method: 'select', args: ['*, advertisers ( email, company_name )'] }, ...NEWEST_200])
    assert.deepEqual(filtered.chain, [...plain.chain, { method: 'eq', args: ['status', 'pending_review'] }])

    const bogus = await call('GET', '/api/admin/campaigns?status=bogus')
    assert.equal(bogus.status, 400)
    assert.deepEqual(bogus.body, {
      error: { message: 'Invalid filter. Use one of: all, draft, pending_review, active, paused, ended.', status: 400 },
    })
    assert.equal(supabase.queries.length, 2, 'a bad filter runs no query')
  })
})

test('PATCH a lead validates the status, updates that row and answers 404 Lead not found. when none matched', async () => {
  let row = leadRow({ status: 'contacted' })
  const handlers = { advertiser_leads: () => ({ data: row, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const invalid = await call('PATCH', `/api/admin/leads/${LEAD}`, { status: 'archived' })
    assert.equal(invalid.status, 400)
    assert.deepEqual(invalid.body, { error: { message: 'Lead status must be one of: new, contacted, closed.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const updated = await call('PATCH', `/api/admin/leads/${LEAD}`, { status: ' contacted ' })
    assert.equal(updated.status, 200)
    assert.deepEqual(updated.body, { lead: mapLeadRow(row) })
    const [{ chain }] = supabase.queriesOf('advertiser_leads')
    assert.deepEqual(chain, [
      { method: 'update', args: [{ status: 'contacted' }] },
      { method: 'eq', args: ['id', LEAD] },
      { method: 'select', args: ['*'] },
      { method: 'maybeSingle', args: [] },
    ])

    row = null
    const missing = await call('PATCH', `/api/admin/leads/${LEAD}`, { status: 'closed' })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Lead not found.', status: 404 } })
  })
})

test('PATCH a campaign checks the move from its current status and answers 404 Campaign not found. when it is gone', async () => {
  let current = campaignRow()
  const handlers = {
    campaigns: (chain) =>
      operation(chain) === 'update'
        ? { data: campaignRow({ status: chain.find((c) => c.method === 'update').args[0].status }), error: null }
        : { data: current, error: null },
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const approved = await call('PATCH', `/api/admin/campaigns/${CAMPAIGN}`, { status: 'active' })
    assert.equal(approved.status, 200)
    assert.deepEqual(approved.body, { campaign: mapAdminCampaignRow(campaignRow({ status: 'active' })) })
    assert.equal(approved.body.campaign.advertiserEmail, 'owner@bean.example')
    const [lookup, update] = supabase.queriesOf('campaigns')
    assert.deepEqual(lookup.chain, [
      { method: 'select', args: ['*'] },
      { method: 'eq', args: ['id', CAMPAIGN] },
      { method: 'maybeSingle', args: [] },
    ])
    const values = update.chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(values), ['status', 'updated_at'])
    assert.equal(values.status, 'active')
    assert.ok(!Number.isNaN(Date.parse(values.updated_at)))
    assert.ok(hasCall(update.chain, 'eq', 'id', CAMPAIGN))
    assert.ok(hasCall(update.chain, 'select', '*, advertisers ( email, company_name )'))
    assert.ok(hasCall(update.chain, 'single'))

    current = campaignRow({ status: 'ended' })
    const reopen = await call('PATCH', `/api/admin/campaigns/${CAMPAIGN}`, { status: 'active' })
    assert.equal(reopen.status, 400)
    assert.deepEqual(reopen.body, { error: { message: 'Cannot change campaign from "ended" to "active".', status: 400 } })
    const empty = await call('PATCH', `/api/admin/campaigns/${CAMPAIGN}`, {})
    assert.deepEqual(empty.body, { error: { message: 'Campaign status is required.', status: 400 } })
    assert.equal(supabase.queriesOf('campaigns').filter((q) => operation(q.chain) === 'update').length, 1, 'a refused move writes nothing')

    current = null
    const missing = await call('PATCH', `/api/admin/campaigns/${CAMPAIGN}`, { status: 'paused' })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Campaign not found.', status: 404 } })
  })
})

// ---- Advertiser accounts ------------------------------------------------------

const ADVERTISER_COLUMNS = 'id, email, company_name, contact_name, status, created_at'

// The advertisers table: the email lookup finds `existing`; a write echoes the
// row it was given, as the selected columns.
function advertiserTable(existing) {
  return (chain) => {
    const op = operation(chain)
    if (op === 'select') return { data: existing, error: null }
    const values = chain.find((c) => c.method === op).args[0]
    return {
      data: {
        id: values.id ?? existing.id,
        email: values.email ?? 'ads@bean.example',
        company_name: values.company_name,
        contact_name: values.contact_name,
        status: values.status,
        created_at: values.created_at ?? '2026-09-01T00:00:00.000Z',
      },
      error: null,
    }
  }
}

const NEW_ACCOUNT = { email: ' Ads@Bean.Example ', password: 'correct horse battery', companyName: ' Bean There ', contactName: 'Sam' }

test('GET advertisers lists accounts newest first, at most 200', async () => {
  const row = { id: ADVERTISER, email: 'ads@bean.example', company_name: 'Bean There', contact_name: null, status: 'active', created_at: '2026-09-01T00:00:00.000Z' }
  await withApp({ handlers: { advertisers: () => ({ data: [row], error: null }) } }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/admin/advertisers')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { advertisers: [mapAdminAdvertiserRow(row)] })
    const [{ chain }] = supabase.queriesOf('advertisers')
    assert.deepEqual(chain, [{ method: 'select', args: [ADVERTISER_COLUMNS] }, ...NEWEST_200])
  })
})

test('POST advertisers refuses a bad body, then creates a new email with a hashed password and answers 201', async () => {
  await withApp({ handlers: { advertisers: advertiserTable(null) } }, async ({ call, supabase }) => {
    const noEmail = await call('POST', '/api/admin/advertisers', { ...NEW_ACCOUNT, email: 'nope' })
    assert.equal(noEmail.status, 400)
    assert.deepEqual(noEmail.body, { error: { message: 'A valid email is required.', status: 400 } })
    const shortPassword = await call('POST', '/api/admin/advertisers', { ...NEW_ACCOUNT, password: 'short' })
    assert.deepEqual(shortPassword.body, { error: { message: 'Password must be at least 8 characters.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const created = await call('POST', '/api/admin/advertisers', NEW_ACCOUNT)
    assert.equal(created.status, 201)
    const [lookup, insert] = supabase.queriesOf('advertisers')
    assert.deepEqual(lookup.chain, [
      { method: 'select', args: ['id'] },
      { method: 'eq', args: ['email', 'ads@bean.example'] },
      { method: 'maybeSingle', args: [] },
    ])
    assert.equal(operation(insert.chain), 'insert')
    const values = insert.chain.find((c) => c.method === 'insert').args[0]
    assert.match(values.id, UUID_RE)
    assert.equal(values.email, 'ads@bean.example')
    assert.equal(values.company_name, 'Bean There')
    assert.equal(values.contact_name, 'Sam')
    assert.equal(values.status, 'active')
    assert.notEqual(values.password_hash, NEW_ACCOUNT.password)
    assert.ok(verifyPassword(NEW_ACCOUNT.password, values.password_hash), 'the stored hash verifies')
    assert.ok(!Number.isNaN(Date.parse(values.created_at)))
    assert.equal(values.updated_at, values.created_at)
    assert.ok(hasCall(insert.chain, 'select', ADVERTISER_COLUMNS))
    assert.ok(hasCall(insert.chain, 'single'))
    assert.deepEqual(created.body, {
      advertiser: { id: values.id, email: 'ads@bean.example', companyName: 'Bean There', contactName: 'Sam', status: 'active', createdAt: values.created_at },
    })
    assert.equal(supabase.queriesOf('advertiser_leads').length, 0, 'no leadId, no lead touched')
  })
})

test('POST advertisers updates an existing email and answers 200; a leadId closes that lead only for that email', async () => {
  const handlers = {
    advertisers: advertiserTable({ id: ADVERTISER }),
    advertiser_leads: () => ({ data: null, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('POST', '/api/admin/advertisers', { ...NEW_ACCOUNT, leadId: ` ${LEAD} ` })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.advertiser.id, ADVERTISER)
    assert.equal(answer.body.advertiser.status, 'active')
    const [, update] = supabase.queriesOf('advertisers')
    assert.equal(operation(update.chain), 'update')
    const values = update.chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(values), ['password_hash', 'company_name', 'contact_name', 'status', 'updated_at'])
    assert.ok(verifyPassword(NEW_ACCOUNT.password, values.password_hash))
    assert.notEqual(values.password_hash, NEW_ACCOUNT.password)
    assert.equal(values.status, 'active')
    assert.ok(hasCall(update.chain, 'eq', 'id', ADVERTISER))
    assert.equal(supabase.queriesOf('advertisers').filter((q) => operation(q.chain) === 'insert').length, 0)

    const [close] = supabase.queriesOf('advertiser_leads')
    assert.deepEqual(close.chain, [
      { method: 'update', args: [{ status: 'closed' }] },
      { method: 'eq', args: ['id', LEAD] },
      { method: 'eq', args: ['email', 'ads@bean.example'] },
    ])
  })
})

test('a failed advertiser write answers the advertiser 500 fallback', async (t) => {
  t.mock.method(console, 'error', () => {})
  const handlers = {
    advertisers: (chain) =>
      operation(chain) === 'select'
        ? { data: null, error: null }
        : { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
  }
  await withApp({ handlers }, async ({ call }) => {
    const answer = await call('POST', '/api/admin/advertisers', NEW_ACCOUNT)
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Something went wrong. Please try again.', status: 500 } })
  })
})

// ---- Purdue link release ------------------------------------------------------

test('the Purdue link release needs purdueEmail or userId, and looks the profile up by the normalized address or the id', async () => {
  const handlers = { users: () => ({ data: [{ id: USER, email: 'pete@gmail.com', purdue_email: 'pete@purdue.edu' }], error: null }) }
  await withApp({ handlers }, async ({ call, supabase, cleared }) => {
    for (const body of [{}, { purdueEmail: '   ' }, { userId: '  ' }]) {
      const answer = await call('POST', '/api/admin/purdue-links/clear', body)
      assert.equal(answer.status, 400)
      assert.deepEqual(answer.body, { error: { message: 'Provide purdueEmail or userId to clear a Purdue link.', status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)

    const byEmail = await call('POST', '/api/admin/purdue-links/clear', { purdueEmail: ' Pete@Purdue.edu ' })
    assert.equal(byEmail.status, 200)
    assert.deepEqual(byEmail.body, { ok: true, cleared: [{ id: USER, email: 'pete@gmail.com', purdueEmail: 'pete@purdue.edu' }] })
    await call('POST', '/api/admin/purdue-links/clear', { userId: ` ${USER} `, purdueEmail: 'someone@purdue.edu' })
    const [emailLookup, idLookup] = supabase.queriesOf('users')
    assert.deepEqual(emailLookup.chain, [
      { method: 'select', args: ['id, email, purdue_email'] },
      { method: 'eq', args: ['purdue_email', 'pete@purdue.edu'] },
    ])
    assert.deepEqual(idLookup.chain, [
      { method: 'select', args: ['id, email, purdue_email'] },
      { method: 'eq', args: ['id', USER] },
    ], 'a userId wins over a purdueEmail')
    assert.deepEqual(cleared, [USER, USER])
  })
})

test('the Purdue link release clears each linked profile once, skips unlinked ones and answers 404 or 500 when it cannot', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  let rows = [
    { id: USER, email: 'pete@gmail.com', purdue_email: 'pete@purdue.edu' },
    { id: STUDENT.id, email: 'student@purdue.edu', purdue_email: null },
    { id: USER_2, email: 'pat@gmail.com', purdue_email: 'pat@purdue.edu' },
  ]
  let lookupError = null
  const handlers = { users: () => ({ data: lookupError ? null : rows, error: lookupError }) }
  await withApp({ handlers }, async ({ call, cleared }) => {
    const both = await call('POST', '/api/admin/purdue-links/clear', { purdueEmail: 'pete@purdue.edu' })
    assert.equal(both.status, 200)
    assert.deepEqual(both.body, {
      ok: true,
      cleared: [
        { id: USER, email: 'pete@gmail.com', purdueEmail: 'pete@purdue.edu' },
        { id: USER_2, email: 'pat@gmail.com', purdueEmail: 'pat@purdue.edu' },
      ],
    })
    assert.deepEqual(cleared, [USER, USER_2], 'one call per linked row, none for the unlinked one')

    rows = [{ id: STUDENT.id, email: 'student@purdue.edu', purdue_email: null }]
    const unlinked = await call('POST', '/api/admin/purdue-links/clear', { userId: STUDENT.id })
    assert.equal(unlinked.status, 404)
    assert.deepEqual(unlinked.body, { error: { message: 'Profile has no Purdue link to clear.', status: 404 } })
    assert.deepEqual(cleared, [USER, USER_2])

    rows = []
    const nobody = await call('POST', '/api/admin/purdue-links/clear', { purdueEmail: 'ghost@purdue.edu' })
    assert.equal(nobody.status, 404)
    assert.deepEqual(nobody.body, { error: { message: 'No matching user profile found.', status: 404 } })

    lookupError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const failed = await call('POST', '/api/admin/purdue-links/clear', { purdueEmail: 'pete@purdue.edu' })
    assert.equal(failed.status, 500)
    assert.deepEqual(failed.body, { error: { message: 'Could not look up the user.', status: 500 } })
    assert.deepEqual(cleared, [USER, USER_2])
  })
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [
    ['[admin/purdue-links/clear] lookup failed:', 'canceling statement due to statement timeout'],
  ])
})

// ---- Soft-delete moderation ---------------------------------------------------

const CONTENT_TYPES = [
  ['board', 'board_posts', 'Board post'],
  ['marketplace', 'marketplace_listings', 'Marketplace listing'],
  ['lost-found', 'lost_found_items', 'Lost & Found item'],
  ['guide', 'guide_recommendations', 'Guide recommendation'],
  ['deals', 'deals', 'Deal'],
  ['study-groups', 'study_groups', 'Study group'],
]
const SOFT_DELETED = { method: 'not', args: ['deleted_at', 'is', null] }

test('an unknown content type answers 404 Unknown content type. before any query, an inherited key included', async () => {
  await withApp({}, async ({ call, supabase }) => {
    for (const type of ['nope', 'users', 'constructor', '__proto__', 'toString']) {
      for (const [method, path] of [
        ['GET', `/api/admin/deleted/${type}`],
        ['GET', `/api/admin/content/${type}/${ITEM}`],
        ['POST', `/api/admin/deleted/${type}/${ITEM}/restore`],
        ['DELETE', `/api/admin/deleted/${type}/${ITEM}`],
      ]) {
        const answer = await call(method, path)
        assert.equal(answer.status, 404, `${method} ${path}`)
        assert.deepEqual(answer.body, { error: { message: 'Unknown content type.', status: 404 } }, `${method} ${path}`)
      }
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('the deleted list reads only soft-deleted rows of the whitelisted table, newest deletion first', async () => {
  const handlers = Object.fromEntries(CONTENT_TYPES.map(([, table]) => [table, () => ({ data: [{ id: ITEM, table }], error: null })]))
  await withApp({ handlers }, async ({ call, supabase }) => {
    for (const [type, table, label] of CONTENT_TYPES) {
      const answer = await call('GET', `/api/admin/deleted/${type}`)
      assert.equal(answer.status, 200, type)
      assert.deepEqual(answer.body, { items: [{ id: ITEM, table }], label })
      const [{ chain }] = supabase.queriesOf(table)
      assert.deepEqual(chain, [
        { method: 'select', args: ['*'] },
        SOFT_DELETED,
        { method: 'order', args: ['deleted_at', { ascending: false }] },
        { method: 'limit', args: [200] },
      ])
    }
  })
})

test('the content read finds only a live row, restore and purge only a soft-deleted one, and a miss answers 404', async () => {
  let rows = [{ id: ITEM }]
  const handlers = {
    board_posts: (chain) => (hasCall(chain, 'maybeSingle') ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const live = await call('GET', `/api/admin/content/board/${ITEM}`)
    assert.equal(live.status, 200)
    assert.deepEqual(live.body, { item: { id: ITEM }, label: 'Board post' })
    const restored = await call('POST', `/api/admin/deleted/board/${ITEM}/restore`)
    assert.equal(restored.status, 200)
    assert.deepEqual(restored.body, { ok: true })
    const purged = await call('DELETE', `/api/admin/deleted/board/${ITEM}`)
    assert.equal(purged.status, 204)
    assert.equal(purged.body, null)

    const [read, restore, purge] = supabase.queriesOf('board_posts')
    assert.deepEqual(read.chain, [
      { method: 'select', args: ['*'] },
      { method: 'eq', args: ['id', ITEM] },
      { method: 'is', args: ['deleted_at', null] },
      { method: 'maybeSingle', args: [] },
    ])
    assert.deepEqual(restore.chain, [
      { method: 'update', args: [{ deleted_at: null }] },
      { method: 'eq', args: ['id', ITEM] },
      SOFT_DELETED,
      { method: 'select', args: ['id'] },
    ])
    assert.deepEqual(purge.chain, [
      { method: 'delete', args: [] },
      { method: 'eq', args: ['id', ITEM] },
      SOFT_DELETED,
      { method: 'select', args: ['id'] },
    ])

    rows = []
    for (const [method, path] of [
      ['GET', `/api/admin/content/board/${ITEM}`],
      ['POST', `/api/admin/deleted/board/${ITEM}/restore`],
      ['DELETE', `/api/admin/deleted/board/${ITEM}`],
    ]) {
      const missing = await call(method, path)
      assert.equal(missing.status, 404, `${method} ${path}`)
      assert.deepEqual(missing.body, { error: { message: 'Item not found.', status: 404 } })
    }
  })
})

test('study groups without deleted_at answer 503 moderation_schema_missing and name their migration; other errors answer each route its own 500', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const ROUTES = [
    ['GET', '/api/admin/deleted/study-groups', 'deleted list'],
    ['GET', `/api/admin/content/study-groups/${ITEM}`, 'content read'],
    ['POST', `/api/admin/deleted/study-groups/${ITEM}/restore`, 'restore'],
    ['DELETE', `/api/admin/deleted/study-groups/${ITEM}`, 'purge'],
  ]
  // One message per route: the schema-missing log is once per process per message.
  let failure = (name) => ({ code: '42703', message: `column study_groups.deleted_at does not exist (${name})` })
  let current = ''
  const handlers = { study_groups: () => ({ data: null, error: failure(current) }) }
  await withApp({ handlers }, async ({ call }) => {
    for (const [method, path, name] of ROUTES) {
      current = name
      const answer = await call(method, path)
      assert.equal(answer.status, 503, `${method} ${path}`)
      assert.deepEqual(answer.body, {
        error: { message: 'Study group moderation is not set up yet. Please try again later.', code: 'moderation_schema_missing', status: 503 },
      })
    }
    assert.equal(logged.mock.calls.length, 4)
    for (const { arguments: args } of logged.mock.calls) {
      assert.equal(args[0], '[moderation] schema missing: run db/supabase-study-groups-soft-delete.sql in the Supabase SQL Editor, then retry.')
    }

    failure = () => ({ code: '57014', message: 'canceling statement due to statement timeout' })
    const expected = [
      ['GET /api/admin/deleted/study-groups', 'Could not load deleted items.'],
      ['GET /api/admin/content/study-groups', 'Could not load the item.'],
      ['restore study-groups', 'Could not restore the item.'],
      ['hard delete study-groups', 'Could not permanently delete the item.'],
    ]
    for (const [i, [method, path]] of ROUTES.entries()) {
      const answer = await call(method, path)
      assert.equal(answer.status, 500, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: expected[i][1], status: 500 } })
      assert.deepEqual(logged.mock.calls.at(-1).arguments, ['%s:', expected[i][0], 'canceling statement due to statement timeout'])
    }
  })
})

// ---- Hidden marketplace listings ----------------------------------------------

function listingRow(overrides = {}) {
  return { id: LISTING, title: 'Mini fridge', user_id: STUDENT.id, hidden: true, deleted_at: null, created_at: '2026-09-30T12:00:00.000Z', ...overrides }
}

test('the hidden queue lists hidden live listings, newest first, with their report counts and reasons', async () => {
  let listings = [listingRow(), listingRow({ id: LISTING_2, title: 'Desk lamp' })]
  const handlers = {
    marketplace_listings: () => ({ data: listings, error: null }),
    marketplace_reports: () => ({
      data: [
        { listing_id: LISTING, reason: 'scam' },
        { listing_id: LISTING, reason: null },
        { listing_id: LISTING, reason: 'spam' },
      ],
      error: null,
    }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/admin/hidden/marketplace')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, {
      items: [
        { ...listingRow(), reportCount: 3, reasons: ['scam', 'spam'] },
        { ...listingRow({ id: LISTING_2, title: 'Desk lamp' }), reportCount: 0, reasons: [] },
      ],
      label: 'Marketplace listing',
    })
    const [{ chain }] = supabase.queriesOf('marketplace_listings')
    assert.deepEqual(chain, [
      { method: 'select', args: ['*'] },
      { method: 'eq', args: ['hidden', true] },
      { method: 'is', args: ['deleted_at', null] },
      ...NEWEST_200,
    ])
    const [reports] = supabase.queriesOf('marketplace_reports')
    assert.deepEqual(reports.chain, [
      { method: 'select', args: ['listing_id, reason'] },
      { method: 'in', args: ['listing_id', [LISTING, LISTING_2]] },
    ])

    listings = []
    assert.deepEqual((await call('GET', '/api/admin/hidden/marketplace')).body, { items: [], label: 'Marketplace listing' })
    assert.equal(supabase.queriesOf('marketplace_reports').length, 1, 'an empty queue reads no reports')
  })
})

test('unhide clears the flag on a hidden listing and then its reports; takedown soft-deletes a live one; a miss answers 404', async () => {
  let rows = [{ id: LISTING }]
  const handlers = {
    marketplace_listings: () => ({ data: rows, error: null }),
    marketplace_reports: () => ({ data: null, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const unhidden = await call('POST', `/api/admin/hidden/marketplace/${LISTING}/unhide`)
    assert.equal(unhidden.status, 200)
    assert.deepEqual(unhidden.body, { ok: true })
    const takenDown = await call('POST', `/api/admin/hidden/marketplace/${LISTING}/takedown`)
    assert.equal(takenDown.status, 200)
    assert.deepEqual(takenDown.body, { ok: true })

    const [unhide, takedown] = supabase.queriesOf('marketplace_listings')
    assert.deepEqual(unhide.chain, [
      { method: 'update', args: [{ hidden: false }] },
      { method: 'eq', args: ['id', LISTING] },
      { method: 'eq', args: ['hidden', true] },
      { method: 'select', args: ['id'] },
    ])
    const [clearReports] = supabase.queriesOf('marketplace_reports')
    assert.deepEqual(clearReports.chain, [
      { method: 'delete', args: [] },
      { method: 'eq', args: ['listing_id', LISTING] },
    ])
    assert.ok(supabase.queries.indexOf(clearReports) > supabase.queries.indexOf(unhide), 'the reports go after the flag')
    const values = takedown.chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(values), ['deleted_at'])
    assert.ok(!Number.isNaN(Date.parse(values.deleted_at)))
    assert.deepEqual(takedown.chain.slice(1), [
      { method: 'eq', args: ['id', LISTING] },
      { method: 'is', args: ['deleted_at', null] },
      { method: 'select', args: ['id'] },
    ])

    rows = []
    for (const action of ['unhide', 'takedown']) {
      const missing = await call('POST', `/api/admin/hidden/marketplace/${LISTING}/${action}`)
      assert.equal(missing.status, 404, action)
      assert.deepEqual(missing.body, { error: { message: 'Listing not found.', status: 404 } })
    }
    assert.equal(supabase.queriesOf('marketplace_reports').length, 1, 'a missed unhide clears no reports')
  })
})

test('a missing marketplace table answers 503 marketplace_schema_missing; another error answers the marketplace 500', async (t) => {
  t.mock.method(console, 'error', () => {})
  let error = { code: 'PGRST205', message: "Could not find the table 'public.marketplace_listings' in the schema cache (admin hidden queue)" }
  const handlers = { marketplace_listings: () => ({ data: null, error }) }
  await withApp({ handlers }, async ({ call }) => {
    for (const [method, path] of [
      ['GET', '/api/admin/hidden/marketplace'],
      ['POST', `/api/admin/hidden/marketplace/${LISTING}/unhide`],
      ['POST', `/api/admin/hidden/marketplace/${LISTING}/takedown`],
    ]) {
      const answer = await call(method, path)
      assert.equal(answer.status, 503, `${method} ${path}`)
      assert.deepEqual(answer.body, {
        error: { message: 'The marketplace is not set up yet. Please try again later.', code: 'marketplace_schema_missing', status: 503 },
      })
    }
    error = { code: '57014', message: 'canceling statement due to statement timeout' }
    const answer = await call('GET', '/api/admin/hidden/marketplace')
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not load the marketplace. Please try again.', status: 500 } })
  })
})

// ---- Sentry smoke test --------------------------------------------------------

test('the Sentry smoke test needs ?confirm=1, then hands its error to next() and the final handler answers the generic 500', async () => {
  await withApp({}, async ({ call, supabase, log }) => {
    for (const path of ['/api/admin/sentry-test', '/api/admin/sentry-test?confirm=0', '/api/admin/sentry-test?confirm=true']) {
      const answer = await call('GET', path)
      assert.equal(answer.status, 400, path)
      assert.deepEqual(answer.body, { error: { message: 'Add ?confirm=1 to raise a test error.', status: 400 } })
    }
    assert.deepEqual(log.lines.error, [])

    const raised = await call('GET', '/api/admin/sentry-test?confirm=1')
    assert.equal(raised.status, 500)
    assert.deepEqual(raised.body, { error: { message: 'Internal server error.', status: 500 } })
    assert.equal(log.lines.error.length, 1)
    const prefix = '[unhandled] Sentry smoke test raised via GET /api/admin/sentry-test at '
    assert.ok(log.lines.error[0].startsWith(prefix), log.lines.error[0])
    assert.ok(!Number.isNaN(Date.parse(log.lines.error[0].slice(prefix.length))))
    assert.deepEqual(log.lines.warn, [])
    assert.equal(supabase.queries.length, 0)
  })
})
