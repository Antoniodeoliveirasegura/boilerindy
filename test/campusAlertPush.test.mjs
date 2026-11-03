import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXPO_RETRY_DELAY_MS,
  campusAlertPayload,
  incidentIdFor,
  messageRole,
  retryFailedBatchOnce,
  runCampusAlertPush,
} from '../src/campusAlertPush.mjs'
import { fakeSupabase, operation } from './routes/fakeSupabase.mjs'

// Issue #550, item 9: IU's campus alerts pushed from the 30-second tick. The
// database is an in-memory one behind the shared recording fake, so a test can
// run tick after tick and read the incidents and messages they leave; the
// senders are fakes, so nothing reaches a push service. Every alert here is
// demo text: never write an emergency into a test.

const KEYS = { publicKey: 'BPublicKeyForTests', privateKey: 'privateKeyForTests', subject: 'mailto:test@example.com' }
const NOW = new Date('2026-11-02T18:00:00Z') // 1:00 PM on campus
const NIGHT = new Date('2026-11-03T05:00:00Z') // midnight on campus
const later = (date, minutes) => new Date(date.getTime() + minutes * 60_000)

const DEMO = 'Demo alert: This is sample text, not a real emergency'
// IU sent each one two minutes before the tick that first reads it.
const alertAt = (id, at, extra = {}) => ({
  id,
  sentAt: later(at, -2).toISOString(),
  headline: DEMO,
  message: null,
  instruction: null,
  severity: 'Severe',
  test: false,
  normal: false,
  ...extra,
})
const normalAt = (id, at) => alertAt(id, at, { headline: 'Demo alert: Campus Status Normal', severity: 'Minor', normal: true })
const testAt = (id, at) => alertAt(id, at, { headline: 'Demo alert: This is a TEST with sample text, not a real emergency', test: true })
const finalAt = (id, at) => alertAt(id, at, { headline: 'Demo final alert: This is sample text, not a real emergency' })

const PRIMARY_KEYS = { campus_alert_incidents: ['id'], campus_alert_messages: ['source', 'source_id'], push_tickets: ['ticket_id'] }

// An in-memory database answering the chains the tick builds: select with
// eq / is / in / order / range / limit / maybeSingle, insert (23505 on a
// duplicate key), update (returning rows after .select()) and delete.
function memoryDb(seed, { missingTables = [], missingColumns = {}, fail = () => null } = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]))
  const answer = (table) => (chain) => {
    const failure = fail(table, chain)
    if (failure) return { data: null, error: failure }
    if (missingTables.includes(table)) {
      return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }
    }
    const rows = (tables[table] ??= [])
    const op = operation(chain)
    const select = chain.find((call) => call.method === 'select')
    const columns = String(select?.args[0] ?? '').split(',').map((column) => column.trim())
    const absent = (missingColumns[table] || []).find((column) => columns.includes(column))
    if (op === 'select' && absent) return { data: null, error: { code: '42703', message: `column ${table}.${absent} does not exist` } }
    const matches = (row) =>
      chain.every(({ method, args: [column, value] }) => {
        if (method === 'eq') return row[column] === value
        if (method === 'is') return (row[column] ?? null) === value
        if (method === 'in') return value.includes(row[column])
        return true
      })
    if (op === 'insert') {
      const list = [].concat(chain.find((call) => call.method === 'insert').args[0])
      const key = PRIMARY_KEYS[table]
      if (key && list.some((row) => rows.some((existing) => key.every((k) => existing[k] === row[k])))) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
      }
      rows.push(...list.map((row) => ({ ...row })))
      return { data: null, error: null }
    }
    // Only the columns asked for, as PostgREST answers.
    const pick = (row) => Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]))
    if (op === 'update') {
      const hit = rows.filter(matches)
      for (const row of hit) Object.assign(row, chain.find((call) => call.method === 'update').args[0])
      return { data: select ? hit.map(pick) : null, error: null }
    }
    if (op === 'delete') {
      tables[table] = rows.filter((row) => !matches(row))
      return { data: null, error: null }
    }
    let out = rows.filter(matches)
    const order = chain.find((call) => call.method === 'order')
    if (order) {
      const [column, { ascending = true } = {}] = order.args
      out = [...out].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1))
    }
    const range = chain.find((call) => call.method === 'range')
    if (range) out = out.slice(range.args[0], range.args[1] + 1)
    const limit = chain.find((call) => call.method === 'limit')
    if (limit) out = out.slice(0, limit.args[0])
    out = out.map(pick)
    if (chain.some((call) => call.method === 'maybeSingle')) return { data: out[0] ?? null, error: null }
    return { data: out, error: null }
  }
  const client = fakeSupabase(new Proxy({}, { get: (_handlers, table) => answer(table) }))
  return { client, tables }
}

// Who is who: a phone that listed campus alerts, a phone from an older build
// (no kinds), a phone that listed only deadlines, a student who turned campus
// alerts off, an admin by users.is_admin and one by ADMIN_EMAILS.
function campus() {
  const subscription = (id, userId) => ({ id, user_id: userId, endpoint: `https://push.example.com/${id}`, p256dh: 'p256dh', auth: 'auth' })
  const phone = (id, userId, extra = {}) => ({
    id,
    user_id: userId,
    token: `ExponentPushToken[${id}]`,
    platform: 'ios',
    failure_count: 0,
    local_reminders: false,
    kinds: null,
    channels: null,
    ...extra,
  })
  return {
    users: [
      { id: 'admin-flag', email: 'owner@example.com', is_admin: true },
      { id: 'admin-email', email: 'helper@example.com', is_admin: false },
      { id: 'student-listed', email: 'listed@example.com', is_admin: false },
      { id: 'student-older', email: 'older@example.com', is_admin: false },
    ],
    push_settings: [
      { user_id: 'student-listed', campus_alerts: true, quiet_start: 1380, quiet_end: 480 },
      { user_id: 'student-older', campus_alerts: true, quiet_start: null, quiet_end: null },
      { user_id: 'student-deadlines', campus_alerts: true, quiet_start: 1380, quiet_end: 480 },
      { user_id: 'student-off', campus_alerts: false, quiet_start: 1380, quiet_end: 480 },
    ],
    push_subscriptions: [subscription('browser-listed', 'student-listed'), subscription('browser-off', 'student-off'), subscription('browser-admin', 'admin-email')],
    push_devices: [
      phone('phone-listed', 'student-listed', { local_reminders: true, kinds: ['campus-alert', 'dining-favorites'], channels: ['safety', 'dining'] }),
      phone('phone-older', 'student-older'),
      phone('phone-deadlines', 'student-deadlines', { platform: 'android', kinds: ['deadline'], channels: ['deadlines'] }),
      phone('phone-off', 'student-off'),
      phone('phone-admin', 'admin-flag'),
    ],
  }
}

function senders({ goneEndpoints = [], expoAnswer = null } = {}) {
  const web = []
  const expo = []
  return {
    web,
    expo,
    send: async (args) => {
      web.push(args)
      return goneEndpoints.includes(args.subscription.endpoint) ? { ok: false, status: 410, gone: true } : { ok: true, status: 201 }
    },
    sendExpo: async ({ messages }) => {
      expo.push(messages)
      return expoAnswer ? expoAnswer(messages) : messages.map((m) => ({ token: m.to, ok: true, ticketId: `ticket-${m.to}` }))
    },
  }
}

function tick(db, out, { alert, now = NOW, fetchedAt = now, ...options }) {
  return runCampusAlertPush({
    client: db.client,
    keys: KEYS,
    readAlert: async () => ({ fetchedAt: fetchedAt.getTime(), alert }),
    now,
    send: out.send,
    sendExpo: out.sendExpo,
    sleep: async () => {},
    adminEmails: ['helper@example.com'],
    log: { warn() {}, log() {} },
    ...options,
  })
}

const tokens = (messages) => messages.map((m) => m.to.slice('ExponentPushToken['.length, -1)).sort()
const endpoints = (calls) => calls.map((call) => call.subscription.endpoint.slice('https://push.example.com/'.length)).sort()

test('messages read as a Normal, a test, a final or an alert', () => {
  assert.equal(messageRole(normalAt('n', NOW)), 'normal')
  assert.equal(messageRole(testAt('t', NOW)), 'test')
  assert.equal(messageRole(finalAt('f', NOW)), 'final')
  assert.equal(messageRole(alertAt('a', NOW, { message: 'Demo text: the sample threat is no longer a threat.' })), 'final')
  assert.equal(messageRole(alertAt('a', NOW)), 'alert')
})

test("an incident's id comes from its first message, the same on every run", () => {
  const id = incidentIdFor('iu', 'demo-1')
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(incidentIdFor('iu', 'demo-1'), id)
  assert.notEqual(incidentIdFor('iu', 'demo-2'), id)
  assert.notEqual(incidentIdFor('purduealert', 'demo-1'), id)
})

test("the push carries IU's words, credited, with the time sent and the incident to open", () => {
  const alert = alertAt('demo-1', NOW, { message: 'Sample description.', instruction: 'Sample instruction.' })
  assert.deepEqual(campusAlertPayload(alert, { kind: 'campus-alert', incidentId: 'inc-1' }), {
    kind: 'campus-alert',
    title: 'IU Indianapolis alert',
    body: `${DEMO} Sample description. Sample instruction.`,
    url: '/safety?incident=inc-1',
    tag: 'campus-inc-1',
    subtitle: 'Sent 12:58 PM',
  })
  // The all clear replaces the alert under its tag: it renotifies by day and is silent at night.
  const normal = normalAt('demo-2', NOW)
  assert.equal(campusAlertPayload(normal, { kind: 'campus-all-clear', incidentId: 'inc-1' }).renotify, true)
  const quiet = campusAlertPayload(normal, { kind: 'campus-all-clear', incidentId: 'inc-1', silent: true })
  assert.equal(quiet.silent, true)
  assert.equal(quiet.tag, 'campus-inc-1')
  assert.equal(campusAlertPayload(testAt('demo-t', NOW), { kind: 'campus-alert', incidentId: 'inc-2' }).title, 'IU Indianapolis test')
  // IU sent no time: no subtitle rather than a wrong one.
  assert.equal('subtitle' in campusAlertPayload({ ...alert, sentAt: null }, { kind: 'campus-alert', incidentId: 'inc-1' }), false)
})

test("an incident's first message is pushed once, to every phone and browser that takes campus alerts", async () => {
  const db = memoryDb(campus())
  const out = senders({ goneEndpoints: ['https://push.example.com/browser-admin'] })
  const alert = alertAt('demo-1', NOW)
  const incident = incidentIdFor('iu', 'demo-1')

  const first = await tick(db, out, { alert })
  assert.deepEqual(
    { role: first.role, incident: first.incident, late: first.late, pushed: first.pushed, sent: first.sent, failed: first.failed, removed: first.removed },
    { role: 'new', incident, late: false, pushed: ['campus-alert'], sent: 4, failed: 1, removed: 1 },
  )
  // Not the phone that listed only deadlines, nor anything of the student who turned campus alerts off.
  assert.equal(out.expo.length, 1)
  const [messages] = out.expo
  assert.deepEqual(tokens(messages), ['phone-admin', 'phone-listed', 'phone-older'])
  for (const message of messages) {
    assert.equal(message.title, 'IU Indianapolis alert')
    assert.equal(message.body, DEMO)
    assert.equal(message.interruptionLevel, 'time-sensitive')
    assert.equal(message.sound, 'default')
    assert.equal(message.priority, 'high')
    assert.equal(message.ttl, 30 * 60)
    assert.equal(message.collapseId, `campus-${incident}`)
    assert.deepEqual(message.data, { url: `/safety?incident=${incident}`, kind: 'campus-alert', tag: `campus-${incident}` })
  }
  // The safety channel only for the phone that created it.
  assert.deepEqual(messages.filter((m) => m.channelId).map((m) => [tokens([m])[0], m.channelId]), [['phone-listed', 'safety']])
  assert.deepEqual(endpoints(out.web), ['browser-admin', 'browser-listed'])
  for (const call of out.web) {
    assert.equal(call.ttl, 30 * 60)
    assert.equal(call.urgency, 'high')
    assert.equal(call.topic, `campus-${incident}`)
  }
  // The browser whose push service said it is gone is dropped.
  assert.deepEqual(db.tables.push_subscriptions.map((sub) => sub.id).sort(), ['browser-listed', 'browser-off'])

  assert.deepEqual(db.tables.campus_alert_incidents, [{ id: incident, test: false, opened_at: alert.sentAt, alert_pushed_at: NOW.toISOString() }])
  assert.deepEqual(db.tables.campus_alert_messages, [{ source: 'iu', source_id: 'demo-1', incident_id: incident, role: 'new', sent_at: alert.sentAt, headline: DEMO }])

  // Every tick after reads the same message from IU's feed, and does nothing.
  const again = await tick(db, out, { alert, now: later(NOW, 0.5) })
  assert.equal(again.seen, true)
  assert.equal(out.expo.length, 1)
  assert.equal(out.web.length, 2)
})

test('updates only change the banner, and the Normal pushes one all clear that replaces the alert, silent in quiet hours', async () => {
  const db = memoryDb(campus())
  const out = senders()
  await tick(db, out, { alert: alertAt('demo-1', NOW) })
  const incident = incidentIdFor('iu', 'demo-1')
  const pushes = out.expo.length

  const update = await tick(db, out, { alert: alertAt('demo-2', later(NOW, 20), { headline: 'Demo alert update: This is sample text, not a real emergency' }), now: later(NOW, 20) })
  assert.deepEqual([update.role, update.incident, update.pushed], ['update', incident, []])
  assert.equal(out.expo.length, pushes)

  // IU's Normal comes at midnight on campus.
  const web = out.web.length
  const normal = await tick(db, out, { alert: normalAt('demo-3', NIGHT), now: NIGHT })
  assert.deepEqual([normal.role, normal.incident, normal.pushed], ['normal', incident, ['campus-all-clear']])
  const clears = out.expo.slice(pushes).flat()
  assert.deepEqual(tokens(clears), ['phone-admin', 'phone-listed', 'phone-older'])
  for (const message of clears) {
    assert.equal(message.collapseId, `campus-${incident}`)
    assert.equal(message.data.kind, 'campus-all-clear')
    assert.equal(message.ttl, 2 * 60 * 60)
  }
  // Quiet hours (11:00 PM to 8:00 AM, or the defaults with no row): passive and
  // without a sound. The student who turned quiet hours off hears it.
  const silent = clears.filter((m) => m.interruptionLevel === 'passive')
  assert.deepEqual(tokens(silent), ['phone-admin', 'phone-listed'])
  for (const message of silent) {
    assert.equal(message.sound, undefined)
    assert.equal(message.priority, 'normal')
  }
  const loud = clears.find((m) => m.to === 'ExponentPushToken[phone-older]')
  assert.deepEqual([loud.interruptionLevel, loud.sound, loud.priority], ['active', 'default', 'high'])
  const browsers = out.web.slice(web)
  assert.deepEqual(endpoints(browsers), ['browser-admin', 'browser-listed'])
  for (const call of browsers) {
    assert.equal(call.payload.silent, true)
    assert.equal(call.urgency, 'low')
    assert.equal(call.ttl, 2 * 60 * 60)
  }

  const [row] = db.tables.campus_alert_incidents
  assert.equal(row.closed_at, NIGHT.toISOString())
  assert.equal(row.clear_pushed_at, NIGHT.toISOString())
  assert.deepEqual(db.tables.campus_alert_messages.map((m) => [m.source_id, m.role, m.incident_id]), [
    ['demo-1', 'new', incident],
    ['demo-2', 'update', incident],
    ['demo-3', 'normal', incident],
  ])
  // A Normal with nothing open pushes nothing.
  const quiet = await tick(db, out, { alert: normalAt('demo-4', later(NIGHT, 60)), now: later(NIGHT, 60) })
  assert.deepEqual([quiet.role, quiet.incident, quiet.pushed], ['normal', null, []])
})

test('a message first seen more than 30 minutes late stays banner-only, and its incident gets no all clear', async () => {
  const db = memoryDb(campus())
  const out = senders()
  const late = alertAt('demo-1', NOW, { sentAt: later(NOW, -31).toISOString() })
  const first = await tick(db, out, { alert: late })
  assert.deepEqual([first.role, first.late, first.pushed], ['new', true, []])
  assert.equal(db.tables.campus_alert_incidents[0].alert_pushed_at, undefined)

  const normal = await tick(db, out, { alert: normalAt('demo-2', later(NOW, 40)), now: later(NOW, 40) })
  assert.deepEqual([normal.role, normal.pushed], ['normal', []])
  assert.equal(db.tables.campus_alert_incidents[0].closed_at, later(NOW, 40).toISOString())
  assert.deepEqual([out.expo.length, out.web.length], [0, 0])

  // A late Normal closes what was pushed without an all clear.
  await tick(db, out, { alert: alertAt('demo-3', later(NOW, 60)), now: later(NOW, 60) })
  const lateNormal = { ...normalAt('demo-4', later(NOW, 120)), sentAt: later(NOW, 80).toISOString() }
  const closed = await tick(db, out, { alert: lateNormal, now: later(NOW, 120) })
  assert.deepEqual([closed.role, closed.late, closed.pushed], ['normal', true, []])
  assert.ok(db.tables.campus_alert_incidents.every((incident) => incident.closed_at))
})

test("IU's tests go to admins only, all clear included, and a real alert meanwhile opens its own incident", async () => {
  const db = memoryDb(campus())
  const out = senders()
  const testIncident = incidentIdFor('iu', 'demo-t1')
  const first = await tick(db, out, { alert: testAt('demo-t1', NOW) })
  assert.deepEqual([first.role, first.incident, first.pushed], ['test', testIncident, ['campus-alert']])
  assert.deepEqual(tokens(out.expo.flat()), ['phone-admin'])
  assert.deepEqual(endpoints(out.web), ['browser-admin'])
  assert.equal(out.expo[0][0].title, 'IU Indianapolis test')

  const real = await tick(db, out, { alert: alertAt('demo-1', later(NOW, 5)), now: later(NOW, 5) })
  assert.deepEqual([real.role, real.incident, real.pushed], ['new', incidentIdFor('iu', 'demo-1'), ['campus-alert']])
  assert.deepEqual(tokens(out.expo[1]), ['phone-admin', 'phone-listed', 'phone-older'])

  // The Normal closes both: each gets its all clear, the test's to the admins only.
  const normal = await tick(db, out, { alert: normalAt('demo-n', later(NOW, 30)), now: later(NOW, 30) })
  assert.deepEqual(normal.pushed, ['campus-all-clear', 'campus-all-clear'])
  const clears = out.expo.slice(2).flat()
  const realTag = `campus-${incidentIdFor('iu', 'demo-1')}`
  assert.deepEqual(
    clears.map((m) => `${tokens([m])[0]} ${m.collapseId}`).sort(),
    [`phone-admin ${realTag}`, `phone-admin campus-${testIncident}`, `phone-listed ${realTag}`, `phone-older ${realTag}`].sort(),
  )
  assert.ok(db.tables.campus_alert_incidents.every((incident) => incident.closed_at && incident.clear_pushed_at))
})

test('overlapping ticks push the alert once', async () => {
  const db = memoryDb(campus())
  const out = senders()
  const alert = alertAt('demo-1', NOW)
  const results = await Promise.all([tick(db, out, { alert }), tick(db, out, { alert }), tick(db, out, { alert })])
  assert.equal(results.filter((r) => r.pushed?.length).length, 1)
  assert.deepEqual(tokens(out.expo.flat()), ['phone-admin', 'phone-listed', 'phone-older'])
  assert.equal(out.web.length, 2)
  assert.equal(db.tables.campus_alert_incidents.length, 1)
  assert.equal(db.tables.campus_alert_messages.length, 1)
})

test('a tick that failed halfway pushes on the next run, once', async () => {
  let failures = 1
  const timeout = { code: '57014', message: 'canceling statement due to statement timeout' }
  const db = memoryDb(campus(), { fail: (table) => (table === 'push_settings' && failures-- > 0 ? timeout : null) })
  const out = senders()
  const alert = alertAt('demo-1', NOW)
  await assert.rejects(tick(db, out, { alert }), /push_settings select/)
  // The incident is open but nothing was claimed or sent, and the message is not marked done.
  assert.equal(db.tables.campus_alert_incidents.length, 1)
  assert.equal(db.tables.campus_alert_incidents[0].alert_pushed_at, undefined)
  assert.equal(db.tables.campus_alert_messages?.length ?? 0, 0)
  assert.equal(out.expo.length, 0)

  const retry = await tick(db, out, { alert })
  assert.deepEqual([retry.role, retry.pushed], ['new', ['campus-alert']])
  assert.equal(db.tables.campus_alert_incidents.length, 1)
  assert.equal(out.expo.length, 1)
  assert.equal((await tick(db, out, { alert })).seen, true)
})

test('a missed Normal does not swallow the next emergency: after a final, or 12 quiet hours, a new incident opens', async () => {
  const db = memoryDb(campus())
  const out = senders()
  await tick(db, out, { alert: alertAt('demo-1', NOW) })
  const final = await tick(db, out, { alert: finalAt('demo-2', later(NOW, 10)), now: later(NOW, 10) })
  assert.deepEqual([final.role, final.incident, final.pushed], ['final', incidentIdFor('iu', 'demo-1'), []])

  // IU's Normal was replaced in the feed before a tick read it; the next emergency is pushed.
  const next = await tick(db, out, { alert: alertAt('demo-3', later(NOW, 60)), now: later(NOW, 60) })
  assert.deepEqual([next.role, next.incident, next.pushed], ['new', incidentIdFor('iu', 'demo-3'), ['campus-alert']])
  const [old, current] = db.tables.campus_alert_incidents
  assert.equal(old.closed_at, later(NOW, 60).toISOString())
  assert.equal(old.clear_pushed_at, undefined, 'closed without an all clear')
  assert.equal(current.closed_at, undefined)

  // An update within 12 hours of the last message joins; past that, it is a new emergency.
  const update = await tick(db, out, { alert: alertAt('demo-4', later(NOW, 60 + 11 * 60)), now: later(NOW, 60 + 11 * 60) })
  assert.deepEqual([update.role, update.pushed], ['update', []])
  const fresh = await tick(db, out, { alert: alertAt('demo-5', later(NOW, 60 + 24 * 60)), now: later(NOW, 60 + 24 * 60) })
  assert.deepEqual([fresh.role, fresh.pushed], ['new', ['campus-alert']])
  assert.equal(out.expo.length, 3)
})

test('with campus alerts switched off by PUSH_KINDS_OFF, incidents still open and close but nothing is pushed', async () => {
  const db = memoryDb(campus())
  const out = senders()
  const off = await tick(db, out, { alert: alertAt('demo-1', NOW), kindsOff: new Set(['campus-alert']) })
  assert.deepEqual([off.role, off.pushed], ['new', []])
  // Back on: an incident that was never pushed gets no all clear.
  const normal = await tick(db, out, { alert: normalAt('demo-2', later(NOW, 10)), now: later(NOW, 10) })
  assert.deepEqual([normal.role, normal.pushed], ['normal', []])

  await tick(db, out, { alert: alertAt('demo-3', later(NOW, 20)), now: later(NOW, 20) })
  const noClear = await tick(db, out, { alert: normalAt('demo-4', later(NOW, 30)), now: later(NOW, 30), kindsOff: new Set(['campus-all-clear']) })
  assert.deepEqual([noClear.role, noClear.pushed], ['normal', []])
  assert.equal(out.expo.length, 1)
})

test('before README step 53 every account gets campus alerts, and before step 54 every phone counts as an older build', async (t) => {
  t.mock.method(console, 'error', () => {})
  const db = memoryDb(campus(), { missingColumns: { push_settings: ['campus_alerts'], push_devices: ['kinds'] } })
  const out = senders()
  const summary = await tick(db, out, { alert: alertAt('demo-1', NOW) })
  assert.deepEqual(summary.pushed, ['campus-alert'])
  assert.deepEqual(tokens(out.expo.flat()), ['phone-admin', 'phone-deadlines', 'phone-listed', 'phone-off', 'phone-older'])
  assert.deepEqual(endpoints(out.web), ['browser-admin', 'browser-listed', 'browser-off'])
  assert.ok(out.expo.flat().every((m) => !m.channelId))
})

test("IU unreachable, a reading kept while it was, no message id, the tables missing, or push off: nothing is read or sent", async (t) => {
  const out = senders()
  const db = memoryDb(campus())
  const unreachable = await tick(db, out, { alert: null, readAlert: async () => { throw new Error('IU answered 503') } })
  assert.equal(unreachable.reason, 'feed_unavailable')
  const stale = await tick(db, out, { alert: alertAt('demo-1', NOW), fetchedAt: later(NOW, -3) })
  assert.equal(stale.reason, 'feed_stale')
  const noId = await tick(db, out, { alert: { ...alertAt('demo-1', NOW), id: null, sentAt: null } })
  assert.equal(noId.reason, 'no_message_id')
  const off = await tick(db, out, { alert: alertAt('demo-1', NOW), keys: null })
  assert.equal(off.reason, 'no_vapid_keys')
  assert.deepEqual(db.client.queries, [])

  const log = t.mock.method(console, 'error', () => {})
  const missing = memoryDb(campus(), { missingTables: ['campus_alert_messages', 'campus_alert_incidents'] })
  for (let i = 0; i < 2; i += 1) {
    const summary = await tick(missing, out, { alert: alertAt('demo-1', NOW) })
    assert.equal(summary.reason, 'not_configured')
  }
  assert.equal(log.mock.callCount(), 1)
  assert.match(String(log.mock.calls[0].arguments[0]), /db\/supabase-campus-alert-push\.sql/)
  assert.deepEqual([out.expo.length, out.web.length], [0, 0])
})

test('a batch Expo did not answer is sent once more; an answer about the phone is not', async () => {
  const requests = []
  const answers = [
    (messages) => messages.map((m, i) => (i === 0 ? { token: m.to, ok: false, error: 'timeout', gone: false, strike: false } : { token: m.to, ok: true, ticketId: 't1' })),
    (messages) => messages.map((m) => ({ token: m.to, ok: true, ticketId: 't2' })),
  ]
  const sleeps = []
  const send = retryFailedBatchOnce(
    async (options) => {
      requests.push(options)
      return answers[requests.length - 1](options.messages)
    },
    { sleep: async (ms) => sleeps.push(ms) },
  )
  const results = await send({ messages: [{ to: 'a' }, { to: 'b' }], accessToken: 'token' })
  assert.deepEqual(results.map((r) => [r.token, r.ok, r.ticketId]), [['a', true, 't2'], ['b', true, 't1']])
  assert.deepEqual(requests[1], { messages: [{ to: 'a' }], accessToken: 'token' })
  assert.deepEqual(sleeps, [EXPO_RETRY_DELAY_MS])

  for (const error of ['DeviceNotRegistered', 'http_401 UNAUTHORIZED', 'http_400']) {
    let calls = 0
    const once = retryFailedBatchOnce(
      async ({ messages }) => {
        calls += 1
        return messages.map((m) => ({ token: m.to, ok: false, error }))
      },
      { sleep: async () => {} },
    )
    await once({ messages: [{ to: 'a' }] })
    assert.equal(calls, 1, error)
  }
})
