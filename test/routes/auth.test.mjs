import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { format } from 'node:util'
import express from 'express'
import session from 'express-session'
import { createAuthRouter } from '../../src/routes/auth.mjs'
import { createOnboardingSummaryCache } from '../../src/onboardingSummaryCache.mjs'
import { hashPassword } from '../../src/passwordHash.mjs'
import { SESSION_COOKIE_NAME } from '../../src/publicReadKey.mjs'
import { createPurdueLinkHandoff } from '../../src/purdueLinkHandoff.mjs'
import { isSessionStale } from '../../src/sessionFreshness.mjs'
import { UpstreamError } from '../../src/upstreamFetch.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: student auth, the profile and the Purdue link as a feature
// router, booted on a small app behind the real express-session (a
// MemoryStore under the server's cookie name, rolling as on the server) with
// express.json, express.urlencoded and the req.body shim in front, so
// regenerate, save and destroy and the cookie they send are the real ones.
// getUserById, getCurrentUser and requireAuth read an in-memory users table
// the way the server's do (getCurrentUser applies isSessionStale), the
// Supabase client is the recording fake plus an `auth` fake, the limiters
// record their hits, the Purdue link handoff is the real one, and a local CAS
// stub answers PURDUE_CAS_VALIDATE_URL.

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'
const PASSWORD = 'correct horse battery'
const NEW_PASSWORD = 'a brand new passphrase'
const CLIENT = 'https://app.example'
const BACKEND = 'https://api.example'
const CAS_LOGIN = 'https://cas.example/cas/login'
const HANDOFF_SECRET = 'auth-router-test-handoff-secret-0123456789'
const DAY = 24 * 60 * 60 * 1000

const STUDENT = {
  id: U1,
  email: 'pete@example.com',
  display_name: 'Pete',
  auth_provider: 'email',
  password_hash: '',
  purdue_email: null,
  purdue_username: null,
  analytics_opt_out: false,
  password_changed_at: null,
  is_admin: false,
}
const OTHER = { ...STUDENT, id: U2, email: 'other@example.com', display_name: 'Other' }

const SIGNED_OUT_401 = { error: { message: 'You must sign in to access this resource.', status: 401 } }
const AUTH_CONFIG_MOCK = {
  authProvider: 'local',
  purdueAuthMode: 'mock',
  supportsPurdueLink: true,
  supportedSources: ['purdue_schedule_ical', 'brightspace_ical'],
}

const ROUTES = [
  ['GET', '/api/auth-config'],
  ['GET', '/api/session'],
  ['POST', '/api/auth/register-supabase', {}],
  ['POST', '/api/auth/sign-in', {}],
  ['POST', '/api/sign-out'],
  ['POST', '/api/auth/supabase-sync', {}],
  ['GET', '/auth/purdue/connect'],
  ['POST', '/auth/purdue/dev/link', {}],
  ['POST', '/api/purdue/mock-link', {}],
  ['POST', '/api/purdue/link-token'],
  ['GET', '/auth/purdue/callback'],
  ['GET', '/api/me/profile'],
  ['PATCH', '/api/me/profile', {}],
  ['POST', '/api/me/delete-account', {}],
]

const TABLES = ['users', 'linked_sources', 'calendar_items', 'sign_in_challenges']

// One table of the in-memory database, answering a recorded chain the way
// PostgREST would: eq, neq and is filters, a head count, insert, update and
// delete (rows come back when the chain selects them), and single (PGRST116
// unless exactly one row matched).
function answer(table, chain) {
  const filters = chain.filter((c) => ['eq', 'neq', 'is'].includes(c.method))
  const matches = (row) =>
    filters.every(({ method, args: [column, value] }) => {
      if (method === 'is') return (row[column] ?? null) === value
      if (method === 'neq') return row[column] !== value
      return row[column] === value
    })
  const op = operation(chain)
  let rows
  if (op === 'insert') {
    rows = [].concat(chain.find((c) => c.method === 'insert').args[0]).map((row) => ({ ...row }))
    table.push(...rows)
  } else if (op === 'update') {
    const patch = chain.find((c) => c.method === 'update').args[0]
    rows = table.filter(matches)
    for (const row of rows) Object.assign(row, patch)
  } else if (op === 'delete') {
    rows = table.filter(matches)
    for (const row of rows) table.splice(table.indexOf(row), 1)
  } else {
    rows = table.filter(matches)
    if (chain.find((c) => c.method === 'select')?.args[1]?.head) return { data: null, count: rows.length, error: null }
  }
  const copies = rows.map((row) => structuredClone(row))
  if (hasCall(chain, 'single')) {
    return copies.length === 1
      ? { data: copies[0], error: null }
      : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
  }
  if (op !== 'select' && !hasCall(chain, 'select')) return { data: null, error: null }
  return { data: copies, error: null }
}

/** A local CAS: answers /cas/serviceValidate from `cas`, recording each service and ticket. */
async function startCas(cas) {
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ service: url.searchParams.get('service'), ticket: url.searchParams.get('ticket') })
    if (cas.status && cas.status !== 200) {
      res.writeHead(cas.status, { 'Content-Type': 'text/plain' })
      return res.end('CAS is down')
    }
    res.writeHead(200, { 'Content-Type': 'application/xml' })
    if (!cas.user) return res.end('<cas:serviceResponse><cas:authenticationFailure code="INVALID_TICKET"/></cas:serviceResponse>')
    const mail = cas.mail ? `<cas:attributes><cas:mail>${cas.mail}</cas:mail></cas:attributes>` : ''
    res.end(`<cas:serviceResponse><cas:authenticationSuccess><cas:user>${cas.user}</cas:user>${mail}</cas:authenticationSuccess></cas:serviceResponse>`)
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, requests, validateUrl: `http://127.0.0.1:${server.address().port}/cas/serviceValidate` }
}

async function withApp(options, run) {
  const {
    seed = {},
    purdueAuthMode = 'mock',
    gotrue: gotrueSeed = {},
    tokens = {},
    verifyError = null,
    authErrors = {},
    newAuthId = U3,
    linkError = null,
    block = [],
    cas = null,
    adminEmails = [],
    twoFactor = false,
    syncGate = false,
    production = false,
    emailConfigured = true,
    // Sends that throw, as a Resend outage would, before the rest go through.
    failedSends = 0,
    // Milliseconds each session read and write waits, so parallel requests each
    // load the session before any of them saves, as on a remote store.
    storeDelayMs = 0,
    // Milliseconds each query waits before it runs, so the queries of parallel
    // requests interleave. Each still runs whole when its turn comes, as one SQL
    // statement does, which is what makes a compare-and-swap hold. A function
    // (table, chain) => ms slows one kind of query more than the rest.
    dbDelayMs = 0,
  } = options
  const purdueLinkingEnabled = purdueAuthMode !== 'off'
  const db = Object.fromEntries(TABLES.map((name) => [name, structuredClone(seed[name] ?? [])]))
  const failures = {}
  const supabase = fakeSupabase(
    Object.fromEntries(
      TABLES.map((name) => [
        name,
        (chain) => {
          const run = () => {
            const error = failures[name]?.(chain)
            return error ? { data: null, count: null, error } : answer(db[name], chain)
          }
          const delay = typeof dbDelayMs === 'function' ? dbDelayMs(name, chain) : dbDelayMs
          return delay ? new Promise((resolve) => setTimeout(() => resolve(run()), delay)) : run()
        },
      ]),
    ),
  )
  // Supabase Auth: email -> { id, password, metadata }.
  const gotrue = structuredClone(gotrueSeed)
  const authCalls = []
  supabase.auth = {
    async getUser(token) {
      authCalls.push(['getUser', token])
      const user = tokens[token]
      return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }
    },
    admin: {
      async createUser(attrs) {
        authCalls.push(['createUser', attrs])
        if (authErrors.createUser) return { data: null, error: authErrors.createUser }
        if (gotrue[attrs.email]) return { data: null, error: { code: 'email_exists', message: 'A user with this email address has already been registered' } }
        gotrue[attrs.email] = { id: newAuthId, password: attrs.password, metadata: attrs.user_metadata }
        return { data: { user: { id: newAuthId, email: attrs.email } }, error: null }
      },
      async updateUserById(id, attrs) {
        authCalls.push(['updateUserById', id, attrs])
        if (authErrors.updateUserById) return { data: null, error: authErrors.updateUserById }
        const entry = Object.values(gotrue).find((e) => e.id === id)
        if (entry && attrs.password) entry.password = attrs.password
        return { data: {}, error: null }
      },
      async deleteUser(id) {
        authCalls.push(['deleteUser', id])
        return { data: null, error: authErrors.deleteUser ?? null }
      },
    },
  }
  const verifyCalls = []
  const verifySupabasePassword = async (email, password) => {
    verifyCalls.push([email, password])
    if (verifyError) throw verifyError
    const entry = gotrue[email]
    return entry && entry.password === password ? { id: entry.id, email, user_metadata: entry.metadata || {} } : null
  }
  // The session core, as server.mjs has it, over the in-memory users table.
  const lookups = []
  const getUserById = async (userId) => {
    if (!userId) return null
    lookups.push(userId)
    const row = db.users.find((u) => u.id === userId)
    return row ? structuredClone(row) : null
  }
  const getCurrentUser = async (req) => {
    const user = await getUserById(req.session.userId)
    if (!user) return null
    if (isSessionStale(user.password_changed_at, req.session.authAt)) return null
    return user
  }
  const requireAuth = async (req, res, next) => {
    const user = await getCurrentUser(req)
    if (!user) return res.status(401).json(SIGNED_OUT_401)
    req.currentUser = user
    next()
  }
  const admins = new Set(adminEmails)
  const isUserAdmin = (user) => {
    if (!user?.email) return false
    if (user.is_admin) return true
    return admins.has(String(user.email).trim().toLowerCase())
  }
  const linkCalls = []
  const linkPurdueIdentity = async (userId, { email }) => {
    linkCalls.push([userId, email])
    if (linkError) throw linkError
    const row = db.users.find((u) => u.id === userId)
    Object.assign(row, { purdue_email: email, purdue_username: email.split('@')[0] })
    return structuredClone(row)
  }
  const onboardingSummaryCache = createOnboardingSummaryCache()
  const invalidated = []
  const realInvalidate = onboardingSummaryCache.invalidate.bind(onboardingSummaryCache)
  onboardingSummaryCache.invalidate = (userId) => {
    invalidated.push(userId)
    return realInvalidate(userId)
  }
  const purdueLinkHandoff = createPurdueLinkHandoff({ secret: HANDOFF_SECRET })
  const limiterHits = []
  const limiter = (name) => (req, res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    if (!block.includes(name)) return next()
    if (name === 'purdue-link-flow') return res.redirect(`${CLIENT}/settings?error=purdue-link-throttled`)
    res.status(429).json({ error: { message: 'Too many requests.', status: 429 } })
  }

  // Mail the router sends; `codes` holds each two-step code it carried.
  const mail = []
  const codes = []
  let sendsToFail = failedSends
  const sendEmail = async (message) => {
    if (sendsToFail > 0) {
      sendsToFail -= 1
      throw new Error('Resend send failed (500): outage')
    }
    mail.push(message)
    const code = />(\d{6})</.exec(message.html)?.[1]
    if (code) codes.push(code)
    return emailConfigured ? { sent: true } : { sent: false, skipped: true }
  }
  // The login-code-mail window: records the account each code email is
  // counted against, and is over its cap when the test blocks it.
  const mailWindowHits = []
  const signInCodeMailWindow = {
    hit(key) {
      mailWindowHits.push(key)
      return { allowed: !block.includes('login-code-mail'), resetAt: Date.now() + 60 * 60 * 1000 }
    },
  }

  const savedEnv = { login: process.env.PURDUE_CAS_LOGIN_URL, validate: process.env.PURDUE_CAS_VALIDATE_URL, dev: process.env.DEV_PURDUE_EMAIL }
  delete process.env.DEV_PURDUE_EMAIL
  let casStub = null
  if (cas) {
    casStub = await startCas(cas)
    process.env.PURDUE_CAS_LOGIN_URL = CAS_LOGIN
    process.env.PURDUE_CAS_VALIDATE_URL = casStub.validateUrl
  } else {
    delete process.env.PURDUE_CAS_LOGIN_URL
    delete process.env.PURDUE_CAS_VALIDATE_URL
  }

  const store = new session.MemoryStore()
  if (storeDelayMs) {
    for (const method of ['get', 'set']) {
      const original = store[method].bind(store)
      store[method] = (...args) => setTimeout(() => original(...args), storeDelayMs)
    }
  }
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  // server.mjs's body shim (issue #291): Express 5 leaves req.body undefined on a bodyless request.
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {}
    next()
  })
  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: 'auth-router-test-session-secret',
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 14 * DAY },
    }),
  )
  // Test only: merge the body into the session.
  app.post('/test/session', (req, res) => {
    Object.assign(req.session, req.body)
    res.json({ ok: true })
  })
  app.use(
    createAuthRouter({
      supabase,
      requireAuth,
      getCurrentUser,
      getUserById,
      isUserAdmin,
      verifySupabasePassword,
      linkPurdueIdentity,
      onboardingSummaryCache,
      purdueLinkHandoff,
      publicBaseUrl: BACKEND,
      clientAppUrl: CLIENT,
      purdueAuthMode,
      purdueLinkingEnabled,
      accountCreateRateLimit: limiter('account-create'),
      signInRateLimit: limiter('sign-in'),
      sessionSyncIpRateLimit: limiter('session-sync-ip'),
      sessionSyncRateLimit: limiter('session-sync'),
      purdueLinkTokenRateLimit: limiter('purdue-link-token'),
      purdueLinkFlowRateLimit: limiter('purdue-link-flow'),
      userWriteRateLimit: limiter('user-write'),
      loginCodeRateLimit: limiter('login-code'),
      loginCodeAccountRateLimit: limiter('login-code-account'),
      loginCodeSendRateLimit: limiter('login-code-send'),
      signInCodeMailWindow,
      loginTwoFactorEnabled: twoFactor,
      loginTwoFactorSyncGate: syncGate,
      twoFactorSecret: 'auth-router-test-two-factor-secret',
      sendEmail,
      isEmailConfigured: () => emailConfigured,
      isProduction: production,
    }),
  )
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const call = async (method, path, { body, form, cookie, headers: extra = {} } = {}) => {
    const headers = { ...extra }
    let payload
    if (form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      payload = new URLSearchParams(form).toString()
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    if (cookie) headers.Cookie = cookie
    const response = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' })
    const text = await response.text()
    const setCookies = response.headers.getSetCookie()
    const pairs = setCookies.map((c) => c.split(';')[0]).filter((p) => p.startsWith(`${SESSION_COOKIE_NAME}=`))
    const live = pairs.find((p) => p.length > SESSION_COOKIE_NAME.length + 1) ?? null
    const isJson = (response.headers.get('content-type') || '').includes('application/json')
    return {
      status: response.status,
      text,
      body: isJson && text ? JSON.parse(text) : null,
      type: response.headers.get('content-type') || '',
      location: response.headers.get('location'),
      setCookies,
      sessionCookie: setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? null,
      cookie: live,
      cleared: pairs.some((p) => p === `${SESSION_COOKIE_NAME}=`),
    }
  }
  const sessionFor = async (fields) => {
    const res = await call('POST', '/test/session', { body: fields })
    assert.ok(res.cookie, 'the test session got a cookie')
    return res.cookie
  }
  // Every session in the store.
  const sessions = () =>
    new Promise((resolve, reject) => {
      store.all((err, all) => {
        if (err) return reject(err)
        resolve(Object.entries(all || {}).map(([sid, s]) => ({ sid, ...s })))
      })
    })
  const sidOf = (cookie) => decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0]
  try {
    await run({
      call, sessionFor, sessions, sidOf, db, failures, supabase, gotrue, authCalls, verifyCalls, lookups,
      linkCalls, invalidated, onboardingSummaryCache, purdueLinkHandoff, limiterHits, cas: casStub, mail, codes,
      mailWindowHits,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (casStub) await new Promise((resolve) => casStub.server.close(resolve))
    for (const [key, name] of [['login', 'PURDUE_CAS_LOGIN_URL'], ['validate', 'PURDUE_CAS_VALIDATE_URL'], ['dev', 'DEV_PURDUE_EMAIL']]) {
      if (savedEnv[key] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[key]
    }
  }
}

/** Every console line the block writes, while it runs. */
async function quietly(block) {
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
// express-session sends a lifetime as Expires: the seconds from now to it.
const maxAgeOf = (setCookie) => {
  const expires = /Expires=([^;]+)/i.exec(setCookie || '')?.[1]
  return expires ? Math.round((Date.parse(expires) - Date.now()) / DAY) * DAY / 1000 : NaN
}
// The same, in whole minutes, for a cookie that lives less than a day.
const minutesLeftOf = (setCookie) => {
  const expires = /Expires=([^;]+)/i.exec(setCookie || '')?.[1]
  return expires ? Math.round((Date.parse(expires) - Date.now()) / 60000) : NaN
}

// ── Signed out, limiters and the session read ───────────────────────────────

test('signed out: the limiter hit list across all fourteen routes, under the bucket names, and no query', async () => {
  await withApp({}, async ({ call, supabase, limiterHits, authCalls, verifyCalls }) => {
    const statuses = []
    for (const [method, path, body] of ROUTES) statuses.push((await call(method, path, { body })).status)
    assert.deepEqual(statuses, [200, 200, 400, 401, 200, 401, 401, 401, 401, 401, 401, 401, 401, 401])
    assert.deepEqual(limiterHits, [
      'account-create POST /api/auth/register-supabase',
      'sign-in POST /api/auth/sign-in',
      'session-sync-ip POST /api/auth/supabase-sync',
      'session-sync POST /api/auth/supabase-sync',
      'purdue-link-flow GET /auth/purdue/connect',
      'purdue-link-flow POST /auth/purdue/dev/link',
      'user-write POST /api/purdue/mock-link',
      'purdue-link-token POST /api/purdue/link-token',
      'purdue-link-flow GET /auth/purdue/callback',
      'sign-in PATCH /api/me/profile',
      'sign-in POST /api/me/delete-account',
    ])
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(authCalls, [])
    assert.deepEqual(verifyCalls, [])
  })
})

test('signed out: the auth-gated routes answer the 401 envelope, the session read is unauthenticated and sets no cookie', async () => {
  await withApp({}, async ({ call, supabase, linkCalls }) => {
    const gated = [
      ['POST', '/api/purdue/mock-link', { email: 'pete@purdue.edu' }],
      ['POST', '/api/purdue/link-token'],
      ['GET', '/api/me/profile'],
      ['PATCH', '/api/me/profile', { name: 'Pete' }],
      ['POST', '/api/me/delete-account', { password: PASSWORD, confirmation: 'DELETE' }],
      ['GET', '/auth/purdue/connect'],
      ['POST', '/auth/purdue/dev/link', { email: 'pete@purdue.edu' }],
      ['GET', '/auth/purdue/callback?ticket=ST-1&state=x'],
    ]
    for (const [method, path, body] of gated) {
      const res = await call(method, path, { body })
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.deepEqual(res.body, SIGNED_OUT_401)
    }
    const probe = await call('GET', '/api/session')
    assert.equal(probe.status, 200)
    assert.deepEqual(probe.body, { authenticated: false, session: null })
    assert.equal(probe.sessionCookie, null)
    const config = await call('GET', '/api/auth-config')
    assert.deepEqual(config.body, AUTH_CONFIG_MOCK)
    assert.equal(config.sessionCookie, null)
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(linkCalls, [])
  })
})

test('auth-config reports the Purdue mode and whether linking is on', async () => {
  await withApp({ purdueAuthMode: 'off' }, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/auth-config')).body, { ...AUTH_CONFIG_MOCK, purdueAuthMode: 'off', supportsPurdueLink: false })
  })
  await withApp({ purdueAuthMode: 'cas' }, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/auth-config')).body, { ...AUTH_CONFIG_MOCK, purdueAuthMode: 'cas' })
  })
})

test('a blocking flow limiter answers the three flow routes before any user lookup, with a token or a session', async () => {
  await withApp({ seed: { users: [STUDENT] }, block: ['purdue-link-flow'] }, async ({ call, sessionFor, lookups, purdueLinkHandoff, linkCalls, supabase }) => {
    const cookie = await sessionFor({ userId: U1 })
    const { token } = purdueLinkHandoff.issue(U1)
    const paths = [
      ['GET', '/auth/purdue/connect'],
      ['POST', '/auth/purdue/dev/link'],
      ['GET', '/auth/purdue/callback?ticket=ST-1'],
    ]
    for (const [method, path] of paths) {
      for (const opts of [{ cookie }, { cookie, form: { t: token, email: 'pete@purdue.edu' } }]) {
        const target = method === 'GET' && opts.form ? `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : path
        const res = await call(method, target, method === 'GET' ? { cookie } : opts)
        assert.equal(res.status, 302, `${method} ${target}`)
        assert.equal(res.location, `${CLIENT}/settings?error=purdue-link-throttled`)
      }
    }
    assert.deepEqual(lookups, [])
    assert.deepEqual(linkCalls, [])
    assert.equal(supabase.queries.length, 0)
  })
})

test('the session payload: two head counts on a cache miss and none on a hit, isAdmin and expiresAt', async () => {
  const seed = {
    users: [{ ...STUDENT, purdue_email: 'pete@purdue.edu', purdue_username: 'pete' }],
    linked_sources: [{ id: 's1', user_id: U1 }, { id: 's2', user_id: U2 }],
    calendar_items: [
      { id: 'c1', user_id: U1, category: 'class' },
      { id: 'c2', user_id: U1, category: 'class' },
      { id: 'c3', user_id: U1, category: 'event' },
    ],
  }
  await withApp({ seed, adminEmails: ['pete@example.com'] }, async ({ call, sessionFor, supabase }) => {
    const cookie = await sessionFor({ userId: U1 })
    const first = await call('GET', '/api/session', { cookie })
    assert.equal(first.body.authenticated, true)
    const payload = first.body.session
    assert.deepEqual(payload.user, {
      id: U1,
      email: 'pete@example.com',
      name: 'Pete',
      authProvider: 'email',
      purdueEmail: 'pete@purdue.edu',
      purdueUsername: 'pete',
      hasPurdueLinked: true,
      analyticsOptOut: false,
      isAdmin: true,
    })
    assert.deepEqual(payload.onboarding, {
      linkedSourceCount: 1,
      classCount: 2,
      hasPurdueLinked: true,
      needsPurdueConnection: false,
      needsScheduleSource: false,
    })
    assert.ok(Math.abs(Date.parse(payload.expiresAt) - (Date.now() + 14 * DAY)) < 60 * 1000)
    const [sources, classes] = supabase.queries
    assert.equal(supabase.queries.length, 2)
    assert.equal(sources.table, 'linked_sources')
    assert.ok(hasCall(sources.chain, 'select', '*', { count: 'exact', head: true }))
    assert.ok(hasCall(sources.chain, 'eq', 'user_id', U1))
    assert.equal(classes.table, 'calendar_items')
    assert.ok(hasCall(classes.chain, 'eq', 'user_id', U1))
    assert.ok(hasCall(classes.chain, 'eq', 'category', 'class'))
    // A hit: no query.
    const second = await call('GET', '/api/session', { cookie })
    assert.deepEqual(second.body.session.onboarding, payload.onboarding)
    assert.equal(supabase.queries.length, 2)
  })
  await withApp({ seed: { users: [STUDENT] } }, async ({ call, sessionFor }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('GET', '/api/me/profile', { cookie })
    assert.equal(res.status, 200)
    assert.equal(res.body.user.isAdmin, false)
    assert.equal(res.body.user.hasPurdueLinked, false)
    assert.deepEqual(Object.keys(res.body), ['user'])
  })
})

// ── Register ────────────────────────────────────────────────────────────────

test('register refuses a bad email, a short or long password, a bad name and a taken email, starting no session', async () => {
  await withApp({ seed: { users: [STUDENT] } }, async ({ call, authCalls, supabase, sessions }) => {
    const cases = [
      [{ email: 'nope', password: PASSWORD }, 'Please enter a valid email address.'],
      [{ email: 'new@example.com', password: 'short' }, 'Password must be at least 8 characters.'],
      [{ email: 'new@example.com', password: 'x'.repeat(129) }, 'Password must be at most 128 characters.'],
      [{ email: 'new@example.com', password: PASSWORD, name: 42 }, 'Display name must be text up to 80 characters.'],
    ]
    for (const [body, message] of cases) {
      const res = await call('POST', '/api/auth/register-supabase', { body })
      assert.equal(res.status, 400)
      assert.deepEqual(res.body, { error: { message, status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
    const taken = await call('POST', '/api/auth/register-supabase', { body: { email: ' PETE@example.com ', password: PASSWORD } })
    assert.equal(taken.status, 400)
    assert.deepEqual(taken.body, { error: { message: 'An account with that email already exists.', status: 400 } })
    assert.ok(hasCall(supabase.queries[0].chain, 'eq', 'email', 'pete@example.com'))
    assert.deepEqual(authCalls, [])
    assert.deepEqual(await sessions(), [])
  })
})

test('register maps GoTrue refusals: an existing address to its message, anything else to one generic line', async () => {
  await withApp({ gotrue: { 'new@example.com': { id: U3, password: 'x' } } }, async ({ call }) => {
    const res = await call('POST', '/api/auth/register-supabase', { body: { email: 'new@example.com', password: PASSWORD } })
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: { message: 'An account with that email already exists.', status: 400 } })
  })
  const rejected = { code: 'weak_password', message: 'Password should contain new@example.com' }
  await withApp({ authErrors: { createUser: rejected } }, async ({ call, db }) => {
    const lines = await quietly(async () => {
      const res = await call('POST', '/api/auth/register-supabase', { body: { email: 'new@example.com', password: PASSWORD } })
      assert.equal(res.status, 400)
      assert.deepEqual(res.body, {
        error: { message: 'Could not create your account. Check the email and password and try again.', status: 400 },
      })
    })
    assert.ok(lines.some((l) => l.includes('[register] GoTrue rejected sign-up') && l.includes('weak_password')))
    assert.deepEqual(db.users, [])
  })
})

test('register answers 500 when the profile insert fails, starting no session', async () => {
  await withApp({}, async ({ call, failures, sessions }) => {
    failures.users = (chain) => (operation(chain) === 'insert' ? { code: 'XX000', message: 'connection reset' } : null)
    await quietly(async () => {
      const res = await call('POST', '/api/auth/register-supabase', { body: { email: 'new@example.com', password: PASSWORD } })
      assert.equal(res.status, 500)
      assert.deepEqual(res.body, { error: { message: 'Could not create your profile.', status: 500 } })
      assert.equal(res.cookie, null)
    })
    assert.deepEqual(await sessions(), [])
  })
})

test('register creates the Auth user and the profile row, answers 201 with a fresh session, and rememberMe keeps it 30 days', async () => {
  await withApp({}, async ({ call, db, authCalls, sessions, sidOf }) => {
    const res = await call('POST', '/api/auth/register-supabase', {
      body: { email: ' New@Example.com ', password: PASSWORD, name: '  New   Student ' },
    })
    assert.equal(res.status, 201)
    assert.ok(res.cookie)
    assert.equal(res.body.session.user.id, U3)
    assert.equal(res.body.session.user.email, 'new@example.com')
    assert.equal(res.body.session.user.name, 'New Student')
    // No rememberMe: a browser-session cookie.
    assert.equal(res.body.session.expiresAt, null)
    assert.ok(!/Max-Age|Expires/i.test(res.sessionCookie))
    assert.match(res.sessionCookie, /HttpOnly/)
    assert.match(res.sessionCookie, /SameSite=Lax/)
    assert.deepEqual(authCalls, [['createUser', {
      email: 'new@example.com',
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'New Student' },
    }]])
    const [row] = db.users
    assert.equal(row.id, U3)
    assert.equal(row.password_hash, '')
    assert.equal(row.auth_provider, 'email')
    assert.equal(row.display_name, 'New Student')
    assert.ok(isRecent(row.created_at) && row.created_at === row.updated_at)
    const [stored] = await sessions()
    assert.equal(stored.sid, sidOf(res.cookie))
    assert.equal(stored.userId, U3)
    assert.ok(isRecent(stored.authAt))
  })
  await withApp({}, async ({ call }) => {
    const res = await call('POST', '/api/auth/register-supabase', { body: { email: 'new@example.com', password: PASSWORD, rememberMe: true } })
    assert.equal(res.status, 201)
    assert.equal(maxAgeOf(res.sessionCookie), 30 * DAY / 1000)
    assert.ok(Math.abs(Date.parse(res.body.session.expiresAt) - (Date.now() + 30 * DAY)) < 60 * 1000)
  })
})

// ── Sign-in ─────────────────────────────────────────────────────────────────

test('sign-in answers 401 for a wrong password and 503 when Supabase Auth is down, starting no session', async () => {
  const gotrue = { 'pete@example.com': { id: U1, password: PASSWORD } }
  await withApp({ seed: { users: [STUDENT] }, gotrue }, async ({ call, sessions }) => {
    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: 'wrong password' } })
    assert.equal(res.status, 401)
    assert.deepEqual(res.body, { error: { message: 'Invalid email or password.', status: 401 } })
    assert.deepEqual(await sessions(), [])
  })
  await withApp({ seed: { users: [STUDENT] }, gotrue, verifyError: new UpstreamError('Supabase Auth', 'timeout') }, async ({ call, sessions }) => {
    await quietly(async () => {
      const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
      assert.equal(res.status, 503)
      assert.deepEqual(res.body, {
        error: { message: 'Sign-in is temporarily unavailable. Please try again in a moment.', status: 503 },
      })
    })
    assert.deepEqual(await sessions(), [])
  })
})

test('sign-in regenerates the session: a pre-existing session id is dropped, never reused (no fixation)', async () => {
  const gotrue = { 'pete@example.com': { id: U1, password: PASSWORD, metadata: { full_name: 'Purdue Pete' } } }
  await withApp({ seed: { users: [STUDENT] }, gotrue }, async ({ call, sessionFor, sessions, sidOf, db }) => {
    const planted = await sessionFor({ planted: true })
    const res = await call('POST', '/api/auth/sign-in', { cookie: planted, body: { email: ' PETE@example.com', password: PASSWORD } })
    assert.equal(res.status, 200)
    assert.ok(res.cookie)
    assert.notEqual(sidOf(res.cookie), sidOf(planted))
    const all = await sessions()
    assert.deepEqual(all.map((s) => s.sid), [sidOf(res.cookie)])
    assert.equal(all[0].userId, U1)
    assert.equal(all[0].planted, undefined)
    assert.ok(isRecent(all[0].authAt))
    assert.equal(res.body.session.user.id, U1)
    // ensureUserRowForSupabaseAuth took the Auth metadata name.
    assert.equal(db.users[0].display_name, 'Purdue Pete')
    assert.equal(res.body.session.expiresAt, null)
    const remembered = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD, rememberMe: true } })
    assert.equal(maxAgeOf(remembered.sessionCookie), 30 * DAY / 1000)
  })
})

test('sign-in migrates a legacy scrypt account into Supabase Auth and clears the legacy hash', async () => {
  const legacy = { ...STUDENT, password_hash: hashPassword(PASSWORD) }
  await withApp({ seed: { users: [legacy] }, newAuthId: U1 }, async ({ call, db, authCalls, supabase }) => {
    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    assert.equal(res.status, 200)
    assert.equal(authCalls[0][0], 'createUser')
    assert.equal(authCalls[0][1].email, 'pete@example.com')
    assert.equal(db.users[0].password_hash, '')
    const clear = supabase.queriesOf('users').find((q) => operation(q.chain) === 'update')
    assert.equal(clear.chain.find((c) => c.method === 'update').args[0].password_hash, '')
    assert.ok(hasCall(clear.chain, 'eq', 'id', U1))
  })
})

// ── Supabase session sync ───────────────────────────────────────────────────

const TOKEN_USER = { id: U1, email: 'pete@example.com' }
const SYNC = { supabaseUserId: U1, email: 'pete@example.com', name: 'Pete Google', avatarUrl: 'https://img.example/p.png', provider: 'google' }

test('supabase-sync answers 401 without a token, for a bad token and for a token of another user', async () => {
  await withApp({ tokens: { good: TOKEN_USER } }, async ({ call, supabase, sessions }) => {
    const none = await call('POST', '/api/auth/supabase-sync', { body: SYNC })
    assert.deepEqual(none.body, { error: { message: 'Missing access token.', status: 401 } })
    const bad = await call('POST', '/api/auth/supabase-sync', { body: SYNC, headers: { Authorization: 'Bearer bad' } })
    assert.deepEqual(bad.body, { error: { message: 'Invalid or expired access token.', status: 401 } })
    for (const body of [{ ...SYNC, supabaseUserId: U2 }, { ...SYNC, email: 'other@example.com' }]) {
      const res = await call('POST', '/api/auth/supabase-sync', { body, headers: { Authorization: 'Bearer good' } })
      assert.equal(res.status, 401)
      assert.deepEqual(res.body, { error: { message: 'Token does not match the requested user.', status: 401 } })
    }
    // The token may also come in the body.
    const inBody = await call('POST', '/api/auth/supabase-sync', { body: { ...SYNC, supabaseUserId: U2, accessToken: 'good' } })
    assert.deepEqual(inBody.body, { error: { message: 'Token does not match the requested user.', status: 401 } })
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(await sessions(), [])
  })
})

test('supabase-sync answers 400 for missing fields, a non-string name and a non-https avatar', async () => {
  await withApp({ tokens: { good: TOKEN_USER } }, async ({ call, supabase }) => {
    const auth = { Authorization: 'Bearer good' }
    const missing = await call('POST', '/api/auth/supabase-sync', { body: { email: 'pete@example.com' }, headers: auth })
    assert.deepEqual(missing.body, { error: { message: 'Missing required fields', status: 400 } })
    const name = await call('POST', '/api/auth/supabase-sync', { body: { ...SYNC, name: ['x'] }, headers: auth })
    assert.deepEqual(name.body, { error: { message: 'Display name must be text up to 80 characters.', status: 400 } })
    const avatar = await call('POST', '/api/auth/supabase-sync', { body: { ...SYNC, avatarUrl: 'http://img.example/p.png' }, headers: auth })
    assert.deepEqual(avatar.body, { error: { message: 'Avatar URL must be an https link up to 2048 characters.', status: 400 } })
    assert.equal(supabase.queries.length, 0)
  })
})

test('supabase-sync inserts a new profile and signs it in', async () => {
  await withApp({ tokens: { good: TOKEN_USER } }, async ({ call, db, sessions, sidOf }) => {
    const res = await call('POST', '/api/auth/supabase-sync', { body: SYNC, headers: { Authorization: 'Bearer good' } })
    assert.equal(res.status, 200)
    assert.equal(res.body.reused, undefined)
    assert.equal(res.body.session.user.id, U1)
    const [row] = db.users
    assert.deepEqual(
      { id: row.id, email: row.email, display_name: row.display_name, auth_provider: row.auth_provider, avatar_url: row.avatar_url, password_hash: row.password_hash },
      { id: U1, email: 'pete@example.com', display_name: 'Pete Google', auth_provider: 'google', avatar_url: 'https://img.example/p.png', password_hash: '' },
    )
    const [stored] = await sessions()
    assert.equal(stored.sid, sidOf(res.cookie))
    assert.equal(stored.userId, U1)
    assert.ok(isRecent(stored.authAt))
  })
})

test('supabase-sync updates an existing profile with only the fields sent', async () => {
  const seed = { users: [{ ...STUDENT, avatar_url: 'https://img.example/old.png' }] }
  await withApp({ seed, tokens: { good: TOKEN_USER } }, async ({ call, db, supabase }) => {
    const res = await call('POST', '/api/auth/supabase-sync', {
      body: { supabaseUserId: U1, email: 'pete@example.com', provider: 'google' },
      headers: { Authorization: 'Bearer good' },
    })
    assert.equal(res.status, 200)
    const update = supabase.queriesOf('users').find((q) => operation(q.chain) === 'update')
    const patch = update.chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(patch).sort(), ['auth_provider', 'updated_at'])
    assert.ok(hasCall(update.chain, 'eq', 'id', U1))
    assert.equal(db.users[0].display_name, 'Pete')
    assert.equal(db.users[0].avatar_url, 'https://img.example/old.png')
    assert.equal(db.users[0].auth_provider, 'google')
  })
})

test('supabase-sync reuses the session the same user already holds, and regenerates it for another user', async () => {
  const seed = { users: [STUDENT, OTHER] }
  await withApp({ seed, tokens: { good: TOKEN_USER, other: { id: U2, email: 'other@example.com' } } }, async ({ call, sessionFor, sessions, sidOf }) => {
    const cookie = await sessionFor({ userId: U1, authAt: '2026-01-01T00:00:00.000Z' })
    const reused = await call('POST', '/api/auth/supabase-sync', { cookie, body: SYNC, headers: { Authorization: 'Bearer good' } })
    assert.equal(reused.status, 200)
    assert.equal(reused.body.reused, true)
    assert.equal(reused.body.session.user.id, U1)
    // Same session id, and the session was not re-established.
    assert.equal(sidOf(reused.cookie), sidOf(cookie))
    let all = await sessions()
    assert.equal(all.length, 1)
    assert.equal(all[0].authAt, '2026-01-01T00:00:00.000Z')

    const other = await call('POST', '/api/auth/supabase-sync', {
      cookie,
      body: { supabaseUserId: U2, email: 'other@example.com' },
      headers: { Authorization: 'Bearer other' },
    })
    assert.equal(other.status, 200)
    assert.equal(other.body.reused, undefined)
    assert.notEqual(sidOf(other.cookie), sidOf(cookie))
    all = await sessions()
    assert.deepEqual(all.map((s) => [s.sid, s.userId]), [[sidOf(other.cookie), U2]])
  })
})

// ── Two-step sign-in ────────────────────────────────────────────────────────

const PETE_AUTH = { 'pete@example.com': { id: U1, password: PASSWORD } }
const trustedCookieOf = (res) => res.setCookies.map((c) => c.split(';')[0]).find((p) => p.startsWith('pih.td=')) ?? null
function fakeJwt(methods) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode({ amr: methods.map((method) => ({ method, timestamp: 1 })) })}.sig`
}

// The pending sign-in's row, as the router left it, and a code that is not the one mailed.
const challengeRow = (db) => db.sign_in_challenges[0]
const wrongFor = (code) => (code === '000000' ? '111111' : '000000')
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString()

test('two-step: a correct password mails a code and holds a short session with no user until it is entered', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true }, async ({ call, db, sessions, mail, codes, limiterHits, mailWindowHits }) => {
    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD, rememberMe: true } })
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.body).sort(), ['email', 'expiresAt', 'twoFactorRequired'])
    assert.equal(res.body.twoFactorRequired, true)
    assert.equal(res.body.email, 'p***@example.com')
    assert.equal(mail.length, 1)
    assert.equal(mail[0].to, 'pete@example.com')
    assert.equal(mail[0].subject, 'Your BoilerIndy sign-in code')
    assert.deepEqual(mailWindowHits, [U1])
    assert.equal(minutesLeftOf(res.sessionCookie), 15, 'the pending session gets a short cookie')

    const [stored] = await sessions()
    assert.equal(stored.userId, undefined)
    assert.deepEqual(Object.keys(stored.pendingLogin).sort(), ['challengeId', 'rememberMe', 'subject'])
    assert.equal(stored.pendingLogin.subject, U1)
    assert.equal(db.sign_in_challenges.length, 1)
    assert.equal(challengeRow(db).id, stored.pendingLogin.challengeId)
    assert.equal(challengeRow(db).user_id, U1)
    assert.ok(!JSON.stringify([stored, db.sign_in_challenges]).includes(codes[0]), 'only a hash of the code is stored')

    // Signed out until the code is entered.
    assert.equal((await call('GET', '/api/me/profile', { cookie: res.cookie })).status, 401)

    const wrong = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: wrongFor(codes[0]) } })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.error.code, 'invalid')
    assert.equal(wrong.body.error.restart, false)
    assert.equal(wrong.body.error.message, 'That code is not right. 4 tries left.')
    assert.equal(challengeRow(db).attempts, 1)

    const right = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })
    assert.equal(right.status, 200)
    assert.equal(right.body.session.user.id, U1)
    assert.notEqual(right.cookie, res.cookie, 'the session id is regenerated on success')
    assert.equal(maxAgeOf(right.sessionCookie), 30 * DAY / 1000, 'rememberMe survives the code step')
    assert.equal(trustedCookieOf(right), null, 'no trusted device unless asked')
    assert.deepEqual((await sessions()).map((s) => [s.userId, s.pendingLogin]), [[U1, undefined]])
    assert.deepEqual(db.sign_in_challenges, [], 'the right code spent the row')

    // The code was spent with the pending sign-in.
    const replay = await call('POST', '/api/auth/sign-in/verify', { cookie: right.cookie, body: { code: codes[0] } })
    assert.equal(replay.body.error.code, 'missing')
    const ipHit = limiterHits.indexOf('login-code POST /api/auth/sign-in/verify')
    const accountHit = limiterHits.indexOf('login-code-account POST /api/auth/sign-in/verify')
    assert.ok(ipHit >= 0 && accountHit > ipHit, 'the IP bucket runs first, as the outer cap, then the account bucket')
  })
})

test('two-step: the fifth wrong code ends the pending sign-in and removes its row', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true }, async ({ call, codes, db }) => {
    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    const answers = []
    for (let i = 0; i < 5; i += 1) {
      answers.push((await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: wrongFor(codes[0]) } })).body.error)
    }
    assert.deepEqual(answers.map((e) => [e.code, e.restart]), [
      ['invalid', false],
      ['invalid', false],
      ['invalid', false],
      ['invalid', false],
      ['too-many-attempts', true],
    ])
    assert.deepEqual(db.sign_in_challenges, [])
    const late = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })
    assert.equal(late.status, 400)
    assert.equal(late.body.error.code, 'missing')
  })
})

test('two-step: forty wrong codes at once share the five guesses, and the right code then fails', async () => {
  // A slow session store, so every request loads the pending session before
  // any of them saves (the copy each one holds says no guess was used yet), and
  // a slow database, so their reads and counts interleave.
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true, storeDelayMs: 30, dbDelayMs: 10 }, async ({ call, codes, db }) => {
    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    const burst = await Promise.all(
      Array.from({ length: 40 }, () => call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: wrongFor(codes[0]) } })),
    )
    // Four guesses were told "not right" with 4, 3, 2 and 1 tries left, the
    // fifth ended the sign-in, and the other 35 found no guess left to count.
    const notRight = burst.filter((answer) => answer.body.error.code === 'invalid').map((answer) => answer.body.error.message)
    assert.deepEqual(notRight.sort(), [1, 2, 3, 4].map((n) => `That code is not right. ${n} ${n === 1 ? 'try' : 'tries'} left.`))
    assert.ok(burst.every((answer) => answer.body.error.code === 'invalid' || answer.body.error.restart === true))
    assert.deepEqual(db.sign_in_challenges, [])

    const right = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })
    assert.equal(right.status, 400)
    assert.equal(right.body.error.restart, true)
  })
})

test('two-step: the right code sent three times at once signs in one session', async () => {
  // Spending is slow here, so all three count a guess and match the code
  // before the first spend lands: only the spend can tell them apart.
  const dbDelayMs = (table, chain) => (table === 'sign_in_challenges' && operation(chain) === 'delete' ? 60 : 10)
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true, storeDelayMs: 30, dbDelayMs }, async ({ call, codes, sessions }) => {
    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    const burst = await Promise.all(
      Array.from({ length: 3 }, () => call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })),
    )
    assert.deepEqual(burst.map((answer) => answer.status).sort(), [200, 400, 400])
    assert.ok(burst.filter((answer) => answer.status === 400).every((answer) => answer.body.error.restart === true))
    assert.equal((await sessions()).filter((s) => s.userId === U1).length, 1)
  })
})

test('two-step: a code with no pending sign-in is refused without writing a session', async () => {
  await withApp({ twoFactor: true }, async ({ call, sessions, supabase }) => {
    const res = await call('POST', '/api/auth/sign-in/verify', { body: { code: '123456' } })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'missing')
    assert.equal(res.body.error.restart, true)
    assert.equal(res.sessionCookie, null)
    assert.deepEqual(await sessions(), [])
    assert.equal(supabase.queriesOf('sign_in_challenges').length, 0)
  })
})

test('two-step: a pending sign-in ends 30 minutes after the password, and a resend cannot revive it', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true }, async ({ call, codes, db, mail }) => {
    const first = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    Object.assign(challengeRow(db), { created_at: minutesAgo(31), sent_at: minutesAgo(31) })
    const resend = await call('POST', '/api/auth/sign-in/resend', { cookie: first.cookie })
    assert.equal(resend.body.error.code, 'timed-out')
    assert.equal(resend.body.error.restart, true)
    assert.equal(mail.length, 1, 'no new code went out')
    assert.deepEqual(db.sign_in_challenges, [])
    assert.equal((await call('POST', '/api/auth/sign-in/verify', { cookie: first.cookie, body: { code: codes[0] } })).body.error.code, 'missing')

    const second = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    // A resend renews the code, never the sign-in around it.
    Object.assign(challengeRow(db), { created_at: minutesAgo(31), expires_at: new Date(Date.now() + 60 * 1000).toISOString() })
    const verify = await call('POST', '/api/auth/sign-in/verify', { cookie: second.cookie, body: { code: codes[1] } })
    assert.equal(verify.body.error.code, 'timed-out')
    assert.equal(verify.body.error.restart, true)
    assert.deepEqual(db.sign_in_challenges, [])
  })
})

test('two-step: an expired code keeps the sign-in, and a resend after the cooldown replaces it', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true }, async ({ call, codes, db, mail, limiterHits, mailWindowHits }) => {
    const none = await call('POST', '/api/auth/sign-in/resend')
    assert.equal(none.body.error.code, 'missing')
    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    const early = await call('POST', '/api/auth/sign-in/resend', { cookie: res.cookie })
    assert.equal(early.body.error.code, 'cooldown')
    assert.equal(early.body.error.restart, false)
    assert.equal(mail.length, 1)
    assert.ok(limiterHits.includes('login-code-send POST /api/auth/sign-in/resend'))

    Object.assign(challengeRow(db), { sent_at: minutesAgo(11), expires_at: minutesAgo(1), attempts: 2 })
    const expired = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })
    assert.equal(expired.body.error.code, 'expired')
    assert.equal(expired.body.error.restart, false)
    assert.equal(challengeRow(db).attempts, 2, 'an expired code costs no guess')

    const resent = await call('POST', '/api/auth/sign-in/resend', { cookie: res.cookie })
    assert.equal(resent.status, 200)
    assert.ok(Date.parse(resent.body.expiresAt) > Date.now() + 9 * 60 * 1000, 'the new code gets its own 10 minutes')
    assert.equal(mail.length, 2)
    assert.equal(mail[1].to, 'pete@example.com')
    assert.deepEqual(mailWindowHits, [U1, U1])
    assert.deepEqual([challengeRow(db).sends, challengeRow(db).attempts], [2, 0])

    if (codes[0] !== codes[1]) {
      const old = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })
      assert.equal(old.body.error.code, 'invalid', 'the resend voided the first code')
    }
    const fresh = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[1] } })
    assert.equal(fresh.status, 200)
    assert.equal(fresh.body.session.user.id, U1)
  })
})

test('two-step: a password change between the two steps voids the code', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true }, async ({ call, codes, db, sessions }) => {
    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    db.users[0].password_changed_at = new Date(Date.now() + 1000).toISOString()
    const verify = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })
    assert.equal(verify.status, 400)
    assert.equal(verify.body.error.code, 'password-changed')
    assert.equal(verify.body.error.restart, true)
    assert.ok((await sessions()).every((s) => !s.userId))
  })
})

test('two-step: the account\'s mail cap counts only after the password, and over it no code goes out', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true, block: ['login-code-mail'] }, async ({ call, mail, db, sessions, mailWindowHits }) => {
    const wrongPassword = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: 'not the password' } })
    assert.equal(wrongPassword.status, 401)
    assert.deepEqual(mailWindowHits, [], 'a wrong password costs the account nothing')

    const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    assert.equal(res.status, 429)
    assert.ok(res.body.error.retryAfterSeconds > 0)
    assert.deepEqual(mailWindowHits, [U1])
    assert.equal(mail.length, 0)
    assert.deepEqual(db.sign_in_challenges, [])
    assert.deepEqual(await sessions(), [])
  })
})

test('two-step: "trust this device" lets the next sign-in skip the code, until the password changes', async () => {
  const seed = { users: [STUDENT] }
  await withApp({ seed, gotrue: PETE_AUTH, twoFactor: true }, async ({ call, codes, mail, db }) => {
    const first = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
    const verified = await call('POST', '/api/auth/sign-in/verify', { cookie: first.cookie, body: { code: codes[0], trustDevice: true } })
    const trusted = trustedCookieOf(verified)
    assert.ok(trusted)
    const setCookie = verified.setCookies.find((c) => c.startsWith('pih.td='))
    assert.match(setCookie, /HttpOnly/)
    assert.equal(maxAgeOf(setCookie), 30 * DAY / 1000)

    const again = await call('POST', '/api/auth/sign-in', { cookie: trusted, body: { email: 'pete@example.com', password: PASSWORD } })
    assert.equal(again.body.session.user.id, U1)
    assert.equal(mail.length, 1, 'no second code was mailed')

    db.users[0].password_changed_at = new Date().toISOString()
    const afterChange = await call('POST', '/api/auth/sign-in', { cookie: trusted, body: { email: 'pete@example.com', password: PASSWORD } })
    assert.equal(afterChange.body.twoFactorRequired, true)
  })
})

test('two-step: sign-up confirms the address with a code before any session', async () => {
  await withApp({ twoFactor: true }, async ({ call, sessions, mail, codes }) => {
    const res = await call('POST', '/api/auth/register-supabase', { body: { email: 'new@example.com', password: PASSWORD, name: 'New' } })
    assert.equal(res.status, 201)
    assert.equal(res.body.twoFactorRequired, true)
    assert.equal(mail[0].to, 'new@example.com')
    assert.equal((await sessions())[0].userId, undefined)
    const verified = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })
    assert.equal(verified.body.session.user.id, U3)
  })
})

test('two-step: production without Resend refuses a sign-up before the account exists and a sign-in before any row; dev logs the code', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true, production: true, emailConfigured: false }, async ({ call, sessions, authCalls, db, gotrue, mail }) => {
    await quietly(async () => {
      const signUp = await call('POST', '/api/auth/register-supabase', { body: { email: 'new@example.com', password: PASSWORD, name: 'New' } })
      assert.equal(signUp.status, 503)
      assert.ok(!authCalls.some(([name]) => name === 'createUser'), 'no Auth user was created')
      assert.equal(gotrue['new@example.com'], undefined)
      assert.deepEqual(db.users.map((u) => u.email), ['pete@example.com'])

      const signIn = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
      assert.equal(signIn.status, 503)
      assert.equal(mail.length, 0)
      assert.deepEqual(db.sign_in_challenges, [])
      assert.deepEqual(await sessions(), [])
    })
  })
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true, emailConfigured: false }, async ({ call, codes }) => {
    const lines = await quietly(async () => {
      const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
      assert.equal(res.body.twoFactorRequired, true)
    })
    assert.ok(lines.some((line) => line.includes(`dev code for p***@example.com: ${codes[0]}`)))
  })
})

test('two-step: a sign-up whose code email failed still lands on the code step, and a resend finishes it', async () => {
  await withApp({ twoFactor: true, production: true, failedSends: 1 }, async ({ call, db, codes }) => {
    await quietly(async () => {
      const res = await call('POST', '/api/auth/register-supabase', { body: { email: 'new@example.com', password: PASSWORD, name: 'New' } })
      assert.equal(res.status, 201)
      assert.equal(res.body.twoFactorRequired, true)
      assert.equal(res.body.codeSent, false)
      assert.equal(challengeRow(db).user_id, U3)

      challengeRow(db).sent_at = minutesAgo(1)
      const resent = await call('POST', '/api/auth/sign-in/resend', { cookie: res.cookie })
      assert.equal(resent.status, 200)
      const verified = await call('POST', '/api/auth/sign-in/verify', { cookie: res.cookie, body: { code: codes[0] } })
      assert.equal(verified.body.session.user.id, U3)
    })
  })
})

test('two-step: an unsent sign-in code answers 503 and leaves nothing pending', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true, production: true, failedSends: 1 }, async ({ call, db, sessions }) => {
    await quietly(async () => {
      const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
      assert.equal(res.status, 503)
    })
    assert.deepEqual(db.sign_in_challenges, [])
    assert.deepEqual(await sessions(), [])
  })
})

test('two-step: sign_in_codes_schema_missing until README step 41 has run', async () => {
  await withApp({ seed: { users: [STUDENT] }, gotrue: PETE_AUTH, twoFactor: true }, async ({ call, failures, sessions, mail }) => {
    failures.sign_in_challenges = () => ({ code: 'PGRST205', message: "Could not find the table 'public.sign_in_challenges' in the schema cache" })
    await quietly(async () => {
      const res = await call('POST', '/api/auth/sign-in', { body: { email: 'pete@example.com', password: PASSWORD } })
      assert.equal(res.status, 503)
      assert.equal(res.body.error.code, 'sign_in_codes_schema_missing')
    })
    assert.equal(mail.length, 0)
    assert.deepEqual(await sessions(), [])
  })
})

test('sync gate: off, a password token still signs in; on, it is refused unless resuming or trusted', async () => {
  const password = fakeJwt(['password'])
  const google = fakeJwt(['oauth'])
  const tokens = { [password]: TOKEN_USER, [google]: TOKEN_USER }
  const body = { supabaseUserId: U1, email: 'pete@example.com' }
  await withApp({ seed: { users: [STUDENT] }, tokens, twoFactor: true }, async ({ call }) => {
    const res = await call('POST', '/api/auth/supabase-sync', { body, headers: { Authorization: `Bearer ${password}` } })
    assert.equal(res.status, 200)
  })
  await withApp({ seed: { users: [STUDENT] }, tokens, twoFactor: true, syncGate: true }, async ({ call, sessionFor, supabase }) => {
    const refused = await call('POST', '/api/auth/supabase-sync', { body: { ...body, name: 'Renamed' }, headers: { Authorization: `Bearer ${password}` } })
    assert.equal(refused.status, 401)
    assert.equal(refused.body.error.code, 'two-factor-required')
    assert.ok(!supabase.queriesOf('users').some((q) => operation(q.chain) === 'update'), 'a refused sync changes nothing')

    const viaGoogle = await call('POST', '/api/auth/supabase-sync', { body, headers: { Authorization: `Bearer ${google}` } })
    assert.equal(viaGoogle.status, 200)

    const cookie = await sessionFor({ userId: U1, authAt: new Date().toISOString() })
    const resumed = await call('POST', '/api/auth/supabase-sync', { cookie, body, headers: { Authorization: `Bearer ${password}` } })
    assert.equal(resumed.body.reused, true)
  })
})

// ── Sign-out and account deletion ───────────────────────────────────────────

test('sign-out destroys the session and clears the cookie', async () => {
  await withApp({ seed: { users: [STUDENT] } }, async ({ call, sessionFor, sessions }) => {
    const cookie = await sessionFor({ userId: U1 })
    assert.equal((await call('GET', '/api/session', { cookie })).body.authenticated, true)
    const res = await call('POST', '/api/sign-out', { cookie })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
    assert.ok(res.cleared)
    assert.deepEqual(await sessions(), [])
    assert.deepEqual((await call('GET', '/api/session', { cookie })).body, { authenticated: false, session: null })
  })
})

test('delete-account needs DELETE typed and the password, then removes the Auth user and the profile and signs out', async () => {
  const gotrue = { 'pete@example.com': { id: U1, password: PASSWORD } }
  await withApp({ seed: { users: [STUDENT, OTHER] }, gotrue }, async ({ call, sessionFor, sessions, authCalls, db, supabase, invalidated }) => {
    const cookie = await sessionFor({ userId: U1 })
    const unconfirmed = await call('POST', '/api/me/delete-account', { cookie, body: { password: PASSWORD, confirmation: 'delete' } })
    assert.equal(unconfirmed.status, 400)
    assert.deepEqual(unconfirmed.body, {
      error: { message: 'Type DELETE in the confirmation box to permanently delete your account.', status: 400 },
    })
    const noPassword = await call('POST', '/api/me/delete-account', { cookie, body: { confirmation: 'DELETE' } })
    assert.deepEqual(noPassword.body, { error: { message: 'Please enter your password to confirm deletion.', status: 400 } })
    const wrong = await call('POST', '/api/me/delete-account', { cookie, body: { password: 'wrong password', confirmation: 'DELETE' } })
    assert.deepEqual(wrong.body, { error: { message: 'Password is incorrect.', status: 400 } })
    assert.deepEqual(authCalls, [])
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(invalidated, [])

    const res = await call('POST', '/api/me/delete-account', { cookie, body: { password: PASSWORD, confirmation: 'DELETE' } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
    assert.ok(res.cleared)
    assert.deepEqual(authCalls, [['deleteUser', U1]])
    const [del] = supabase.queriesOf('users')
    assert.equal(operation(del.chain), 'delete')
    assert.ok(hasCall(del.chain, 'eq', 'id', U1))
    assert.deepEqual(db.users.map((u) => u.id), [U2])
    assert.deepEqual(invalidated, [U1])
    assert.deepEqual(await sessions(), [])
    assert.deepEqual((await call('GET', '/api/session', { cookie })).body, { authenticated: false, session: null })
  })
})

test('delete-account accepts a legacy password, tolerates an Auth user already gone, and stops on an Auth failure', async () => {
  const legacy = { ...STUDENT, password_hash: hashPassword(PASSWORD) }
  await withApp({ seed: { users: [legacy] }, authErrors: { deleteUser: { code: 'user_not_found', message: 'gone' } } }, async ({ call, sessionFor, db }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('POST', '/api/me/delete-account', { cookie, body: { password: PASSWORD, confirmation: 'DELETE' } })
    assert.equal(res.status, 200)
    assert.deepEqual(db.users, [])
  })
  const gotrue = { 'pete@example.com': { id: U1, password: PASSWORD } }
  await withApp({ seed: { users: [STUDENT] }, gotrue, authErrors: { deleteUser: { code: 'unexpected_failure', message: 'boom' } } }, async ({ call, sessionFor, db, sessions, invalidated }) => {
    const cookie = await sessionFor({ userId: U1 })
    await quietly(async () => {
      const res = await call('POST', '/api/me/delete-account', { cookie, body: { password: PASSWORD, confirmation: 'DELETE' } })
      assert.equal(res.status, 400)
      assert.deepEqual(res.body, {
        error: { message: 'Could not delete your authentication account. Try again or contact support.', status: 400 },
      })
    })
    assert.equal(db.users.length, 1)
    assert.deepEqual(invalidated, [])
    assert.equal((await sessions()).length, 1)
  })
})

// ── The profile ─────────────────────────────────────────────────────────────

test('PATCH profile refuses a bad name and an email or password change without the current password', async () => {
  const gotrue = { 'pete@example.com': { id: U1, password: PASSWORD } }
  await withApp({ seed: { users: [STUDENT] }, gotrue }, async ({ call, sessionFor, authCalls, db }) => {
    const cookie = await sessionFor({ userId: U1 })
    const name = await call('PATCH', '/api/me/profile', { cookie, body: { name: { first: 'Pete' } } })
    assert.equal(name.status, 400)
    assert.deepEqual(name.body, { error: { message: 'Display name must be text up to 80 characters.', status: 400 } })
    for (const body of [{ email: 'new@example.com' }, { newPassword: NEW_PASSWORD }]) {
      const res = await call('PATCH', '/api/me/profile', { cookie, body })
      assert.equal(res.status, 400)
      assert.deepEqual(res.body, {
        error: { message: 'Please enter your current password to change your email or password.', status: 400 },
      })
    }
    const wrong = await call('PATCH', '/api/me/profile', { cookie, body: { newPassword: NEW_PASSWORD, currentPassword: 'nope nope' } })
    assert.deepEqual(wrong.body, { error: { message: 'Current password is incorrect.', status: 400 } })
    assert.deepEqual(authCalls, [])
    assert.equal(db.users[0].email, 'pete@example.com')
  })
})

test('PATCH profile with a new password sets it in Auth, stamps the change and moves this session\'s authAt only then', async () => {
  const gotrue = { 'pete@example.com': { id: U1, password: PASSWORD } }
  const OLD_AUTH_AT = '2026-01-01T00:00:00.000Z'
  await withApp({ seed: { users: [STUDENT] }, gotrue }, async ({ call, sessionFor, sessions, authCalls, db, supabase }) => {
    const cookie = await sessionFor({ userId: U1, authAt: OLD_AUTH_AT })
    const rename = await call('PATCH', '/api/me/profile', { cookie, body: { name: 'Purdue Pete', analyticsOptOut: true } })
    assert.equal(rename.status, 200)
    assert.equal(rename.body.user.name, 'Purdue Pete')
    assert.equal(rename.body.user.analyticsOptOut, true)
    assert.equal((await sessions())[0].authAt, OLD_AUTH_AT)
    assert.equal(db.users[0].password_changed_at, null)

    const res = await call('PATCH', '/api/me/profile', { cookie, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })
    assert.equal(res.status, 200)
    assert.deepEqual(authCalls, [['updateUserById', U1, { password: NEW_PASSWORD }]])
    const updates = supabase.queriesOf('users').filter((q) => operation(q.chain) === 'update')
    const stamp = updates.at(-1).chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(stamp), ['password_changed_at'])
    assert.ok(isRecent(db.users[0].password_changed_at))
    assert.equal(db.users[0].password_hash, '')
    const [stored] = await sessions()
    assert.ok(isRecent(stored.authAt))
    assert.ok(Date.parse(stored.authAt) >= Date.parse(db.users[0].password_changed_at))
    // This session survives its own change; one established before it does not.
    assert.equal((await call('GET', '/api/me/profile', { cookie })).status, 200)
    const older = await sessionFor({ userId: U1, authAt: OLD_AUTH_AT })
    assert.equal((await call('GET', '/api/me/profile', { cookie: older })).status, 401)
  })
})

test('PATCH profile changes the login email in Auth too, after checking the current password', async () => {
  const gotrue = { 'pete@example.com': { id: U1, password: PASSWORD } }
  await withApp({ seed: { users: [STUDENT, OTHER] }, gotrue }, async ({ call, sessionFor, authCalls, db }) => {
    const cookie = await sessionFor({ userId: U1 })
    const taken = await call('PATCH', '/api/me/profile', { cookie, body: { email: 'other@example.com', currentPassword: PASSWORD } })
    assert.deepEqual(taken.body, { error: { message: 'That email address is already in use.', status: 400 } })
    const res = await call('PATCH', '/api/me/profile', { cookie, body: { email: 'Pete2@Example.com', currentPassword: PASSWORD } })
    assert.equal(res.status, 200)
    assert.equal(res.body.user.email, 'pete2@example.com')
    assert.deepEqual(authCalls, [['updateUserById', U1, { email: 'pete2@example.com', email_confirm: true }]])
    assert.equal(db.users[0].email, 'pete2@example.com')
  })
})

// ── The Purdue link: connect ────────────────────────────────────────────────

test('connect with linking off sends the website to settings and the app to its return URL', async () => {
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'off' }, async ({ call, sessionFor, purdueLinkHandoff }) => {
    const cookie = await sessionFor({ userId: U1 })
    const web = await call('GET', '/auth/purdue/connect', { cookie })
    assert.equal(web.status, 302)
    assert.equal(web.location, `${CLIENT}/settings`)
    const { token } = purdueLinkHandoff.issue(U1)
    const app = await call('GET', `/auth/purdue/connect?t=${encodeURIComponent(token)}`)
    const url = new URL(app.location)
    assert.equal(`${url.protocol}//${url.host}`, 'boilerindyapp://purdue-linked')
    assert.equal(url.searchParams.get('status'), 'error')
    assert.equal(url.searchParams.get('reason'), 'disabled')
  })
})

test('connect in mock mode renders the escaped link form, carrying next and the handoff token', async () => {
  const seed = { users: [{ ...STUDENT, purdue_email: '"><script>x</script>@purdue.edu' }] }
  await withApp({ seed }, async ({ call, sessionFor, purdueLinkHandoff }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('GET', '/auth/purdue/connect?next=/calendar?a=1%26b=%22', { cookie })
    assert.equal(res.status, 200)
    assert.match(res.type, /text\/html/)
    assert.ok(res.text.includes('<form class="card" method="post" action="/auth/purdue/dev/link">'))
    assert.ok(res.text.includes('<input type="hidden" name="next" value="/calendar?a=1&amp;b=&quot;" />'))
    assert.ok(res.text.includes('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;@purdue.edu"'))
    assert.ok(!res.text.includes('<script>'))
    assert.ok(!res.text.includes('name="t"'))
    const { token } = purdueLinkHandoff.issue(U1)
    const app = await call('GET', `/auth/purdue/connect?t=${encodeURIComponent(token)}`)
    assert.ok(app.text.includes(`<input type="hidden" name="t" value="${token}" />`))
    assert.ok(app.text.includes('<input type="hidden" name="next" value="/setup" />'))
    assert.equal(app.sessionCookie, null)
  })
})

test('connect in CAS mode without the CAS URLs reports cas-config', async () => {
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas' }, async ({ call, sessionFor, purdueLinkHandoff }) => {
    const cookie = await sessionFor({ userId: U1 })
    assert.equal((await call('GET', '/auth/purdue/connect', { cookie })).location, `${CLIENT}/settings?error=cas-config`)
    const { token } = purdueLinkHandoff.issue(U1)
    const app = new URL((await call('GET', `/auth/purdue/connect?t=${encodeURIComponent(token)}`)).location)
    assert.equal(app.searchParams.get('reason'), 'cas-config')
  })
})

test('connect in CAS mode stores a fresh state and sends the browser to CAS with it in the service URL; the app flow uses its token', async () => {
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas', cas: { user: 'pete' } }, async ({ call, sessionFor, sessions, purdueLinkHandoff }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('GET', '/auth/purdue/connect?next=/calendar', { cookie })
    assert.equal(res.status, 302)
    const login = new URL(res.location)
    assert.equal(`${login.origin}${login.pathname}`, CAS_LOGIN)
    const service = new URL(login.searchParams.get('service'))
    assert.equal(`${service.origin}${service.pathname}`, `${BACKEND}/auth/purdue/callback`)
    assert.equal(service.searchParams.get('next'), '/calendar')
    const state = service.searchParams.get('state')
    assert.match(state, /^[0-9a-f]{32}$/)
    assert.equal((await sessions())[0].casState, state)
    // A second attempt replaces the state.
    const again = new URL(new URL((await call('GET', '/auth/purdue/connect', { cookie })).location).searchParams.get('service'))
    assert.notEqual(again.searchParams.get('state'), state)
    assert.equal(again.searchParams.get('next'), '/setup')

    const { token } = purdueLinkHandoff.issue(U1)
    const app = await call('GET', `/auth/purdue/connect?t=${encodeURIComponent(token)}`)
    const appService = new URL(new URL(app.location).searchParams.get('service'))
    assert.equal(appService.searchParams.get('t'), token)
    assert.equal(appService.searchParams.get('state'), null)
    assert.equal(app.sessionCookie, null)
  })
})

// ── The Purdue link: the mock form post ─────────────────────────────────────

test('dev/link links and redirects to the sanitized next path, and never off-site', async () => {
  await withApp({ seed: { users: [STUDENT] } }, async ({ call, sessionFor, linkCalls }) => {
    const cookie = await sessionFor({ userId: U1 })
    const ok = await call('POST', '/auth/purdue/dev/link', { cookie, form: { email: 'pete@purdue.edu', next: '/calendar' } })
    assert.equal(ok.status, 302)
    assert.equal(ok.location, `${CLIENT}/calendar`)
    assert.deepEqual(linkCalls, [[U1, 'pete@purdue.edu']])
    for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example', '']) {
      const res = await call('POST', '/auth/purdue/dev/link', { cookie, form: { email: 'pete@purdue.edu', next } })
      assert.equal(res.location, `${CLIENT}/setup`, next)
    }
  })
})

test('dev/link shows a refused link on the form, escaped', async () => {
  await withApp({ seed: { users: [STUDENT] }, linkError: new Error('Nope <b>bold</b>') }, async ({ call, sessionFor }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('POST', '/auth/purdue/dev/link', { cookie, form: { email: 'x"@purdue.edu', next: '/calendar' } })
    assert.equal(res.status, 200)
    assert.ok(res.text.includes('<div class="msg">Nope &lt;b&gt;bold&lt;/b&gt;</div>'))
    assert.ok(res.text.includes('value="x&quot;@purdue.edu"'))
    assert.ok(res.text.includes('name="next" value="/calendar"'))
  })
})

test('dev/link answers 404 when linking is off or CAS is active', async () => {
  for (const [mode, text] of [['off', 'Purdue linking is currently disabled.'], ['cas', 'Mock Purdue linking is disabled while CAS mode is active.']]) {
    await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: mode }, async ({ call, sessionFor, linkCalls }) => {
      const cookie = await sessionFor({ userId: U1 })
      const res = await call('POST', '/auth/purdue/dev/link', { cookie, form: { email: 'pete@purdue.edu' } })
      assert.equal(res.status, 404)
      assert.equal(res.text, text)
      assert.deepEqual(linkCalls, [])
    })
  }
})

test('dev/link with a handoff token links without a session and spends the token; a replay is refused as used', async () => {
  await withApp({ seed: { users: [STUDENT] } }, async ({ call, purdueLinkHandoff, linkCalls, sessions }) => {
    const { token } = purdueLinkHandoff.issue(U1)
    const res = await call('POST', '/auth/purdue/dev/link', { form: { email: 'pete@purdue.edu', t: token } })
    assert.equal(res.location, 'boilerindyapp://purdue-linked?status=ok')
    assert.equal(res.sessionCookie, null)
    const replay = new URL((await call('POST', '/auth/purdue/dev/link', { form: { email: 'pete@purdue.edu', t: token } })).location)
    assert.equal(replay.searchParams.get('reason'), 'used')
    assert.deepEqual(linkCalls, [[U1, 'pete@purdue.edu']])
    assert.deepEqual(await sessions(), [])
    // A forged token is refused before any lookup.
    const forged = new URL((await call('POST', '/auth/purdue/dev/link', { form: { email: 'pete@purdue.edu', t: 'abc.def' } })).location)
    assert.equal(forged.searchParams.get('reason'), 'invalid')
  })
})

// ── The Purdue link: the CAS callback ───────────────────────────────────────

/** Runs connect for the cookie's session and returns the service URL CAS would be given. */
async function connectService(call, cookie, next = '/calendar') {
  const res = await call('GET', `/auth/purdue/connect?next=${encodeURIComponent(next)}`, { cookie })
  return new URL(new URL(res.location).searchParams.get('service'))
}

test('the callback refuses a missing or wrong state before calling CAS, and spends the state either way', async () => {
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas', cas: { user: 'pete' } }, async ({ call, sessionFor, sessions, cas, linkCalls }) => {
    const cookie = await sessionFor({ userId: U1 })
    const STATE_ERROR = `${CLIENT}/settings?error=purdue-link-state`
    await connectService(call, cookie)
    assert.equal((await call('GET', '/auth/purdue/callback?ticket=ST-1', { cookie })).location, STATE_ERROR)
    assert.equal((await sessions())[0].casState, undefined)

    const service = await connectService(call, cookie)
    const state = service.searchParams.get('state')
    assert.equal((await call('GET', `/auth/purdue/callback?ticket=ST-1&state=${'0'.repeat(32)}`, { cookie })).location, STATE_ERROR)
    // The right state after a wrong one: already spent.
    assert.equal((await call('GET', `/auth/purdue/callback?ticket=ST-1&state=${state}`, { cookie })).location, STATE_ERROR)
    assert.deepEqual(cas.requests, [])
    assert.deepEqual(linkCalls, [])
  })
})

test('the callback without a ticket reports missing-ticket after spending the state', async () => {
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas', cas: { user: 'pete' } }, async ({ call, sessionFor, sessions, cas }) => {
    const cookie = await sessionFor({ userId: U1 })
    const state = (await connectService(call, cookie)).searchParams.get('state')
    const res = await call('GET', `/auth/purdue/callback?state=${state}`, { cookie })
    assert.equal(res.location, `${CLIENT}/settings?error=missing-ticket`)
    assert.equal((await sessions())[0].casState, undefined)
    assert.deepEqual(cas.requests, [])
  })
})

test('the callback validates the ticket against the service URL connect sent, links the CAS identity and redirects; a replay is refused', async () => {
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas', cas: { user: 'ppete', mail: 'ppete@purdue.edu' } }, async ({ call, sessionFor, cas, linkCalls }) => {
    const cookie = await sessionFor({ userId: U1 })
    const service = await connectService(call, cookie, '/calendar')
    const state = service.searchParams.get('state')
    const res = await call('GET', `/auth/purdue/callback?next=%2Fcalendar&state=${state}&ticket=ST-42`, { cookie })
    assert.equal(res.location, `${CLIENT}/calendar`)
    assert.deepEqual(cas.requests, [{ service: service.toString(), ticket: 'ST-42' }])
    assert.deepEqual(linkCalls, [[U1, 'ppete@purdue.edu']])
    const replay = await call('GET', `/auth/purdue/callback?next=%2Fcalendar&state=${state}&ticket=ST-42`, { cookie })
    assert.equal(replay.location, `${CLIENT}/settings?error=purdue-link-state`)
    assert.equal(cas.requests.length, 1)
  })
  // No mail attribute: the username at purdue.edu.
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas', cas: { user: 'ppete' } }, async ({ call, sessionFor, linkCalls }) => {
    const cookie = await sessionFor({ userId: U1 })
    const state = (await connectService(call, cookie)).searchParams.get('state')
    await call('GET', `/auth/purdue/callback?next=%2Fcalendar&state=${state}&ticket=ST-1`, { cookie })
    assert.deepEqual(linkCalls, [[U1, 'ppete@purdue.edu']])
  })
})

test('a CAS outage gives the student a plain message, and a refused ticket its own', async () => {
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas', cas: { status: 500 } }, async ({ call, sessionFor, linkCalls }) => {
    const cookie = await sessionFor({ userId: U1 })
    const state = (await connectService(call, cookie)).searchParams.get('state')
    await quietly(async () => {
      const res = await call('GET', `/auth/purdue/callback?next=%2Fcalendar&state=${state}&ticket=ST-1`, { cookie })
      const url = new URL(res.location)
      assert.equal(`${url.origin}${url.pathname}`, `${CLIENT}/setup`)
      assert.equal(url.searchParams.get('error'), 'purdue-link')
      assert.equal(url.searchParams.get('message'), 'Purdue login is not responding right now. Please try again in a few minutes.')
    })
    assert.deepEqual(linkCalls, [])
  })
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas', cas: { user: null } }, async ({ call, sessionFor }) => {
    const cookie = await sessionFor({ userId: U1 })
    const state = (await connectService(call, cookie)).searchParams.get('state')
    await quietly(async () => {
      const res = await call('GET', `/auth/purdue/callback?next=%2Fcalendar&state=${state}&ticket=ST-1`, { cookie })
      assert.equal(new URL(res.location).searchParams.get('message'), 'CAS ticket validation failed.')
    })
  })
})

test('the native callback needs no session, spends its token once CAS vouches, and a replay is refused as used', async () => {
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'cas', cas: { user: 'ppete' } }, async ({ call, purdueLinkHandoff, cas, linkCalls, sessions }) => {
    const { token } = purdueLinkHandoff.issue(U1)
    const res = await call('GET', `/auth/purdue/callback?t=${encodeURIComponent(token)}&ticket=ST-7`)
    assert.equal(res.location, 'boilerindyapp://purdue-linked?status=ok')
    assert.deepEqual(cas.requests, [{ service: `${BACKEND}/auth/purdue/callback?t=${encodeURIComponent(token)}`, ticket: 'ST-7' }])
    assert.deepEqual(linkCalls, [[U1, 'ppete@purdue.edu']])
    const replay = new URL((await call('GET', `/auth/purdue/callback?t=${encodeURIComponent(token)}&ticket=ST-7`)).location)
    assert.equal(replay.searchParams.get('reason'), 'used')
    assert.equal(linkCalls.length, 1)
    assert.deepEqual(await sessions(), [])
    const { token: second } = purdueLinkHandoff.issue(U1)
    const noTicket = new URL((await call('GET', `/auth/purdue/callback?t=${encodeURIComponent(second)}`)).location)
    assert.equal(noTicket.searchParams.get('reason'), 'missing-ticket')
  })
})

// ── The Purdue link: JSON routes ────────────────────────────────────────────

test('mock-link links and answers the fresh session payload, per mode', async () => {
  await withApp({ seed: { users: [STUDENT] } }, async ({ call, sessionFor, linkCalls }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('POST', '/api/purdue/mock-link', { cookie, body: { email: 'pete@purdue.edu' } })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.session.user.purdueEmail, 'pete@purdue.edu')
    assert.equal(res.body.session.user.hasPurdueLinked, true)
    assert.deepEqual(linkCalls, [[U1, 'pete@purdue.edu']])
  })
  await withApp({ seed: { users: [STUDENT] }, linkError: new Error('Please use a valid @purdue.edu account.') }, async ({ call, sessionFor }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('POST', '/api/purdue/mock-link', { cookie, body: { email: 'pete@gmail.com' } })
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: { message: 'Please use a valid @purdue.edu account.', status: 400 } })
  })
  for (const [mode, message] of [['off', 'Purdue linking is currently disabled.'], ['cas', 'Mock Purdue linking is disabled while CAS mode is active.']]) {
    await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: mode }, async ({ call, sessionFor, linkCalls }) => {
      const cookie = await sessionFor({ userId: U1 })
      const res = await call('POST', '/api/purdue/mock-link', { cookie, body: { email: 'pete@purdue.edu' } })
      assert.equal(res.status, 400)
      assert.deepEqual(res.body, { error: { message, status: 400 } })
      assert.deepEqual(linkCalls, [])
    })
  }
})

test('link-token issues a handoff token with the connect and return URLs, and refuses when linking is off', async () => {
  await withApp({ seed: { users: [STUDENT] } }, async ({ call, sessionFor, purdueLinkHandoff }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('POST', '/api/purdue/link-token', { cookie })
    assert.equal(res.status, 200)
    assert.equal(purdueLinkHandoff.verify(res.body.token).userId, U1)
    assert.equal(res.body.connectUrl, `${BACKEND}/auth/purdue/connect?t=${encodeURIComponent(res.body.token)}`)
    assert.equal(res.body.returnUrl, 'boilerindyapp://purdue-linked')
    assert.ok(Date.parse(res.body.expiresAt) > Date.now())
  })
  await withApp({ seed: { users: [STUDENT] }, purdueAuthMode: 'off' }, async ({ call, sessionFor }) => {
    const cookie = await sessionFor({ userId: U1 })
    const res = await call('POST', '/api/purdue/link-token', { cookie })
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: { message: 'Purdue linking is currently disabled.', status: 400, code: 'purdue_linking_disabled' } })
  })
})
