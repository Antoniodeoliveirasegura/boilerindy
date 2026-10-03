import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { createPushPublicRouter, createPushRouter } from '../../src/routes/push.mjs'
import { settingsFromRow } from '../../src/pushReminders.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the push routes as feature routers, booted on a small app with
// a fake session, recording limiters and a recording database. The VAPID keys,
// the cron token, its check and warnCronTransient are what server.mjs hands
// in; nothing here reaches a push service (no subscription is ever sent to).

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com' }
const KEYS = { publicKey: 'BPublicKeyForTests', privateKey: 'privateKeyForTests', subject: 'mailto:test@example.com' }
const CRON_SECRET = 'cron-secret-for-tests'

function validSubscription(endpoint = 'https://push.example.com/send/abc') {
  return {
    endpoint,
    keys: {
      p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  }
}

async function serve(app, run) {
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function withApp({ user = STUDENT, vapidKeys = KEYS, cronSecret = CRON_SECRET, tables = {} } = {}, run) {
  const supabase = fakeSupabase(tables)
  const limiterHits = []
  const transientWarnings = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createPushRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      pushWriteRateLimit: limiter('push-write'),
      pushTestRateLimit: limiter('push-test'),
      vapidKeys,
      PUSH_CRON_SECRET: cronSecret,
      pushCronSecretMatches: (header) => Boolean(cronSecret) && header === `Bearer ${cronSecret}`,
      warnCronTransient: (route, error) => transientWarnings.push({ route, error }),
    }),
  )
  // Stands in for apiNotFound: where the cron route falls through to.
  app.use((_req, res) => res.status(404).json({ error: { message: 'Not found.', status: 404 } }))
  await serve(app, async (base) => {
    const call = async (method, path, body, headers = {}) => {
      const response = await fetch(base + path, {
        method,
        headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
    }
    await run({ call, supabase, limiterHits, transientWarnings })
  })
}

// ── GET /api/push/config ────────────────────────────────────────────────────

test('the public config reports the key, or that push is off, never cached, behind both public-read limiters', async () => {
  for (const [vapidKeys, expected] of [
    [KEYS, { enabled: true, publicKey: KEYS.publicKey }],
    [null, { enabled: false, publicKey: null }],
  ]) {
    const hits = []
    const limiter = (name) => (req, _res, next) => {
      hits.push(`${name} ${req.path}`)
      next()
    }
    const app = express()
    app.use(createPushPublicRouter({ publicReadIpRateLimit: limiter('public-read-ip'), publicReadRateLimit: limiter('public-read'), vapidKeys }))
    await serve(app, async (base) => {
      const res = await fetch(`${base}/api/push/config`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), expected)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.equal(res.headers.get('set-cookie'), null)
    })
    assert.deepEqual(hits, ['public-read-ip /api/push/config', 'public-read /api/push/config'])
  }
})

// ── Settings, subscriptions, test send ──────────────────────────────────────

test('every session route needs a signed-in student', async () => {
  await withApp({ user: null }, async ({ call, supabase }) => {
    const routes = [['GET', '/api/push/settings'], ['PUT', '/api/push/settings'], ['POST', '/api/push/subscriptions'], ['DELETE', '/api/push/subscriptions'], ['POST', '/api/push/test']]
    for (const [method, path] of routes) {
      const res = await call(method, path, method === 'GET' ? undefined : {})
      assert.equal(res.status, 401, `${method} ${path}`)
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test("GET /api/push/settings answers the student's settings and devices, never cached", async () => {
  const tables = {
    push_settings: () => ({ data: { deadline_reminders: false, lead_minutes: 120 }, error: null }),
    push_subscriptions: () => ({ data: [{ id: 's1', created_at: '2026-10-01T00:00:00.000Z', user_agent: 'Safari', last_used_at: null }], error: null }),
  }
  await withApp({ tables }, async ({ call, supabase }) => {
    const res = await call('GET', '/api/push/settings')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(res.body, {
      enabled: true,
      settings: settingsFromRow({ deadline_reminders: false, lead_minutes: 120 }),
      subscriptions: [{ id: 's1', createdAt: '2026-10-01T00:00:00.000Z', userAgent: 'Safari', lastUsedAt: null }],
    })
    const [settings] = supabase.queriesOf('push_settings')
    assert.ok(hasCall(settings.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(settings.chain, 'maybeSingle'))
    const [subs] = supabase.queriesOf('push_subscriptions')
    assert.ok(hasCall(subs.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(subs.chain, 'order', 'created_at', { ascending: true }))
  })
})

test('before db/supabase-push.sql runs, the settings route answers 503 push_not_configured', async () => {
  const missing = () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.push_settings' in the schema cache" } })
  await withApp({ tables: { push_settings: missing, push_subscriptions: missing } }, async ({ call }) => {
    const res = await call('GET', '/api/push/settings')
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'push_not_configured')
  })
})

test('PUT /api/push/settings validates the patch and keeps the field it does not change', async () => {
  const tables = {
    push_settings: (chain) => (operation(chain) === 'upsert' ? { data: null, error: null } : { data: { deadline_reminders: true, lead_minutes: 60 }, error: null }),
  }
  await withApp({ tables }, async ({ call, supabase, limiterHits }) => {
    const bad = await call('PUT', '/api/push/settings', { deadlineReminders: 'yes' })
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.body, { error: { message: 'deadlineReminders must be true or false', status: 400 } })

    const res = await call('PUT', '/api/push/settings', { deadlineReminders: false })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { settings: settingsFromRow({ deadline_reminders: false, lead_minutes: 60 }) })
    const upsert = supabase.queriesOf('push_settings').find((q) => operation(q.chain) === 'upsert')
    const [row, options] = upsert.chain.find((c) => c.method === 'upsert').args
    assert.deepEqual({ ...row, updated_at: undefined }, { user_id: STUDENT.id, deadline_reminders: false, lead_minutes: 60, updated_at: undefined })
    assert.ok(!Number.isNaN(Date.parse(row.updated_at)), 'updated_at is an ISO timestamp')
    assert.deepEqual(options, { onConflict: 'user_id' })
    assert.deepEqual(limiterHits, ['push-write PUT /api/push/settings', 'push-write PUT /api/push/settings'])
  })
})

test('POST /api/push/subscriptions needs push on and a valid subscription', async () => {
  await withApp({ vapidKeys: null }, async ({ call }) => {
    const res = await call('POST', '/api/push/subscriptions', { subscription: validSubscription() })
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'push_disabled')
  })
  await withApp({}, async ({ call, supabase }) => {
    const res = await call('POST', '/api/push/subscriptions', { subscription: { endpoint: 'http://insecure.example.com', keys: {} } })
    assert.equal(res.status, 400)
    assert.equal(supabase.queries.length, 0)
  })
})

test('a new device past the ten-device cap is refused, a known one re-registers', async () => {
  const known = 'https://push.example.com/send/known'
  const existing = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, endpoint: i === 0 ? known : `https://push.example.com/send/${i}` }))
  const tables = {
    push_subscriptions: (chain) =>
      operation(chain) === 'upsert' ? { data: { id: 's0', created_at: '2026-10-01T00:00:00.000Z' }, error: null } : { data: existing, error: null },
  }
  await withApp({ tables }, async ({ call, supabase }) => {
    const refused = await call('POST', '/api/push/subscriptions', { subscription: validSubscription('https://push.example.com/send/new') })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error.message, /at most 10 devices/)

    const sub = validSubscription(known)
    const res = await call('POST', '/api/push/subscriptions', { subscription: sub, userAgent: 'Firefox' })
    assert.equal(res.status, 201)
    assert.deepEqual(res.body, { subscription: { id: 's0', createdAt: '2026-10-01T00:00:00.000Z' } })
    const upsert = supabase.queriesOf('push_subscriptions').find((q) => operation(q.chain) === 'upsert')
    const [row, options] = upsert.chain.find((c) => c.method === 'upsert').args
    assert.equal(row.user_id, STUDENT.id)
    assert.equal(row.endpoint, known)
    assert.equal(row.p256dh, sub.keys.p256dh)
    assert.equal(row.auth, sub.keys.auth)
    assert.equal(row.user_agent, 'Firefox')
    assert.equal(row.failure_count, 0)
    assert.ok(!Number.isNaN(Date.parse(row.last_used_at)))
    assert.deepEqual(options, { onConflict: 'endpoint' })
  })
})

test("DELETE /api/push/subscriptions removes only the student's own device", async () => {
  const tables = { push_subscriptions: () => ({ data: [{ id: 's1' }], error: null }) }
  await withApp({ tables }, async ({ call, supabase }) => {
    const missing = await call('DELETE', '/api/push/subscriptions', {})
    assert.equal(missing.status, 400)
    const res = await call('DELETE', '/api/push/subscriptions', { endpoint: 'https://push.example.com/send/abc' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { removed: true })
    const [del] = supabase.queriesOf('push_subscriptions')
    assert.equal(operation(del.chain), 'delete')
    assert.ok(hasCall(del.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(del.chain, 'eq', 'endpoint', 'https://push.example.com/send/abc'))
  })
})

test('POST /api/push/test needs push on, and with no devices sends nothing', async () => {
  await withApp({ vapidKeys: null }, async ({ call }) => {
    const res = await call('POST', '/api/push/test', {})
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'push_disabled')
  })
  await withApp({ tables: { push_subscriptions: () => ({ data: [], error: null }) } }, async ({ call, limiterHits }) => {
    const res = await call('POST', '/api/push/test', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { sent: 0, failed: 0, removed: 0 })
    assert.deepEqual(limiterHits, ['push-test POST /api/push/test'])
  })
})

// ── POST /api/internal/push/run-reminders ───────────────────────────────────

test('the reminder runner falls through without a cron token and refuses a wrong one', async () => {
  await withApp({ cronSecret: '' }, async ({ call }) => {
    const res = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: 'Bearer anything' })
    assert.equal(res.status, 404)
  })
  await withApp({}, async ({ call, supabase }) => {
    const res = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: 'Bearer wrong' })
    assert.equal(res.status, 401)
    assert.deepEqual(res.body, { error: { message: 'Invalid cron secret.', status: 401 } })
    assert.equal(supabase.queries.length, 0)
  })
})

test('with the token, a tick runs and answers its summary', async () => {
  const tables = { push_settings: () => ({ data: [], error: null }) }
  await withApp({ tables }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.sent, 0)
    const [settings] = supabase.queriesOf('push_settings')
    assert.ok(hasCall(settings.chain, 'eq', 'deadline_reminders', true))
  })
  await withApp({ vapidKeys: null }, async ({ call }) => {
    const res = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    assert.equal(res.status, 200)
    assert.equal(res.body.reason, 'no_vapid_keys')
  })
})

test('a Supabase 504 on both attempts answers 503 and goes to warnCronTransient; anything else is a 500', async () => {
  const gateway = () => ({ data: null, error: { message: 'Gateway Timeout' }, status: 504 })
  await withApp({ tables: { push_settings: gateway } }, async ({ call, supabase, transientWarnings }) => {
    const res = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    assert.equal(res.status, 503)
    assert.equal(supabase.queriesOf('push_settings').length, 2, 'retried once')
    assert.equal(transientWarnings.length, 1)
    assert.equal(transientWarnings[0].route, 'POST /api/internal/push/run-reminders')
    assert.equal(transientWarnings[0].error.status, 504)
  })
  const broken = () => ({ data: null, error: { code: '42501', message: 'permission denied for table push_settings' }, status: 401 })
  await withApp({ tables: { push_settings: broken } }, async ({ call, transientWarnings }) => {
    const res = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { ok: false, error: 'Reminder run failed.' })
    assert.deepEqual(transientWarnings, [])
  })
})
