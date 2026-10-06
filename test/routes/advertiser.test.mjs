import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { format } from 'node:util'
import express from 'express'
import session from 'express-session'
import { createAdvertiserRouter, createSpotlightRouter } from '../../src/routes/advertiser.mjs'
import { toServedAd } from '../../src/adServing.mjs'
import { toAdvertiserProfile } from '../../src/advertiserAuth.mjs'
import { mapCampaignRow } from '../../src/advertiserCampaign.mjs'
import { hashResetToken } from '../../src/advertiserPasswordReset.mjs'
import { hashPassword, verifyPassword } from '../../src/passwordHash.mjs'
import { SESSION_COOKIE_NAME } from '../../src/publicReadKey.mjs'
import { DRAFT_CAMPAIGNS_CAP_MESSAGE, MAX_DRAFT_CAMPAIGNS } from '../../src/userWriteCaps.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the advertiser portal and the spotlight routes as feature
// routers, booted on a small app behind the real express-session (a
// MemoryStore under the server's cookie name), with recording limiters, a
// recording mail sender, a getCached that runs its producer and an in-memory
// database behind the recording fake. Two test routes ahead of the routers
// write and read the session, so a student or an advertiser session can be set
// up without signing in. The spotlight requireAuth reads req.session.userId,
// as the server's does through getCurrentUser; the portal is never handed one.

const PASSWORD = 'correct horse battery'
const NEW_PASSWORD = 'a brand new passphrase'
const STUDENT_ID = '11111111-1111-4111-8111-111111111111'
const ADVERTISER = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'owner@cafe.example',
  company_name: 'Cafe Example',
  contact_name: 'Casey Owner',
  status: 'active',
  password_hash: hashPassword(PASSWORD),
}
const OTHER = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'other@shop.example',
  company_name: 'Shop Example',
  contact_name: null,
  status: 'active',
  password_hash: hashPassword('another passphrase'),
}
const SUSPENDED = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  email: 'gone@closed.example',
  company_name: 'Closed Example',
  contact_name: null,
  status: 'suspended',
  password_hash: hashPassword(PASSWORD),
}
const CAMPAIGN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const BAD_ID = 'not-a-uuid'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SESSION_MAX_AGE = 14 * 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

const PORTAL_401 = { error: { message: 'You must sign in to the advertiser portal.', status: 401 } }
const STUDENT_401 = { error: { message: 'You must sign in to access this resource.', status: 401 } }
const SUSPENDED_403 = { error: { message: 'This advertiser account is suspended.', status: 403 } }
const NOT_FOUND = { error: { message: 'Not found.', status: 404 } }
const SIGNED_OUT_PROBE = { authenticated: false, advertiser: null }
const SCHEMA_MISSING = { code: 'PGRST205', message: "Could not find the table 'public.advertisers' in the schema cache" }
const DB_DOWN = { code: 'XX000', message: 'connection reset' }
const PORTAL_503 = {
  error: { message: 'The advertiser portal is not set up yet. Please try again later.', code: 'advertiser_schema_missing', status: 503 },
}
const PORTAL_500 = { error: { message: 'Something went wrong. Please try again.', status: 500 } }
const BAD_RESET_LINK = { error: { message: 'This reset link is invalid or has expired.', status: 400 } }

const OPEN_ROUTES = [
  ['POST', '/api/advertiser/sign-in', {}],
  ['POST', '/api/advertiser/sign-out'],
  ['GET', '/api/advertiser/me'],
  ['POST', '/api/advertiser/request-access', {}],
  ['POST', '/api/advertiser/forgot-password', {}],
  ['POST', '/api/advertiser/reset-password', {}],
]
const CAMPAIGN_ROUTES = [
  ['GET', '/api/advertiser/campaigns'],
  ['POST', '/api/advertiser/campaigns', { name: 'Fall promo', placement: 'home-widget' }],
  ['PATCH', `/api/advertiser/campaigns/${CAMPAIGN_ID}`, { name: 'Renamed' }],
  ['GET', `/api/advertiser/campaigns/${CAMPAIGN_ID}/stats`],
]
const SPOTLIGHT_ROUTES = [
  ['GET', '/api/spotlight/active'],
  ['POST', `/api/spotlight/${CAMPAIGN_ID}/event`, { kind: 'impression' }],
]

let campaignSeq = 0
/** A campaigns row, owned by ADVERTISER unless overridden; each one a minute newer than the last. */
function campaignRow(overrides = {}) {
  campaignSeq += 1
  const at = new Date(Date.UTC(2026, 8, 1) + campaignSeq * 60 * 1000).toISOString()
  return {
    id: `eeeeeeee-eeee-4eee-8eee-${String(campaignSeq).padStart(12, '0')}`,
    advertiser_id: ADVERTISER.id,
    name: `Campaign ${campaignSeq}`,
    placement: 'home-widget',
    status: 'draft',
    starts_on: null,
    ends_on: null,
    creative: { headline: `Headline ${campaignSeq}` },
    created_at: at,
    updated_at: at,
    ...overrides,
  }
}

/** An advertiser_password_resets row for `token`, open and live for an hour unless overridden. */
function resetRow(token, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    advertiser_id: ADVERTISER.id,
    token_hash: hashResetToken(token),
    expires_at: new Date(Date.now() + HOUR).toISOString(),
    used_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

const TABLES = ['advertisers', 'advertiser_leads', 'advertiser_password_resets', 'campaigns', 'ad_events']

// One table of the in-memory database, answering a recorded chain the way
// PostgREST would: eq and is filters, order, a head count, insert and update
// (the rows come back when the chain selects them), and single (PGRST116
// unless exactly one row matched) or maybeSingle.
function answer(table, chain) {
  const filters = chain.filter((c) => c.method === 'eq' || c.method === 'is')
  const matches = (row) =>
    filters.every(({ method, args: [column, value] }) => (method === 'is' ? (row[column] ?? null) === value : row[column] === value))
  const op = operation(chain)
  let rows
  if (op === 'insert') {
    rows = [].concat(chain.find((c) => c.method === 'insert').args[0]).map((row) => ({ ...row }))
    table.push(...rows)
  } else if (op === 'update') {
    const patch = chain.find((c) => c.method === 'update').args[0]
    rows = table.filter(matches)
    for (const row of rows) Object.assign(row, patch)
  } else {
    rows = table.filter(matches)
    if (chain.find((c) => c.method === 'select')?.args[1]?.head) return { data: null, count: rows.length, error: null }
    const order = chain.find((c) => c.method === 'order')
    if (order) {
      const [column, { ascending = true } = {}] = order.args
      rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1))
    }
  }
  const copies = rows.map((row) => structuredClone(row))
  if (hasCall(chain, 'single')) {
    return copies.length === 1
      ? { data: copies[0], error: null }
      : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
  }
  if (hasCall(chain, 'maybeSingle')) return { data: copies[0] ?? null, error: null }
  if (op !== 'select' && !hasCall(chain, 'select')) return { data: null, error: null }
  return { data: copies, error: null }
}

async function withApp(options, run) {
  const { seed = {}, isProduction = false, send = async () => ({ sent: true, id: 'resend-1' }) } = options
  const db = Object.fromEntries(TABLES.map((name) => [name, structuredClone(seed[name] ?? [])]))
  // failures[table](chain) returns an error to answer that query with, or nothing.
  const failures = {}
  const supabase = fakeSupabase(
    Object.fromEntries(
      TABLES.map((name) => [
        name,
        (chain) => {
          const error = failures[name]?.(chain)
          return error ? { data: null, count: null, error } : answer(db[name], chain)
        },
      ]),
    ),
  )
  const limiterHits = []
  const mail = []
  const cacheCalls = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const store = new session.MemoryStore()
  const app = express()
  app.use(express.json())
  // server.mjs's body shim (issue #291): Express 5 leaves req.body undefined on a bodyless request.
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {}
    next()
  })
  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: 'advertiser-router-test-secret',
      store,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', maxAge: SESSION_MAX_AGE },
    }),
  )
  // Test only: merge the body into the session, and read back whose it is.
  app.post('/test/session', (req, res) => {
    Object.assign(req.session, req.body)
    res.json({ ok: true })
  })
  app.get('/test/session', (req, res) => {
    res.json({ userId: req.session.userId ?? null, advertiserId: req.session.advertiserId ?? null })
  })
  app.use(
    createAdvertiserRouter({
      supabase,
      signInRateLimit: limiter('signInRateLimit'),
      accountCreateRateLimit: limiter('accountCreateRateLimit'),
      passwordResetRateLimit: limiter('passwordResetRateLimit'),
      advertiserWriteRateLimit: limiter('advertiserWriteRateLimit'),
      sendAdvertiserPasswordResetEmail: async (message) => {
        mail.push(message)
        return send(message)
      },
      clientAppUrl: 'https://app.example',
      isProduction,
    }),
  )
  app.use(
    createSpotlightRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!req.session.userId) return res.status(401).json(STUDENT_401)
        req.currentUser = { id: req.session.userId }
        next()
      },
      adEventRateLimit: limiter('adEventRateLimit'),
      // server.mjs's TTL cache, cold: records the key and runs the producer.
      getCached: async (key, ttlMs, producer) => {
        cacheCalls.push({ key, ttlMs })
        return producer()
      },
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, { body, cookie } = {}) => {
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (cookie) headers.Cookie = cookie
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    const setCookies = response.headers.getSetCookie()
    // The session cookie this answer set, as a Cookie header pair; null when it set none or cleared it.
    const pair = setCookies.map((c) => c.split(';')[0]).find((p) => p.startsWith(`${SESSION_COOKIE_NAME}=`))
    const cookieSet = pair && pair.length > SESSION_COOKIE_NAME.length + 1 ? pair : null
    return { status: response.status, text, body: text ? JSON.parse(text) : null, setCookies, cookie: cookieSet }
  }
  const sessionFor = async (fields) => {
    const res = await call('POST', '/test/session', { body: fields })
    assert.ok(res.cookie, 'the test session got a cookie')
    return res.cookie
  }
  // Every session in the store, as whose it is.
  const sessions = () =>
    new Promise((resolve, reject) => {
      store.all((err, all) => {
        if (err) return reject(err)
        resolve(Object.values(all || {}).map((s) => ({ userId: s.userId ?? null, advertiserId: s.advertiserId ?? null })))
      })
    })
  try {
    await run({ call, sessionFor, sessions, db, failures, supabase, limiterHits, mail, cacheCalls })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Every console line the block writes, while it runs. */
async function captureConsole(block) {
  const lines = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(format(...args))
  try {
    await block(lines)
  } finally {
    Object.assign(console, saved)
  }
  return lines
}

const isRecent = (iso) => Math.abs(Date.parse(iso) - Date.now()) < 60 * 1000

// ── Limiters and gates ──────────────────────────────────────────────────────

test('signed out, only the seven write routes hit a limiter, under the server.mjs names, ahead of every session check', async () => {
  await withApp({ seed: { advertisers: [ADVERTISER] } }, async ({ call, supabase, limiterHits }) => {
    const statuses = []
    for (const [method, path, body] of [...OPEN_ROUTES, ...CAMPAIGN_ROUTES, ...SPOTLIGHT_ROUTES]) {
      statuses.push((await call(method, path, { body })).status)
    }
    assert.deepEqual(statuses, [400, 200, 200, 400, 400, 400, 401, 401, 401, 401, 401, 401])
    assert.deepEqual(limiterHits, [
      'signInRateLimit POST /api/advertiser/sign-in',
      'accountCreateRateLimit POST /api/advertiser/request-access',
      'passwordResetRateLimit POST /api/advertiser/forgot-password',
      'passwordResetRateLimit POST /api/advertiser/reset-password',
      'advertiserWriteRateLimit POST /api/advertiser/campaigns',
      `advertiserWriteRateLimit PATCH /api/advertiser/campaigns/${CAMPAIGN_ID}`,
      `adEventRateLimit POST /api/spotlight/${CAMPAIGN_ID}/event`,
    ])
    assert.equal(supabase.queries.length, 0)
  })
})

test('signed out, the campaign routes answer the portal 401 and spotlight the student 401, before any query', async () => {
  const seed = { advertisers: [ADVERTISER], campaigns: [campaignRow({ id: CAMPAIGN_ID, status: 'active' })] }
  await withApp({ seed }, async ({ call, supabase }) => {
    for (const [method, path, body] of CAMPAIGN_ROUTES) {
      const res = await call(method, path, { body })
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.deepEqual(res.body, PORTAL_401)
    }
    for (const [method, path, body] of SPOTLIGHT_ROUTES) {
      const res = await call(method, path, { body })
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.deepEqual(res.body, STUDENT_401)
    }
    // The probe answers 200 signed out (#157), and starts no session.
    const me = await call('GET', '/api/advertiser/me')
    assert.equal(me.status, 200)
    assert.deepEqual(me.body, SIGNED_OUT_PROBE)
    assert.equal(me.cookie, null)
    assert.equal(supabase.queries.length, 0)
  })
})

test('a malformed id answers 404 before the session is checked, after the write limiter', async () => {
  await withApp({}, async ({ call, supabase, limiterHits }) => {
    const routes = [
      ['PATCH', `/api/advertiser/campaigns/${BAD_ID}`, { name: 'Renamed' }],
      ['GET', `/api/advertiser/campaigns/${BAD_ID}/stats`],
      ['POST', `/api/spotlight/${BAD_ID}/event`, { kind: 'tap' }],
    ]
    for (const [method, path, body] of routes) {
      const res = await call(method, path, { body })
      assert.equal(res.status, 404, `${method} ${path}`)
      assert.deepEqual(res.body, NOT_FOUND)
    }
    assert.deepEqual(limiterHits, [
      `advertiserWriteRateLimit PATCH /api/advertiser/campaigns/${BAD_ID}`,
      `adEventRateLimit POST /api/spotlight/${BAD_ID}/event`,
    ])
    assert.equal(supabase.queries.length, 0)
  })
})

test('a student session gets nothing from the portal, and an advertiser session nothing from spotlight', async () => {
  const seed = { advertisers: [ADVERTISER], campaigns: [campaignRow({ id: CAMPAIGN_ID, status: 'active' })] }
  await withApp({ seed }, async ({ call, sessionFor, supabase }) => {
    const student = await sessionFor({ userId: STUDENT_ID })
    for (const [method, path, body] of CAMPAIGN_ROUTES) {
      const res = await call(method, path, { body, cookie: student })
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.deepEqual(res.body, PORTAL_401)
    }
    assert.deepEqual((await call('GET', '/api/advertiser/me', { cookie: student })).body, SIGNED_OUT_PROBE)
    // requireAdvertiserAuth reads advertiserId only, so a student session never looks one up.
    assert.equal(supabase.queries.length, 0)

    const advertiser = await sessionFor({ advertiserId: ADVERTISER.id })
    for (const [method, path, body] of SPOTLIGHT_ROUTES) {
      const res = await call(method, path, { body, cookie: advertiser })
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.deepEqual(res.body, STUDENT_401)
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('a suspended advertiser gets 403 on every campaign route, and the probe reads signed out', async () => {
  const seed = { advertisers: [SUSPENDED], campaigns: [campaignRow({ id: CAMPAIGN_ID, advertiser_id: SUSPENDED.id })] }
  await withApp({ seed }, async ({ call, sessionFor, supabase }) => {
    const cookie = await sessionFor({ advertiserId: SUSPENDED.id })
    for (const [method, path, body] of CAMPAIGN_ROUTES) {
      const res = await call(method, path, { body, cookie })
      assert.equal(res.status, 403, `${method} ${path}`)
      assert.deepEqual(res.body, SUSPENDED_403)
    }
    assert.deepEqual((await call('GET', '/api/advertiser/me', { cookie })).body, SIGNED_OUT_PROBE)
    // Only the advertiser lookups ran, each by the session's id.
    assert.ok(supabase.queries.every((q) => q.table === 'advertisers' && hasCall(q.chain, 'eq', 'id', SUSPENDED.id)))
  })
})

// ── Sign-in, sign-out, request-access ───────────────────────────────────────

test('sign-in refuses a bad body, an unknown email, a wrong password and a suspended account, starting no session', async () => {
  await withApp({ seed: { advertisers: [ADVERTISER, SUSPENDED] } }, async ({ call, supabase, sessions }) => {
    const badEmail = await call('POST', '/api/advertiser/sign-in', { body: { email: 'not an email', password: PASSWORD } })
    assert.equal(badEmail.status, 400)
    assert.deepEqual(badEmail.body, { error: { message: 'Enter a valid business email.', status: 400 } })
    const noPassword = await call('POST', '/api/advertiser/sign-in', { body: { email: ADVERTISER.email } })
    assert.equal(noPassword.status, 400)
    assert.deepEqual(noPassword.body, { error: { message: 'Enter your password.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    for (const body of [
      { email: 'nobody@nowhere.example', password: PASSWORD },
      { email: ADVERTISER.email, password: 'not the password' },
    ]) {
      const res = await call('POST', '/api/advertiser/sign-in', { body })
      assert.equal(res.status, 401, body.email)
      assert.deepEqual(res.body, { error: { message: 'Invalid email or password.', status: 401 } })
      assert.equal(res.cookie, null)
    }
    const suspended = await call('POST', '/api/advertiser/sign-in', { body: { email: SUSPENDED.email, password: PASSWORD } })
    assert.equal(suspended.status, 403)
    assert.deepEqual(suspended.body, SUSPENDED_403)
    assert.equal(suspended.cookie, null)
    assert.deepEqual(await sessions(), [])
  })
})

test('a failed advertiser lookup at sign-in answers advertiser_schema_missing, or a plain 500', async () => {
  for (const [error, status, expected] of [
    [SCHEMA_MISSING, 503, PORTAL_503],
    [DB_DOWN, 500, PORTAL_500],
  ]) {
    await withApp({ seed: { advertisers: [ADVERTISER] } }, async ({ call, failures }) => {
      failures.advertisers = () => error
      await captureConsole(async () => {
        const res = await call('POST', '/api/advertiser/sign-in', { body: { email: ADVERTISER.email, password: PASSWORD } })
        assert.equal(res.status, status)
        assert.deepEqual(res.body, expected)
        assert.equal(res.cookie, null)
      })
    })
  }
})

test('sign-in from a student session regenerates it: a new cookie, advertiserId alone, the old cookie dead', async () => {
  await withApp({ seed: { advertisers: [ADVERTISER] } }, async ({ call, sessionFor, sessions, supabase }) => {
    const student = await sessionFor({ userId: STUDENT_ID })
    const signedIn = await call('POST', '/api/advertiser/sign-in', {
      body: { email: '  Owner@Cafe.Example ', password: PASSWORD },
      cookie: student,
    })
    assert.equal(signedIn.status, 200)
    assert.deepEqual(Object.keys(signedIn.body), ['session'])
    assert.deepEqual(Object.keys(signedIn.body.session).sort(), ['advertiser', 'expiresAt'])
    assert.deepEqual(signedIn.body.session.advertiser, toAdvertiserProfile(ADVERTISER))
    assert.ok(!signedIn.text.includes('password_hash') && !signedIn.text.includes(ADVERTISER.password_hash), 'the hash never leaves')
    const ttl = Date.parse(signedIn.body.session.expiresAt) - Date.now()
    assert.ok(ttl > SESSION_MAX_AGE - 60 * 1000 && ttl <= SESSION_MAX_AGE, 'expiresAt is the cookie expiry')
    const [lookup] = supabase.queriesOf('advertisers')
    assert.ok(hasCall(lookup.chain, 'eq', 'email', ADVERTISER.email), 'the email is normalized before the lookup')

    // A new session under a new cookie, holding the advertiser and nothing of the student.
    assert.ok(signedIn.cookie)
    assert.notEqual(signedIn.cookie, student)
    assert.deepEqual((await call('GET', '/test/session', { cookie: signedIn.cookie })).body, { userId: null, advertiserId: ADVERTISER.id })
    assert.deepEqual((await call('GET', '/test/session', { cookie: student })).body, { userId: null, advertiserId: null })
    assert.deepEqual(await sessions(), [{ userId: null, advertiserId: ADVERTISER.id }])

    const me = await call('GET', '/api/advertiser/me', { cookie: signedIn.cookie })
    assert.equal(me.status, 200)
    const { expiresAt, ...probe } = me.body.session
    assert.deepEqual({ ...me.body, session: probe }, { authenticated: true, session: { advertiser: toAdvertiserProfile(ADVERTISER) } })
    // The cookie expiry again: express-session touches it once more as it sets the cookie, a few ms after sign-in read it.
    assert.ok(Math.abs(Date.parse(expiresAt) - Date.parse(signedIn.body.session.expiresAt)) < 1000)
  })
})

test('sign-out destroys the session and clears pih.sid', async () => {
  await withApp({ seed: { advertisers: [ADVERTISER] } }, async ({ call, sessionFor, sessions }) => {
    const cookie = await sessionFor({ advertiserId: ADVERTISER.id })
    const out = await call('POST', '/api/advertiser/sign-out', { cookie })
    assert.equal(out.status, 200)
    assert.deepEqual(out.body, { ok: true })
    const cleared = out.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
    assert.ok(cleared, 'the answer sets pih.sid')
    assert.match(cleared, /^pih\.sid=;/)
    assert.match(cleared, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/)
    assert.deepEqual(await sessions(), [])
    assert.deepEqual((await call('GET', '/test/session', { cookie })).body, { userId: null, advertiserId: null })
  })
})

test('request-access refuses a bad email, stores a lead with 201, and answers a missing table with the portal code', async () => {
  await withApp({}, async ({ call, db, failures, supabase }) => {
    const bad = await call('POST', '/api/advertiser/request-access', { body: { email: 'nope', companyName: 'Shop' } })
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.body, { error: { message: 'Enter a valid business email so we can reach you.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const ok = await call('POST', '/api/advertiser/request-access', {
      body: { email: ' Lead@Shop.Example ', companyName: ' Shop Example ', message: ' We sell bagels. ' },
    })
    assert.equal(ok.status, 201)
    assert.deepEqual(ok.body, { ok: true })
    assert.equal(db.advertiser_leads.length, 1)
    const { id, created_at: createdAt, ...lead } = db.advertiser_leads[0]
    assert.match(id, UUID_RE)
    assert.ok(isRecent(createdAt))
    assert.deepEqual(lead, { email: 'lead@shop.example', company_name: 'Shop Example', message: 'We sell bagels.' })

    failures.advertiser_leads = () => SCHEMA_MISSING
    await captureConsole(async () => {
      const missing = await call('POST', '/api/advertiser/request-access', { body: { email: 'lead@shop.example' } })
      assert.equal(missing.status, 503)
      assert.deepEqual(missing.body, PORTAL_503)
    })
  })
})

// ── Password reset ──────────────────────────────────────────────────────────

test('forgot-password refuses a bad body, and answers an unknown or suspended email the same 200 with no token and no mail', async () => {
  await withApp({ seed: { advertisers: [ADVERTISER, SUSPENDED] } }, async ({ call, db, mail, supabase }) => {
    const bad = await call('POST', '/api/advertiser/forgot-password', { body: { email: 'nope' } })
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.body, { error: { message: 'Enter a valid business email.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    for (const email of ['nobody@nowhere.example', SUSPENDED.email]) {
      const res = await call('POST', '/api/advertiser/forgot-password', { body: { email } })
      assert.equal(res.status, 200, email)
      assert.deepEqual(res.body, { ok: true })
    }
    assert.equal(supabase.queriesOf('advertiser_password_resets').length, 0)
    assert.deepEqual(db.advertiser_password_resets, [])
    assert.deepEqual(mail, [])
  })
})

test('forgot-password mints one token for an active account and mails its link, storing only the hash', async () => {
  await withApp({ seed: { advertisers: [ADVERTISER] } }, async ({ call, db, mail }) => {
    const lines = await captureConsole(async () => {
      const res = await call('POST', '/api/advertiser/forgot-password', { body: { email: ' OWNER@cafe.example' } })
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { ok: true })
    })
    assert.equal(mail.length, 1)
    const [message] = mail
    assert.deepEqual(Object.keys(message).sort(), ['companyName', 'resetUrl', 'to'])
    assert.equal(message.to, ADVERTISER.email)
    assert.equal(message.companyName, ADVERTISER.company_name)
    const prefix = 'https://app.example/advertise/reset-password?token='
    assert.ok(message.resetUrl.startsWith(prefix), message.resetUrl)
    const token = decodeURIComponent(message.resetUrl.slice(prefix.length))
    assert.ok(token.length >= 40, 'a 32-byte token')

    assert.equal(db.advertiser_password_resets.length, 1)
    const [row] = db.advertiser_password_resets
    assert.deepEqual(Object.keys(row).sort(), ['advertiser_id', 'created_at', 'expires_at', 'id', 'token_hash'])
    assert.match(row.id, UUID_RE)
    assert.equal(row.advertiser_id, ADVERTISER.id)
    assert.equal(row.token_hash, hashResetToken(token))
    assert.ok(!JSON.stringify(row).includes(token), 'the raw token is never stored')
    const ttl = Date.parse(row.expires_at) - Date.now()
    assert.ok(ttl > HOUR - 60 * 1000 && ttl <= HOUR, 'the token lives an hour')
    assert.ok(isRecent(row.created_at))
    // Delivered, so nothing is logged.
    assert.deepEqual(lines, [])
  })
})

test('with email off, the reset link is logged outside production and never in it', async () => {
  const skipped = async () => ({ sent: false, skipped: true })
  await withApp({ seed: { advertisers: [ADVERTISER] }, send: skipped }, async ({ call, mail }) => {
    const lines = await captureConsole(async () => {
      assert.equal((await call('POST', '/api/advertiser/forgot-password', { body: { email: ADVERTISER.email } })).status, 200)
    })
    assert.deepEqual(lines, [`[advertiser reset] email disabled - reset link for ${ADVERTISER.email}: ${mail[0].resetUrl}`])
  })
  await withApp({ seed: { advertisers: [ADVERTISER] }, send: skipped, isProduction: true }, async ({ call, mail }) => {
    const lines = await captureConsole(async () => {
      assert.equal((await call('POST', '/api/advertiser/forgot-password', { body: { email: ADVERTISER.email } })).status, 200)
    })
    const token = new URL(mail[0].resetUrl).searchParams.get('token')
    assert.deepEqual(lines, ['[advertiser reset] email is not configured; reset link was not delivered'])
    assert.ok(lines.every((line) => !line.includes(token)))
  })
})

test('forgot-password answers 503 naming the resets migration when its table is missing, and 500 when the mail fails', async () => {
  await withApp({ seed: { advertisers: [ADVERTISER] } }, async ({ call, failures, mail }) => {
    failures.advertiser_password_resets = (chain) =>
      operation(chain) === 'insert' ? { code: '42P01', message: 'relation "public.advertiser_password_resets" does not exist' } : null
    const lines = await captureConsole(async () => {
      const res = await call('POST', '/api/advertiser/forgot-password', { body: { email: ADVERTISER.email } })
      assert.equal(res.status, 503)
      assert.deepEqual(res.body, {
        error: { message: 'Password reset is not set up yet. Please try again later.', code: 'advertiser_schema_missing', status: 503 },
      })
    })
    assert.ok(lines.some((line) => line.includes('db/supabase-advertiser-password-resets.sql')), lines.join('\n'))
    assert.deepEqual(mail, [], 'no link is mailed for a token that was never stored')
  })
  const failing = async () => {
    throw new Error('Resend send failed (500): upstream down')
  }
  await withApp({ seed: { advertisers: [ADVERTISER] }, send: failing }, async ({ call, failures }) => {
    await captureConsole(async () => {
      const res = await call('POST', '/api/advertiser/forgot-password', { body: { email: ADVERTISER.email } })
      assert.equal(res.status, 500)
      assert.deepEqual(res.body, { error: { message: 'Could not send the reset email. Please try again.', status: 500 } })
      failures.advertisers = () => SCHEMA_MISSING
      const lookup = await call('POST', '/api/advertiser/forgot-password', { body: { email: ADVERTISER.email } })
      assert.equal(lookup.status, 503)
      assert.deepEqual(lookup.body, PORTAL_503)
    })
  })
})

test('reset-password refuses a bad body and an unknown, spent or expired token without touching a password', async () => {
  const seed = {
    advertisers: [ADVERTISER],
    advertiser_password_resets: [
      resetRow('spent-token', { used_at: '2026-09-01T00:00:00.000Z' }),
      resetRow('expired-token', { expires_at: new Date(Date.now() - 1000).toISOString() }),
    ],
  }
  await withApp({ seed }, async ({ call, db, supabase }) => {
    for (const [body, expected] of [
      [{ token: '  ', password: NEW_PASSWORD }, BAD_RESET_LINK],
      [{ token: 'spent-token', password: 'short' }, { error: { message: 'Password must be at least 8 characters.', status: 400 } }],
    ]) {
      const res = await call('POST', '/api/advertiser/reset-password', { body })
      assert.equal(res.status, 400)
      assert.deepEqual(res.body, expected)
    }
    assert.equal(supabase.queries.length, 0)

    for (const token of ['never-issued', 'spent-token', 'expired-token']) {
      const res = await call('POST', '/api/advertiser/reset-password', { body: { token, password: NEW_PASSWORD } })
      assert.equal(res.status, 400, token)
      assert.deepEqual(res.body, BAD_RESET_LINK)
    }
    // Each lookup is by the token's hash, among the unused rows only.
    const lookups = supabase.queriesOf('advertiser_password_resets')
    assert.equal(lookups.length, 3)
    for (const [i, token] of ['never-issued', 'spent-token', 'expired-token'].entries()) {
      assert.equal(operation(lookups[i].chain), 'select')
      assert.ok(hasCall(lookups[i].chain, 'eq', 'token_hash', hashResetToken(token)), token)
      assert.ok(hasCall(lookups[i].chain, 'is', 'used_at', null), token)
    }
    assert.equal(supabase.queriesOf('advertisers').length, 0)
    assert.equal(db.advertisers[0].password_hash, ADVERTISER.password_hash)
  })
})

test('reset-password sets the new hash for the token owner alone and burns their open tokens, so a link works once', async () => {
  const TOKEN = 'reset-token-for-tests'
  const spentAt = '2026-09-01T00:00:00.000Z'
  const seed = {
    advertisers: [ADVERTISER, OTHER],
    advertiser_password_resets: [
      resetRow(TOKEN),
      resetRow('older-open-token'),
      resetRow('spent-token', { used_at: spentAt }),
      resetRow('other-open-token', { advertiser_id: OTHER.id }),
    ],
  }
  await withApp({ seed }, async ({ call, db, supabase }) => {
    const res = await call('POST', '/api/advertiser/reset-password', { body: { token: TOKEN, password: NEW_PASSWORD } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })

    const [update] = supabase.queriesOf('advertisers')
    assert.equal(operation(update.chain), 'update')
    assert.ok(hasCall(update.chain, 'eq', 'id', ADVERTISER.id))
    const mine = db.advertisers.find((a) => a.id === ADVERTISER.id)
    assert.ok(verifyPassword(NEW_PASSWORD, mine.password_hash), 'the new password signs in')
    assert.ok(!verifyPassword(PASSWORD, mine.password_hash), 'the old one does not')
    assert.ok(isRecent(mine.updated_at))
    assert.equal(db.advertisers.find((a) => a.id === OTHER.id).password_hash, OTHER.password_hash)

    const burn = supabase.queriesOf('advertiser_password_resets').find((q) => operation(q.chain) === 'update')
    assert.ok(hasCall(burn.chain, 'eq', 'advertiser_id', ADVERTISER.id))
    assert.ok(hasCall(burn.chain, 'is', 'used_at', null))
    const usedAt = (token) => db.advertiser_password_resets.find((r) => r.token_hash === hashResetToken(token)).used_at
    assert.ok(isRecent(usedAt(TOKEN)), 'the token is spent')
    assert.ok(isRecent(usedAt('older-open-token')), "the advertiser's other open token is spent too")
    assert.equal(usedAt('spent-token'), spentAt, 'a spent token keeps when it was spent')
    assert.equal(usedAt('other-open-token'), null, "another advertiser's token is left alone")

    const replay = await call('POST', '/api/advertiser/reset-password', { body: { token: TOKEN, password: 'yet another passphrase' } })
    assert.equal(replay.status, 400)
    assert.deepEqual(replay.body, BAD_RESET_LINK)
    assert.ok(verifyPassword(NEW_PASSWORD, db.advertisers.find((a) => a.id === ADVERTISER.id).password_hash))
  })
})

// ── Campaigns ───────────────────────────────────────────────────────────────

test("the campaign list holds the signed-in advertiser's campaigns alone, newest first", async () => {
  const older = campaignRow()
  const newer = campaignRow({ status: 'pending_review' })
  const theirs = campaignRow({ advertiser_id: OTHER.id })
  await withApp({ seed: { advertisers: [ADVERTISER, OTHER], campaigns: [older, theirs, newer] } }, async ({ call, sessionFor, supabase }) => {
    const cookie = await sessionFor({ advertiserId: ADVERTISER.id })
    const res = await call('GET', '/api/advertiser/campaigns', { cookie })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { campaigns: [mapCampaignRow(newer), mapCampaignRow(older)] })
    const [list] = supabase.queriesOf('campaigns')
    assert.ok(hasCall(list.chain, 'eq', 'advertiser_id', ADVERTISER.id))
    assert.ok(hasCall(list.chain, 'order', 'created_at', { ascending: false }))
  })
})

test("a new campaign is always a draft, and the cap counts this advertiser's drafts alone", async () => {
  const body = {
    name: ' Fall promo ',
    placement: 'dining',
    startsOn: '2026-10-01',
    endsOn: '2026-10-31',
    creative: { headline: 'Half off lattes', ctaUrl: 'https://cafe.example' },
    status: 'active',
  }
  const drafts = (n, overrides) => Array.from({ length: n }, () => campaignRow({ status: 'draft', ...overrides }))

  await withApp({ seed: { advertisers: [ADVERTISER], campaigns: drafts(MAX_DRAFT_CAMPAIGNS) } }, async ({ call, sessionFor, supabase }) => {
    const cookie = await sessionFor({ advertiserId: ADVERTISER.id })
    const res = await call('POST', '/api/advertiser/campaigns', { body, cookie })
    assert.equal(res.status, 409)
    assert.deepEqual(res.body, { error: { message: DRAFT_CAMPAIGNS_CAP_MESSAGE, status: 409 } })
    const [count] = supabase.queriesOf('campaigns')
    assert.ok(hasCall(count.chain, 'select', 'id', { count: 'exact', head: true }))
    assert.ok(hasCall(count.chain, 'eq', 'advertiser_id', ADVERTISER.id))
    assert.ok(hasCall(count.chain, 'eq', 'status', 'draft'))
    assert.equal(supabase.queriesOf('campaigns').filter((q) => operation(q.chain) === 'insert').length, 0)
  })

  const seed = {
    advertisers: [ADVERTISER, OTHER],
    campaigns: [
      ...drafts(MAX_DRAFT_CAMPAIGNS - 1),
      ...drafts(3, { status: 'pending_review' }),
      ...drafts(MAX_DRAFT_CAMPAIGNS, { advertiser_id: OTHER.id }),
    ],
  }
  await withApp({ seed }, async ({ call, sessionFor, db, supabase }) => {
    const cookie = await sessionFor({ advertiserId: ADVERTISER.id })
    const invalid = await call('POST', '/api/advertiser/campaigns', { body: { placement: 'dining' }, cookie })
    assert.equal(invalid.status, 400)
    assert.deepEqual(invalid.body, { error: { message: 'Campaign name is required and must be 200 characters or fewer.', status: 400 } })
    assert.equal(supabase.queriesOf('campaigns').length, 0)

    const res = await call('POST', '/api/advertiser/campaigns', { body, cookie })
    assert.equal(res.status, 201)
    const inserted = db.campaigns.at(-1)
    const { id, created_at: createdAt, updated_at: updatedAt, ...columns } = inserted
    assert.match(id, UUID_RE)
    assert.ok(isRecent(createdAt))
    assert.equal(updatedAt, createdAt)
    // A draft, whatever the body asked for.
    assert.deepEqual(columns, {
      advertiser_id: ADVERTISER.id,
      name: 'Fall promo',
      placement: 'dining',
      starts_on: '2026-10-01',
      ends_on: '2026-10-31',
      creative: { headline: 'Half off lattes', ctaUrl: 'https://cafe.example/' },
      status: 'draft',
    })
    assert.deepEqual(res.body, { campaign: mapCampaignRow(inserted) })
  })
})

test("PATCH answers 404 for another advertiser's campaign, 400 for draft to active, and updates its own scoped twice", async () => {
  const mine = campaignRow({ id: CAMPAIGN_ID, status: 'draft' })
  const theirs = campaignRow({ advertiser_id: OTHER.id, status: 'draft' })
  await withApp({ seed: { advertisers: [ADVERTISER, OTHER], campaigns: [mine, theirs] } }, async ({ call, sessionFor, db, supabase }) => {
    const cookie = await sessionFor({ advertiserId: ADVERTISER.id })
    const updates = () => supabase.queriesOf('campaigns').filter((q) => operation(q.chain) === 'update')

    const other = await call('PATCH', `/api/advertiser/campaigns/${theirs.id}`, { body: { name: 'Mine now' }, cookie })
    assert.equal(other.status, 404)
    assert.deepEqual(other.body, { error: { message: 'Campaign not found.', status: 404 } })
    const [lookup] = supabase.queriesOf('campaigns')
    assert.ok(hasCall(lookup.chain, 'eq', 'id', theirs.id))
    assert.ok(hasCall(lookup.chain, 'eq', 'advertiser_id', ADVERTISER.id))

    const live = await call('PATCH', `/api/advertiser/campaigns/${mine.id}`, { body: { status: 'active' }, cookie })
    assert.equal(live.status, 400)
    assert.deepEqual(live.body, {
      error: { message: 'A campaign must be approved before it can go live. Submit it for review instead.', status: 400 },
    })
    assert.equal(updates().length, 0)

    const renamed = await call('PATCH', `/api/advertiser/campaigns/${mine.id}`, { body: { name: 'Renamed' }, cookie })
    assert.equal(renamed.status, 200)
    const row = db.campaigns.find((c) => c.id === mine.id)
    assert.equal(row.name, 'Renamed')
    assert.ok(isRecent(row.updated_at))
    assert.deepEqual(renamed.body, { campaign: mapCampaignRow(row) })
    const [update] = updates()
    assert.ok(hasCall(update.chain, 'eq', 'id', mine.id))
    assert.ok(hasCall(update.chain, 'eq', 'advertiser_id', ADVERTISER.id))
    assert.equal(db.campaigns.find((c) => c.id === theirs.id).name, theirs.name)
  })
})

test('stats runs two head counts on the campaign, answers ctr 0 with no impressions, and 404 for a campaign not its own', async () => {
  const mine = campaignRow({ id: CAMPAIGN_ID, status: 'active' })
  const quiet = campaignRow({ status: 'active' })
  const theirs = campaignRow({ advertiser_id: OTHER.id, status: 'active' })
  const event = (campaign, kind) => ({ id: crypto.randomUUID(), campaign_id: campaign.id, kind, occurred_at: '2026-10-02T12:00:00.000Z' })
  const seed = {
    advertisers: [ADVERTISER, OTHER],
    campaigns: [mine, quiet, theirs],
    ad_events: [
      ...Array.from({ length: 4 }, () => event(mine, 'impression')),
      event(mine, 'tap'),
      ...Array.from({ length: 3 }, () => event(theirs, 'impression')),
      event(theirs, 'tap'),
    ],
  }
  await withApp({ seed }, async ({ call, sessionFor, supabase }) => {
    const cookie = await sessionFor({ advertiserId: ADVERTISER.id })
    const res = await call('GET', `/api/advertiser/campaigns/${mine.id}/stats`, { cookie })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { stats: { impressions: 4, taps: 1, ctr: 0.25 } })
    const counts = supabase.queriesOf('ad_events')
    assert.equal(counts.length, 2)
    for (const [i, kind] of ['impression', 'tap'].entries()) {
      assert.ok(hasCall(counts[i].chain, 'select', '*', { count: 'exact', head: true }))
      assert.ok(hasCall(counts[i].chain, 'eq', 'campaign_id', mine.id))
      assert.ok(hasCall(counts[i].chain, 'eq', 'kind', kind))
    }

    const none = await call('GET', `/api/advertiser/campaigns/${quiet.id}/stats`, { cookie })
    assert.deepEqual(none.body, { stats: { impressions: 0, taps: 0, ctr: 0 } })

    const other = await call('GET', `/api/advertiser/campaigns/${theirs.id}/stats`, { cookie })
    assert.equal(other.status, 404)
    assert.deepEqual(other.body, { error: { message: 'Campaign not found.', status: 404 } })
    assert.equal(supabase.queriesOf('ad_events').length, 4, 'no count for a campaign not its own')
  })
})

// ── Spotlight ───────────────────────────────────────────────────────────────

test("spotlight serves the placement's live campaigns through a 60 second cache, falling back to home-widget", async () => {
  const live = campaignRow({ status: 'active', creative: { headline: 'Live now', ctaUrl: 'https://cafe.example/' } })
  const paused = campaignRow({ status: 'paused' })
  const over = campaignRow({ status: 'active', ends_on: '2000-01-31' })
  const later = campaignRow({ status: 'active', starts_on: '2999-01-01' })
  const dining = campaignRow({ status: 'active', placement: 'dining', advertiser_id: OTHER.id })
  await withApp({ seed: { campaigns: [live, paused, over, later, dining] } }, async ({ call, sessionFor, supabase, cacheCalls }) => {
    const cookie = await sessionFor({ userId: STUDENT_ID })
    for (const path of ['/api/spotlight/active', '/api/spotlight/active?placement=nowhere']) {
      const res = await call('GET', path, { cookie })
      assert.equal(res.status, 200, path)
      assert.deepEqual(res.body, { ad: toServedAd(live), ads: [toServedAd(live)] })
    }
    const res = await call('GET', '/api/spotlight/active?placement=dining', { cookie })
    assert.deepEqual(res.body, { ad: toServedAd(dining), ads: [toServedAd(dining)] })
    assert.deepEqual(cacheCalls, [
      { key: 'spotlight:home-widget', ttlMs: 60000 },
      { key: 'spotlight:home-widget', ttlMs: 60000 },
      { key: 'spotlight:dining', ttlMs: 60000 },
    ])
    const [read] = supabase.queriesOf('campaigns')
    assert.ok(hasCall(read.chain, 'select', 'id, placement, status, starts_on, ends_on, creative'))
    assert.ok(hasCall(read.chain, 'eq', 'placement', 'home-widget'))
    assert.ok(hasCall(read.chain, 'eq', 'status', 'active'))
  })
})

test('spotlight clamps limit to 1..12, and a failed read serves no ad', async () => {
  const live = Array.from({ length: 15 }, () => campaignRow({ status: 'active' }))
  const ids = new Set(live.map((c) => c.id))
  await withApp({ seed: { campaigns: live } }, async ({ call, sessionFor, failures }) => {
    const cookie = await sessionFor({ userId: STUDENT_ID })
    for (const [limit, count] of [['3', 3], ['50', 12], ['0', 1], ['-4', 1], ['lots', 1]]) {
      const res = await call('GET', `/api/spotlight/active?limit=${limit}`, { cookie })
      assert.equal(res.status, 200)
      assert.equal(res.body.ads.length, count, `limit=${limit}`)
      assert.deepEqual(res.body.ad, res.body.ads[0])
      assert.equal(new Set(res.body.ads.map((ad) => ad.campaignId)).size, count, 'no campaign twice')
      assert.ok(res.body.ads.every((ad) => ids.has(ad.campaignId)))
    }

    failures.campaigns = () => DB_DOWN
    const lines = await captureConsole(async () => {
      const res = await call('GET', '/api/spotlight/active?limit=4', { cookie })
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { ad: null, ads: [] })
    })
    assert.deepEqual(lines, ['[/api/spotlight/active] query failed: connection reset'])
  })
})

test('the event refuses a bad kind and a campaign that is not live, and records a live one with 204', async () => {
  const live = campaignRow({ id: CAMPAIGN_ID, status: 'active' })
  const paused = campaignRow({ status: 'paused' })
  const ended = campaignRow({ status: 'active', ends_on: '2000-01-31' })
  await withApp({ seed: { campaigns: [live, paused, ended] } }, async ({ call, sessionFor, db, supabase }) => {
    const cookie = await sessionFor({ userId: STUDENT_ID })
    const kind = await call('POST', `/api/spotlight/${live.id}/event`, { body: { kind: 'click' }, cookie })
    assert.equal(kind.status, 400)
    assert.deepEqual(kind.body, { error: { message: 'Invalid ad event kind.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    for (const id of [paused.id, ended.id, 'ffffffff-ffff-4fff-8fff-ffffffffffff']) {
      const res = await call('POST', `/api/spotlight/${id}/event`, { body: { kind: 'impression' }, cookie })
      assert.equal(res.status, 400, id)
      assert.deepEqual(res.body, { error: { message: 'Campaign is not active.', status: 400 } })
    }
    assert.deepEqual(db.ad_events, [])

    const res = await call('POST', `/api/spotlight/${live.id}/event`, { body: { kind: 'tap' }, cookie })
    assert.equal(res.status, 204)
    assert.equal(res.text, '')
    const lookup = supabase.queriesOf('campaigns').at(-1)
    assert.ok(hasCall(lookup.chain, 'select', 'id, status, starts_on, ends_on'))
    assert.ok(hasCall(lookup.chain, 'eq', 'id', live.id))
    assert.ok(hasCall(lookup.chain, 'maybeSingle'))
    assert.equal(db.ad_events.length, 1)
    const { id, occurred_at: occurredAt, ...event } = db.ad_events[0]
    assert.match(id, UUID_RE)
    assert.ok(isRecent(occurredAt))
    assert.deepEqual(event, { campaign_id: live.id, kind: 'tap' })
  })
})

test('the event answers 202 when the campaign lookup or the insert fails', async () => {
  const live = campaignRow({ id: CAMPAIGN_ID, status: 'active' })
  await withApp({ seed: { campaigns: [live] } }, async ({ call, sessionFor, failures, db }) => {
    const cookie = await sessionFor({ userId: STUDENT_ID })
    const lines = await captureConsole(async () => {
      failures.campaigns = () => DB_DOWN
      const lookup = await call('POST', `/api/spotlight/${live.id}/event`, { body: { kind: 'impression' }, cookie })
      assert.equal(lookup.status, 202)
      assert.deepEqual(lookup.body, { ok: false })

      delete failures.campaigns
      failures.ad_events = () => DB_DOWN
      const insert = await call('POST', `/api/spotlight/${live.id}/event`, { body: { kind: 'impression' }, cookie })
      assert.equal(insert.status, 202)
      assert.deepEqual(insert.body, { ok: false })
    })
    assert.deepEqual(lines, [
      '[/api/spotlight/event] campaign lookup failed: connection reset',
      '[/api/spotlight/event] insert failed: connection reset',
    ])
    assert.deepEqual(db.ad_events, [])
  })
})
