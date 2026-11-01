import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { createPushPublicRouter, createPushRouter } from '../../src/routes/push.mjs'
import { settingsFromRow } from '../../src/pushReminders.mjs'
import { NOTIFICATION_KINDS_VERSION, notificationKindsDigest } from '../../src/notificationKinds.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the push routes as feature routers, booted on a small app with
// a fake session, recording limiters and a recording database. The VAPID keys,
// the cron token, its check and warnCronTransient are what server.mjs hands
// in; nothing here reaches a push service (no subscription is ever sent to).

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com' }
const KEYS = { publicKey: 'BPublicKeyForTests', privateKey: 'privateKeyForTests', subject: 'mailto:test@example.com' }
const CRON_SECRET = 'cron-secret-for-tests'
const PHONE = 'ExponentPushToken[phone000000000000000001]'

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

async function withApp({ user = STUDENT, vapidKeys = KEYS, cronSecret = CRON_SECRET, tables = {}, expoAnswer = null, getDiningSnapshot, kindsOff, expoAccessToken, receiptsAnswer = null } = {}, run) {
  const supabase = fakeSupabase(tables)
  const limiterHits = []
  const transientWarnings = []
  // Stands in for sendExpoPush: records each request's messages and the access
  // token it was handed, and answers every message ok unless the test hands
  // in its own answer.
  const expoRequests = []
  const expoTokens = []
  const sendExpo = async ({ messages, accessToken }) => {
    expoRequests.push(messages)
    expoTokens.push(accessToken)
    return expoAnswer ? expoAnswer(messages) : messages.map((m) => ({ token: m.to, ok: true, ticketId: `t-${m.to}` }))
  }
  // Stands in for fetchExpoReceipts (issue #550, item 7).
  const receiptRequests = []
  const getExpoReceipts = async ({ ids, accessToken }) => {
    receiptRequests.push({ ids, accessToken })
    return receiptsAnswer ? receiptsAnswer(ids) : { ok: true, receipts: new Map() }
  }
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
      getDiningSnapshot,
      kindsOff,
      expoAccessToken,
      sendExpo,
      getExpoReceipts,
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
    await run({ call, supabase, limiterHits, transientWarnings, expoRequests, expoTokens, receiptRequests })
  })
}

// ── GET /api/push/config ────────────────────────────────────────────────────

test('the public config reports the key, or that push is off, never cached, behind both public-read limiters', async () => {
  // The kind registry's version and digest (issue #550), with push on or off,
  // for the app to compare with its copy's.
  const kinds = { version: NOTIFICATION_KINDS_VERSION, digest: await notificationKindsDigest() }
  assert.match(kinds.digest, /^[0-9a-f]{64}$/)
  for (const [vapidKeys, expected] of [
    [KEYS, { enabled: true, publicKey: KEYS.publicKey, kinds }],
    [null, { enabled: false, publicKey: null, kinds }],
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
    const routes = [['GET', '/api/push/settings'], ['PUT', '/api/push/settings'], ['POST', '/api/push/subscriptions'], ['DELETE', '/api/push/subscriptions'], ['POST', '/api/push/test'], ['POST', '/api/me/push-token'], ['DELETE', '/api/me/push-token']]
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
    push_devices: () => ({ data: [{ id: 'd1', platform: 'ios', device_name: 'iPhone', created_at: '2026-10-02T00:00:00.000Z', last_seen_at: '2026-10-03T00:00:00.000Z', token: PHONE }], error: null }),
  }
  await withApp({ tables }, async ({ call, supabase }) => {
    const res = await call('GET', '/api/push/settings')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(res.body, {
      enabled: true,
      settings: settingsFromRow({ deadline_reminders: false, lead_minutes: 120 }),
      diningAlertsAvailable: true,
      kindsAvailable: true,
      subscriptions: [{ id: 's1', createdAt: '2026-10-01T00:00:00.000Z', userAgent: 'Safari', lastUsedAt: null }],
      devices: [{ id: 'd1', platform: 'ios', deviceName: 'iPhone', createdAt: '2026-10-02T00:00:00.000Z', lastSeenAt: '2026-10-03T00:00:00.000Z', localReminders: false, kinds: null }],
    })
    assert.ok(!JSON.stringify(res.body).includes('PushToken'), 'the token is never returned')
    const [devices] = supabase.queriesOf('push_devices')
    assert.ok(hasCall(devices.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(!devices.chain.find((c) => c.method === 'select').args[0].includes('token'), 'the token is not even read')
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
  await withApp({ tables: { push_settings: missing, push_subscriptions: missing, push_devices: missing } }, async ({ call }) => {
    const res = await call('GET', '/api/push/settings')
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'push_not_configured')
  })
})

test('before db/supabase-push-devices.sql runs, the settings route still answers, with no devices', async () => {
  const tables = {
    push_settings: () => ({ data: null, error: null }),
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.push_devices' in the schema cache" } }),
  }
  await withApp({ tables }, async ({ call }) => {
    const res = await call('GET', '/api/push/settings')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.devices, [])
    assert.deepEqual(res.body.subscriptions, [])
  })
  const broken = { ...tables, push_devices: () => ({ data: null, error: { code: '42501', message: 'permission denied for table push_devices' } }) }
  await withApp({ tables: broken }, async ({ call }) => {
    const res = await call('GET', '/api/push/settings')
    assert.equal(res.status, 500)
  })
})

// Antoniodeoliveirasegura/boilerindy-app#55: push_devices.local_reminders,
// which db/supabase-push-local-reminders.sql (README step 47) adds.
const selectOf = (chain) => chain.find((c) => c.method === 'select')?.args[0] || ''
const PHONES = [
  { id: 'd1', platform: 'ios', device_name: 'iPhone', created_at: '2026-10-02T00:00:00.000Z', last_seen_at: '2026-10-03T00:00:00.000Z', local_reminders: true },
  { id: 'd2', platform: 'android', device_name: 'Pixel', created_at: '2026-10-04T00:00:00.000Z', last_seen_at: '2026-10-05T00:00:00.000Z', local_reminders: false },
]

test('GET /api/push/settings lists localReminders for each phone', async () => {
  const tables = {
    push_settings: () => ({ data: null, error: null }),
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: () => ({ data: PHONES, error: null }),
  }
  await withApp({ tables }, async ({ call, supabase }) => {
    const res = await call('GET', '/api/push/settings')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.devices.map((d) => [d.id, d.localReminders]), [['d1', true], ['d2', false]])
    const [devices] = supabase.queriesOf('push_devices')
    assert.match(selectOf(devices.chain), /\blocal_reminders\b/)
  })
})

test('before README step 47 runs, the settings still list every phone, each with localReminders false', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const tables = {
    push_settings: () => ({ data: null, error: null }),
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: (chain) =>
      selectOf(chain).includes('local_reminders')
        ? { data: null, error: { code: '42703', message: 'column push_devices.local_reminders does not exist' } }
        : { data: PHONES.map(({ local_reminders: _missing, ...row }) => row), error: null },
  }
  await withApp({ tables }, async ({ call, supabase }) => {
    for (let i = 0; i < 2; i += 1) {
      const res = await call('GET', '/api/push/settings')
      assert.equal(res.status, 200)
      assert.deepEqual(res.body.devices.map((d) => [d.id, d.localReminders]), [['d1', false], ['d2', false]], 'the phones are not read as gone')
    }
    assert.equal(supabase.queriesOf('push_devices').length, 4, 'each read is tried with the column, then without it')
  })
  assert.equal(log.mock.callCount(), 1, 'the log names the file once')
  assert.match(String(log.mock.calls[0].arguments[0]), /db\/supabase-push-local-reminders\.sql/)
})

// A push_settings row once README step 53 has run (issue #550), at its defaults.
const KINDS_ROW = {
  class_reminders: false,
  class_lead_minutes: 15,
  digest_minute: 1080,
  deadline_items: true,
  quiet_start: 1380,
  quiet_end: 480,
  campus_alerts: true,
  kinds_migrated_at: null,
}

test('PUT /api/push/settings validates the patch and keeps the field it does not change', async () => {
  const tables = {
    push_settings: (chain) =>
      operation(chain) === 'upsert'
        ? { data: null, error: null }
        : { data: { deadline_reminders: true, lead_minutes: 60, dining_favorite_alerts: false, ...KINDS_ROW }, error: null },
  }
  await withApp({ tables }, async ({ call, supabase, limiterHits }) => {
    const bad = await call('PUT', '/api/push/settings', { deadlineReminders: 'yes' })
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.body, { error: { message: 'deadlineReminders must be true or false', status: 400 } })

    const res = await call('PUT', '/api/push/settings', { deadlineReminders: false })
    assert.equal(res.status, 200)
    const saved = { deadline_reminders: false, lead_minutes: 60, dining_favorite_alerts: false, ...KINDS_ROW }
    assert.deepEqual(res.body, { settings: settingsFromRow(saved), diningAlertsAvailable: true, kindsAvailable: true })
    const upsert = supabase.queriesOf('push_settings').find((q) => operation(q.chain) === 'upsert')
    const [row, options] = upsert.chain.find((c) => c.method === 'upsert').args
    assert.deepEqual({ ...row, updated_at: undefined }, { user_id: STUDENT.id, ...saved, updated_at: undefined })
    assert.ok(!Number.isNaN(Date.parse(row.updated_at)), 'updated_at is an ISO timestamp')
    assert.deepEqual(options, { onConflict: 'user_id' })
    assert.deepEqual(limiterHits, ['push-write PUT /api/push/settings', 'push-write PUT /api/push/settings'])
  })
})

// Issue #469: the favorite-dish alerts switch is a column that
// db/supabase-dining-favorite-alerts.sql adds.
const settingsSelect = (chain) => chain.find((c) => c.method === 'select')?.args[0] || ''

test('PUT /api/push/settings turns favorite-dish alerts on and keeps them through other changes', async () => {
  let saved = { deadline_reminders: true, lead_minutes: 60, dining_favorite_alerts: false }
  const tables = {
    push_settings: (chain) => {
      if (operation(chain) === 'upsert') {
        saved = chain.find((c) => c.method === 'upsert').args[0]
        return { data: null, error: null }
      }
      return { data: saved, error: null }
    },
  }
  await withApp({ tables }, async ({ call }) => {
    const on = await call('PUT', '/api/push/settings', { diningFavoriteAlerts: true })
    assert.equal(on.status, 200)
    assert.equal(on.body.settings.diningFavoriteAlerts, true)
    assert.equal(saved.dining_favorite_alerts, true)
    const lead = await call('PUT', '/api/push/settings', { leadMinutes: 30 })
    assert.equal(lead.body.settings.diningFavoriteAlerts, true)
    assert.equal(saved.dining_favorite_alerts, true)
    const bad = await call('PUT', '/api/push/settings', { diningFavoriteAlerts: 'on' })
    assert.equal(bad.status, 400)
  })
})

test('before db/supabase-dining-favorite-alerts.sql runs, the settings work without the switch, which says it is not set up', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const upserts = []
  const tables = {
    push_settings: (chain) => {
      if (operation(chain) === 'upsert') {
        upserts.push(chain.find((c) => c.method === 'upsert').args[0])
        return { data: null, error: null }
      }
      if (settingsSelect(chain).includes('dining_favorite_alerts')) {
        return { data: null, error: { code: '42703', message: 'column push_settings.dining_favorite_alerts does not exist' } }
      }
      // Nor has README step 53 (issue #550), which comes after it.
      if (settingsSelect(chain).includes('digest_minute')) {
        return { data: null, error: { code: '42703', message: 'column push_settings.digest_minute does not exist' } }
      }
      return { data: { deadline_reminders: true, lead_minutes: 60 }, error: null }
    },
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: () => ({ data: [], error: null }),
  }
  await withApp({ tables }, async ({ call }) => {
    const res = await call('GET', '/api/push/settings')
    assert.equal(res.status, 200)
    assert.equal(res.body.diningAlertsAvailable, false)
    assert.equal(res.body.kindsAvailable, false)
    assert.equal(res.body.settings.diningFavoriteAlerts, false)

    const on = await call('PUT', '/api/push/settings', { diningFavoriteAlerts: true })
    assert.equal(on.status, 503)
    assert.equal(on.body.error.code, 'dining_alerts_schema_missing')
    assert.equal(upserts.length, 0)

    const lead = await call('PUT', '/api/push/settings', { leadMinutes: 30 })
    assert.equal(lead.status, 200)
    assert.equal(lead.body.diningAlertsAvailable, false)
    assert.deepEqual(Object.keys(upserts[0]).sort(), ['deadline_reminders', 'lead_minutes', 'updated_at', 'user_id'])
  })
  assert.match(String(log.mock.calls[0].arguments[0]), /db\/supabase-dining-favorite-alerts\.sql/)
})

test('the reminder run also runs the favorite-dish alerts when it has the dining snapshot', async () => {
  const tables = {
    push_settings: () => ({ data: [], error: null }),
    push_tickets: () => ({ data: [], error: null }),
  }
  const snapshots = []
  await withApp({ tables, getDiningSnapshot: async (options) => (snapshots.push(options), { ok: true, locations: [] }) }, async ({ call }) => {
    const res = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    assert.equal(res.status, 200)
    assert.ok(res.body.dining, 'the summary carries the dining run')
    assert.equal(typeof res.body.dining.sent, 'number')
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
  const empty = { push_subscriptions: () => ({ data: [], error: null }), push_devices: () => ({ data: [], error: null }) }
  await withApp({ tables: empty }, async ({ call, limiterHits, expoRequests }) => {
    const res = await call('POST', '/api/push/test', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { sent: 0, failed: 0, removed: 0 })
    assert.deepEqual(limiterHits, ['push-test POST /api/push/test'])
    assert.deepEqual(expoRequests, [], 'no phones, no Expo request')
  })
})

// ── The native app: /api/me/push-token (issue #194) ─────────────────────────

// push_settings answers the ensure-a-row upsert; push_devices answers the
// student's existing phones on a select and the new row on the upsert, with
// the local_reminders it was given, as the database would.
const upsertedRow = (chain) => chain.find((c) => c.method === 'upsert').args[0]
function deviceTables({ existing = [], settings = () => ({ data: null, error: null }) } = {}) {
  return {
    push_settings: settings,
    push_devices: (chain) => {
      if (operation(chain) !== 'upsert') return { data: existing, error: null }
      const row = upsertedRow(chain)
      const stored = Object.fromEntries(['local_reminders', 'kinds', 'channels', 'kinds_version', 'redact'].filter((column) => column in row).map((column) => [column, row[column]]))
      return { data: { id: 'd1', created_at: '2026-10-08T00:00:00.000Z', ...stored }, error: null }
    },
  }
}

test('POST /api/me/push-token registers the phone and makes sure the student has settings', async () => {
  await withApp({ tables: deviceTables() }, async ({ call, supabase, limiterHits }) => {
    const res = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios', deviceName: '  Ana iPhone  ' })
    assert.equal(res.status, 201)
    assert.deepEqual(res.body, { device: { id: 'd1', createdAt: '2026-10-08T00:00:00.000Z', localReminders: false, kinds: null, channels: null, kindsVersion: null, redact: false } })
    assert.deepEqual(limiterHits, ['push-write POST /api/me/push-token'])

    const [settings] = supabase.queriesOf('push_settings')
    const [settingsRow, settingsOptions] = settings.chain.find((c) => c.method === 'upsert').args
    assert.deepEqual(settingsRow, { user_id: STUDENT.id }, 'the defaults, nothing else')
    assert.deepEqual(settingsOptions, { onConflict: 'user_id', ignoreDuplicates: true }, 'never overwrites a saved choice')

    const [existing, upsert] = supabase.queriesOf('push_devices')
    assert.ok(hasCall(existing.chain, 'eq', 'user_id', STUDENT.id))
    const [row, options] = upsert.chain.find((c) => c.method === 'upsert').args
    assert.deepEqual({ ...row, last_seen_at: undefined }, {
      user_id: STUDENT.id,
      kind: 'expo',
      token: PHONE,
      platform: 'ios',
      device_name: 'Ana iPhone',
      last_seen_at: undefined,
      failure_count: 0,
      local_reminders: false,
      // An older build's body: no kinds, which the reminder runs read as such (issue #550).
      kinds: null,
      channels: null,
      kinds_version: null,
      redact: false,
      activity_start_token: null,
    })
    assert.ok(!Number.isNaN(Date.parse(row.last_seen_at)))
    assert.deepEqual(options, { onConflict: 'token' })
  })
})

// Antoniodeoliveirasegura/boilerindy-app#55: the app says whether it schedules
// the student's reminders on this phone itself.
test('POST /api/me/push-token stores localReminders, and registering again replaces it', async () => {
  await withApp({ tables: deviceTables({ existing: [{ id: 'd1', token: PHONE }] }) }, async ({ call, supabase }) => {
    const on = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios', localReminders: true })
    assert.equal(on.status, 201)
    assert.deepEqual(on.body, { device: { id: 'd1', createdAt: '2026-10-08T00:00:00.000Z', localReminders: true, kinds: null, channels: null, kindsVersion: null, redact: false } })

    const off = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios', localReminders: false })
    assert.equal(off.body.device.localReminders, false)
    const again = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios', localReminders: true })
    assert.equal(again.body.device.localReminders, true)
    const omitted = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios' })
    assert.equal(omitted.body.device.localReminders, false, 'a body without the flag stores false')

    const upserts = supabase.queriesOf('push_devices').filter((q) => operation(q.chain) === 'upsert')
    assert.deepEqual(upserts.map((q) => upsertedRow(q.chain).local_reminders), [true, false, true, false])
    for (const q of upserts) {
      assert.deepEqual(q.chain.find((c) => c.method === 'upsert').args[1], { onConflict: 'token' }, 'the same row, by token')
      assert.equal(selectOf(q.chain), 'id, created_at, local_reminders, kinds, channels, kinds_version, redact')
    }
  })
})

test('POST /api/me/push-token refuses a localReminders that is not true or false, before any query', async () => {
  await withApp({ tables: deviceTables() }, async ({ call, supabase }) => {
    for (const bad of ['true', 'yes', 1, null, {}]) {
      const res = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios', localReminders: bad })
      assert.equal(res.status, 400, JSON.stringify(bad))
      assert.deepEqual(res.body, { error: { message: 'localReminders must be true or false.', status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('before README step 47 runs, a phone still registers, without the flag, and the log names the file once', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const tables = {
    push_settings: () => ({ data: null, error: null }),
    push_devices: (chain) => {
      if (operation(chain) !== 'upsert') return { data: [], error: null }
      if ('local_reminders' in upsertedRow(chain)) {
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'local_reminders' column of 'push_devices' in the schema cache" } }
      }
      return { data: { id: 'd1', created_at: '2026-10-08T00:00:00.000Z' }, error: null }
    },
  }
  await withApp({ tables }, async ({ call, supabase }) => {
    for (let i = 0; i < 2; i += 1) {
      const res = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios', deviceName: 'Ana iPhone', localReminders: true })
      assert.equal(res.status, 201, 'registration is not broken')
      assert.deepEqual(res.body, { device: { id: 'd1', createdAt: '2026-10-08T00:00:00.000Z', localReminders: false, kinds: null, channels: null, kindsVersion: null, redact: false } }, 'the answer says the flag was not stored')
    }
    const upserts = supabase.queriesOf('push_devices').filter((q) => operation(q.chain) === 'upsert')
    assert.equal(upserts.length, 4, 'each registration is tried with the column, then without it')
    const fallback = upserts[1]
    assert.deepEqual({ ...upsertedRow(fallback.chain), last_seen_at: undefined }, {
      user_id: STUDENT.id,
      kind: 'expo',
      token: PHONE,
      platform: 'ios',
      device_name: 'Ana iPhone',
      last_seen_at: undefined,
      failure_count: 0,
    })
    assert.equal(selectOf(fallback.chain), 'id, created_at')
  })
  assert.equal(log.mock.callCount(), 1, 'the log names the file once')
  assert.match(String(log.mock.calls[0].arguments[0]), /^\[push_local_reminders\] schema missing: run db\/supabase-push-local-reminders\.sql/)
})

test('the app body the app already sends, { token, platform }, is enough', async () => {
  await withApp({ tables: deviceTables() }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'android' })
    assert.equal(res.status, 201)
    const upsert = supabase.queriesOf('push_devices').find((q) => operation(q.chain) === 'upsert')
    const [row] = upsert.chain.find((c) => c.method === 'upsert').args
    assert.equal(row.platform, 'android')
    assert.equal(row.device_name, null)
  })
})

test('POST /api/me/push-token needs push on and a valid token and platform, checked before any query', async () => {
  await withApp({ vapidKeys: null }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios' })
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'push_disabled')
    assert.equal(supabase.queries.length, 0)
  })
  await withApp({}, async ({ call, supabase }) => {
    const badToken = await call('POST', '/api/me/push-token', { token: 'https://push.example.com/send/abc', platform: 'ios' })
    assert.equal(badToken.status, 400)
    assert.deepEqual(badToken.body, { error: { message: 'token must be an Expo push token, ExponentPushToken[...].', status: 400 } })
    const badPlatform = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'web' })
    assert.equal(badPlatform.status, 400)
    assert.deepEqual(badPlatform.body, { error: { message: 'platform must be ios or android.', status: 400 } })
    assert.equal(supabase.queries.length, 0)
  })
})

test('a new phone past the ten-phone cap is refused, a known one re-registers', async () => {
  const existing = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, token: i === 0 ? PHONE : `ExponentPushToken[other${i}]` }))
  await withApp({ tables: deviceTables({ existing }) }, async ({ call, supabase }) => {
    const refused = await call('POST', '/api/me/push-token', { token: 'ExponentPushToken[brandnew]', platform: 'ios' })
    assert.equal(refused.status, 409)
    assert.deepEqual(refused.body, { error: { message: 'You can register at most 10 devices. Turn notifications off on an old device first.', status: 409 } })
    assert.equal(supabase.queriesOf('push_devices').filter((q) => operation(q.chain) === 'upsert').length, 0)

    const again = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios' })
    assert.equal(again.status, 201)
  })
})

test('a missing table answers push_not_configured naming the file to run', async () => {
  const missing = (table) => () => ({ data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } })
  await withApp({ tables: { push_settings: () => ({ data: null, error: null }), push_devices: missing('push_devices') } }, async ({ call }) => {
    const res = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios' })
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'push_not_configured')
    assert.match(res.body.error.message, /db\/supabase-push-devices\.sql/)
    const del = await call('DELETE', '/api/me/push-token', { token: PHONE })
    assert.equal(del.status, 503)
    assert.match(del.body.error.message, /db\/supabase-push-devices\.sql/)
  })
  await withApp({ tables: deviceTables({ settings: missing('push_settings') }) }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios' })
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'push_not_configured')
    assert.match(res.body.error.message, /db\/supabase-push\.sql/)
    assert.equal(supabase.queriesOf('push_devices').length, 0, 'nothing is stored without the settings table')
  })
})

test("DELETE /api/me/push-token removes only the student's own phone", async () => {
  const tables = { push_devices: () => ({ data: [{ id: 'd1' }], error: null }) }
  await withApp({ tables }, async ({ call, supabase, limiterHits }) => {
    const missing = await call('DELETE', '/api/me/push-token', {})
    assert.equal(missing.status, 400)
    assert.deepEqual(missing.body, { error: { message: 'token is required.', status: 400 } })
    const res = await call('DELETE', '/api/me/push-token', { token: PHONE })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { removed: true })
    const [del] = supabase.queriesOf('push_devices')
    assert.equal(operation(del.chain), 'delete')
    assert.ok(hasCall(del.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(del.chain, 'eq', 'token', PHONE))
    assert.deepEqual(limiterHits, ['push-write DELETE /api/me/push-token', 'push-write DELETE /api/me/push-token'])
  })
})

test('POST /api/push/test reaches the phones too, and drops one Expo no longer knows', async () => {
  const tables = {
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: (chain) =>
      operation(chain) === 'select'
        ? {
            data: [
              { id: 'd1', user_id: STUDENT.id, token: PHONE, failure_count: 0 },
              { id: 'd2', user_id: STUDENT.id, token: 'ExponentPushToken[uninstalled]', failure_count: 0 },
            ],
            error: null,
          }
        : { data: null, error: null },
  }
  const expoAnswer = (messages) =>
    messages.map((m) =>
      m.to === PHONE ? { token: m.to, ok: true, ticketId: 't1' } : { token: m.to, ok: false, error: 'DeviceNotRegistered', gone: true, strike: false },
    )
  await withApp({ tables, expoAnswer }, async ({ call, supabase, expoRequests }) => {
    const res = await call('POST', '/api/push/test', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { sent: 1, failed: 1, removed: 1 })
    assert.equal(expoRequests.length, 1)
    assert.deepEqual(expoRequests[0].map((m) => [m.to, m.title, m.data.url]), [
      [PHONE, 'BoilerIndy notifications are on', '/settings'],
      ['ExponentPushToken[uninstalled]', 'BoilerIndy notifications are on', '/settings'],
    ])
    const [select, del] = supabase.queriesOf('push_devices')
    assert.ok(hasCall(select.chain, 'in', 'user_id', [STUDENT.id]))
    assert.equal(operation(del.chain), 'delete')
    assert.ok(hasCall(del.chain, 'eq', 'id', 'd2'))
  })
})

test('POST /api/push/test reaches a phone with local reminders on too', async () => {
  const tables = {
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: () => ({ data: [{ id: 'd1', user_id: STUDENT.id, token: PHONE, failure_count: 0, local_reminders: true }], error: null }),
  }
  await withApp({ tables }, async ({ call, expoRequests }) => {
    const res = await call('POST', '/api/push/test', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { sent: 1, failed: 0, removed: 0 })
    assert.deepEqual(expoRequests.map((messages) => messages.map((m) => m.to)), [[PHONE]])
  })
})

// Issue #550, item 2: each device hears what it gets. A phone with local
// reminders gets its reminders from the phone, so it is told so; every other
// phone, like the browsers, keeps the old words. One Expo request per wording.
test('POST /api/push/test words the push for each phone', async () => {
  const OTHER = 'ExponentPushToken[phone000000000000000002]'
  const tables = {
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: () => ({
      data: [
        { id: 'd1', user_id: STUDENT.id, token: PHONE, platform: 'ios', failure_count: 0, local_reminders: true },
        { id: 'd2', user_id: STUDENT.id, token: OTHER, platform: 'ios', failure_count: 0, local_reminders: false },
      ],
      error: null,
    }),
  }
  await withApp({ tables }, async ({ call, supabase, expoRequests }) => {
    const res = await call('POST', '/api/push/test', {})
    assert.deepEqual(res.body, { sent: 2, failed: 0, removed: 0 })
    assert.deepEqual(
      expoRequests.map((messages) => messages.map((m) => [m.to, m.title, m.body])),
      [
        [[PHONE, 'Notifications are on for this iPhone', 'Favorite dish alerts come here. Class and task reminders come from the phone itself.']],
        [[OTHER, 'BoilerIndy notifications are on', 'You will get deadline reminders on this device.']],
      ],
    )
    const [devices] = supabase.queriesOf('push_devices')
    assert.match(devices.chain.find((c) => c.method === 'select').args[0], /\bplatform\b/)
  })
})

// Issue #550: PUSH_KINDS_OFF and EXPO_ACCESS_TOKEN, as server.mjs hands them in.
test('POST /api/push/test answers 503 push_kind_off while PUSH_KINDS_OFF lists test, and sends nothing', async () => {
  const tables = {
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: () => ({ data: [{ id: 'd1', user_id: STUDENT.id, token: PHONE, failure_count: 0 }], error: null }),
  }
  await withApp({ tables, kindsOff: new Set(['test']) }, async ({ call, supabase, expoRequests }) => {
    const res = await call('POST', '/api/push/test', {})
    assert.equal(res.status, 503)
    assert.deepEqual(res.body, { error: { code: 'push_kind_off', message: 'Test notifications are switched off on this server.', status: 503 } })
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(expoRequests, [])
  })
  // Another kind switched off leaves the test send alone.
  await withApp({ tables, kindsOff: new Set(['dining-favorites']) }, async ({ call }) => {
    const res = await call('POST', '/api/push/test', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { sent: 1, failed: 0, removed: 0 })
  })
})

test('every Expo request carries the access token, from the test send and the reminder run alike, and no answer does', async () => {
  const phone = { id: 'd1', user_id: STUDENT.id, token: PHONE, failure_count: 0 }
  const soon = new Date(Date.now() + 30 * 60_000).toISOString()
  const tables = {
    push_settings: () => ({ data: [{ user_id: STUDENT.id, lead_minutes: 60 }], error: null }),
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: () => ({ data: [phone], error: null }),
    calendar_items: () => ({ data: [{ id: 'a', title: 'HW 3', start_time: soon, category: 'assignment', all_day: false }], error: null }),
    user_manual_tasks: () => ({ data: [], error: null }),
    user_task_completions: () => ({ data: [], error: null }),
    push_deliveries: () => ({ data: [], error: null }),
    // One ticket from an earlier send is due its receipt.
    push_tickets: (chain) =>
      operation(chain) === 'select' ? { data: [{ ticket_id: 'old', device_id: 'd1', sent_at: '2026-01-01T00:00:00.000Z' }], error: null } : { data: null, error: null },
  }
  await withApp({ tables, expoAccessToken: 'expo-access-token-for-tests' }, async ({ call, expoRequests, expoTokens, receiptRequests }) => {
    const testSend = await call('POST', '/api/push/test', {})
    assert.equal(testSend.status, 200)
    const tick = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    assert.equal(tick.status, 200)
    assert.equal(tick.body.sent, 1)
    assert.deepEqual(expoRequests.map((messages) => messages.map((m) => m.data.kind)), [['test'], ['deadline']])
    assert.deepEqual(expoTokens, ['expo-access-token-for-tests', 'expo-access-token-for-tests'])
    assert.deepEqual(receiptRequests, [{ ids: ['old'], accessToken: 'expo-access-token-for-tests' }], 'the receipts reader carries it too')
    assert.ok(!JSON.stringify([testSend.body, tick.body]).includes('expo-access-token-for-tests'))
  })
  await withApp({ tables }, async ({ call, expoTokens }) => {
    await call('POST', '/api/push/test', {})
    assert.deepEqual(expoTokens, [''], 'none set, none sent')
  })
})

test('a reminder run with kinds switched off skips them before claiming anything', async () => {
  // Only the receipts of earlier sends are read: any other query would fail the run.
  const snapshots = []
  const getDiningSnapshot = async (options) => (snapshots.push(options), { ok: true, locations: [] })
  const tables = { push_tickets: () => ({ data: [], error: null }) }
  await withApp({ tables, getDiningSnapshot, kindsOff: new Set(['deadline', 'deadline-digest', 'dining-favorites']) }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/internal/push/run-reminders', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    assert.equal(res.status, 200)
    assert.equal(res.body.reason, 'kind_off')
    assert.equal(res.body.dining.reason, 'kind_off')
    assert.deepEqual(supabase.queries.map((q) => q.table), ['push_tickets'])
    assert.deepEqual(snapshots, [], 'the menu is not even read')
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
  const tables = { push_settings: () => ({ data: [], error: null }), push_tickets: () => ({ data: [], error: null }) }
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

// ── Issue #550, README step 53: the choices by kind ─────────────────────────

test('PUT /api/push/settings saves the choices by kind, refuses an evening list inside quiet hours, and marks an account migrated once', async () => {
  let saved = { deadline_reminders: true, lead_minutes: 60, dining_favorite_alerts: false, ...KINDS_ROW }
  const tables = {
    push_settings: (chain) => {
      if (operation(chain) === 'upsert') {
        saved = chain.find((c) => c.method === 'upsert').args[0]
        return { data: null, error: null }
      }
      return { data: saved, error: null }
    },
  }
  await withApp({ tables }, async ({ call }) => {
    const res = await call('PUT', '/api/push/settings', {
      classReminders: true,
      classLeadMinutes: 10,
      digestMinute: 19 * 60,
      deadlineItems: false,
      quietStart: 22 * 60,
      quietEnd: 7 * 60,
      campusAlerts: false,
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.kindsAvailable, true)
    const { classReminders, classLeadMinutes, digestMinute, deadlineItems, quietStart, quietEnd, campusAlerts, deadlineReminders } = res.body.settings
    assert.deepEqual(
      { classReminders, classLeadMinutes, digestMinute, deadlineItems, quietStart, quietEnd, campusAlerts, deadlineReminders },
      { classReminders: true, classLeadMinutes: 10, digestMinute: 1140, deadlineItems: false, quietStart: 1320, quietEnd: 420, campusAlerts: false, deadlineReminders: true },
    )
    assert.deepEqual(
      [saved.class_reminders, saved.class_lead_minutes, saved.digest_minute, saved.deadline_items, saved.quiet_start, saved.quiet_end, saved.campus_alerts],
      [true, 10, 1140, false, 1320, 420, false],
    )

    // An evening list inside quiet hours, either way round, is refused and nothing changes.
    for (const body of [{ digestMinute: 22 * 60 + 30 }, { quietStart: 18 * 60, quietEnd: 8 * 60 }]) {
      const refused = await call('PUT', '/api/push/settings', body)
      assert.equal(refused.status, 400, JSON.stringify(body))
      assert.match(refused.body.error.message, /evening list cannot go out during quiet hours/)
    }
    assert.deepEqual([saved.digest_minute, saved.quiet_start], [1140, 1320])

    // Quiet hours off, and the list moved into what were quiet hours: fine now.
    const off = await call('PUT', '/api/push/settings', { quietStart: null, quietEnd: null })
    assert.deepEqual([off.status, off.body.settings.quietStart, off.body.settings.quietEnd], [200, null, null])
    assert.equal((await call('PUT', '/api/push/settings', { digestMinute: 23 * 60 })).status, 200)

    // The first phone on an app build with kinds marks the account migrated, once.
    assert.equal(saved.kinds_migrated_at, null)
    const migrated = await call('PUT', '/api/push/settings', { kindsMigrated: true })
    assert.equal(migrated.body.settings.kindsMigrated, true)
    const first = saved.kinds_migrated_at
    assert.ok(!Number.isNaN(Date.parse(first)))
    await call('PUT', '/api/push/settings', { kindsMigrated: true })
    assert.equal(saved.kinds_migrated_at, first)
  })
})

test('before README step 53, a choice by kind answers 503 push_kinds_schema_missing and the old fields still save', async (t) => {
  t.mock.method(console, 'error', () => {})
  const upserts = []
  const tables = {
    push_settings: (chain) => {
      if (operation(chain) === 'upsert') {
        upserts.push(chain.find((c) => c.method === 'upsert').args[0])
        return { data: null, error: null }
      }
      if (settingsSelect(chain).includes('digest_minute')) {
        return { data: null, error: { code: '42703', message: 'column push_settings.digest_minute does not exist' } }
      }
      return { data: { deadline_reminders: true, lead_minutes: 60, dining_favorite_alerts: true }, error: null }
    },
    push_subscriptions: () => ({ data: [], error: null }),
    push_devices: () => ({ data: [], error: null }),
  }
  await withApp({ tables }, async ({ call }) => {
    const read = await call('GET', '/api/push/settings')
    assert.deepEqual([read.body.kindsAvailable, read.body.diningAlertsAvailable], [false, true])
    // What step 53 will give this row, shown ahead of it.
    assert.deepEqual([read.body.settings.deadlineItems, read.body.settings.digestMinute], [true, 1080])

    for (const body of [{ digestMinute: 1140 }, { quietStart: null, quietEnd: null }, { classReminders: true }, { kindsMigrated: true }]) {
      const res = await call('PUT', '/api/push/settings', body)
      assert.equal(res.status, 503, JSON.stringify(body))
      assert.equal(res.body.error.code, 'push_kinds_schema_missing')
    }
    assert.equal(upserts.length, 0)

    const lead = await call('PUT', '/api/push/settings', { leadMinutes: 30 })
    assert.equal(lead.status, 200)
    assert.equal(lead.body.kindsAvailable, false)
    assert.deepEqual(Object.keys(upserts[0]).sort(), ['deadline_reminders', 'dining_favorite_alerts', 'lead_minutes', 'updated_at', 'user_id'])
  })
})

// Issue #550, item 4 (README step 54): what an app build with kinds reports.
test('POST /api/me/push-token stores the kinds and channels a phone reports, and before step 54 registers without them', async (t) => {
  await withApp({ tables: deviceTables() }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/me/push-token', {
      token: PHONE,
      platform: 'ios',
      kinds: ['dining-favorites', 'campus-alert', 'class'],
      channels: ['dining', 'safety'],
      kindsVersion: 1,
      redact: true,
      activityStartToken: 'a1b2c3d4e5f60718',
    })
    assert.equal(res.status, 201)
    assert.deepEqual(res.body.device, {
      id: 'd1',
      createdAt: '2026-10-08T00:00:00.000Z',
      localReminders: false,
      kinds: ['dining-favorites', 'campus-alert'],
      channels: ['dining', 'safety'],
      kindsVersion: 1,
      redact: true,
    })
    assert.ok(!JSON.stringify(res.body).includes('a1b2c3d4e5f60718'), 'the start token is never returned')
    const upsert = supabase.queriesOf('push_devices').find((q) => operation(q.chain) === 'upsert')
    const row = upsertedRow(upsert.chain)
    assert.deepEqual([row.kinds, row.channels, row.kinds_version, row.redact, row.activity_start_token], [['dining-favorites', 'campus-alert'], ['dining', 'safety'], 1, true, 'a1b2c3d4e5f60718'])
  })

  const log = t.mock.method(console, 'error', () => {})
  const before = {
    push_settings: () => ({ data: null, error: null }),
    push_devices: (chain) => {
      if (operation(chain) !== 'upsert') return { data: [], error: null }
      if ('kinds' in upsertedRow(chain)) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'kinds' column of 'push_devices' in the schema cache" } }
      return { data: { id: 'd1', created_at: '2026-10-08T00:00:00.000Z', local_reminders: upsertedRow(chain).local_reminders }, error: null }
    },
  }
  await withApp({ tables: before }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/me/push-token', { token: PHONE, platform: 'ios', kinds: ['dining-favorites'], localReminders: true })
    assert.equal(res.status, 201)
    assert.deepEqual([res.body.device.kinds, res.body.device.localReminders], [null, true], 'stored as an older build, with its flag')
    const upserts = supabase.queriesOf('push_devices').filter((q) => operation(q.chain) === 'upsert')
    assert.deepEqual(upserts.map((q) => selectOf(q.chain)), ['id, created_at, local_reminders, kinds, channels, kinds_version, redact', 'id, created_at, local_reminders'])
  })
  assert.match(String(log.mock.calls[0].arguments[0]), /db\/supabase-push-device-kinds\.sql/)
})
