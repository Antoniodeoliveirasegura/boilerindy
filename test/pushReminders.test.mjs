import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LEAD_MINUTES,
  buildDeadlinePayload,
  buildTestPayload,
  deliverToPushDevices,
  describeDueIn,
  dueMomentOf,
  endOfDayInZone,
  formatDueTime,
  isMissingTableError,
  loadPushDevices,
  normalizeLeadMinutes,
  parseSettingsPatch,
  runDeadlineReminders,
  selectDueItems,
  settingsFromRow,
} from '../src/pushReminders.mjs'
import { runCronTick } from '../src/cronTick.mjs'

const NOW = new Date('2026-09-08T14:00:00Z') // Tuesday 10:00 EDT

test('normalizeLeadMinutes and parseSettingsPatch validate the settings surface', () => {
  assert.equal(normalizeLeadMinutes(60), 60)
  assert.equal(normalizeLeadMinutes('120'), 120)
  assert.equal(normalizeLeadMinutes(4), null)
  assert.equal(normalizeLeadMinutes(10081), null)
  assert.equal(normalizeLeadMinutes(1.5), null)
  assert.equal(normalizeLeadMinutes('abc'), null)

  assert.deepEqual(parseSettingsPatch({ deadlineReminders: false, leadMinutes: 30 }), {
    ok: true,
    patch: { deadline_reminders: false, lead_minutes: 30 },
  })
  assert.equal(parseSettingsPatch({ leadMinutes: 0 }).ok, false)
  assert.equal(parseSettingsPatch({ deadlineReminders: 'yes' }).ok, false)
  assert.equal(parseSettingsPatch({}).ok, false)
  assert.equal(parseSettingsPatch(null).ok, false)

  assert.deepEqual(settingsFromRow(null), { deadlineReminders: true, leadMinutes: DEFAULT_LEAD_MINUTES })
  assert.deepEqual(settingsFromRow({ deadline_reminders: false, lead_minutes: 15 }), { deadlineReminders: false, leadMinutes: 15 })
  assert.deepEqual(settingsFromRow({ deadline_reminders: true, lead_minutes: 99999 }), { deadlineReminders: true, leadMinutes: DEFAULT_LEAD_MINUTES })
})

test('date-only items are due at 23:59 campus time, with and without daylight saving', () => {
  assert.equal(endOfDayInZone('2026-09-08').toISOString(), '2026-09-09T03:59:00.000Z')
  assert.equal(endOfDayInZone('2026-12-08').toISOString(), '2026-12-09T04:59:00.000Z')
  // Stored at 00:00 UTC (Render) or at local midnight (a dev box in Indiana): same answer.
  assert.equal(dueMomentOf({ startTime: '2026-09-08T00:00:00.000Z', allDay: true }).toISOString(), '2026-09-09T03:59:00.000Z')
  assert.equal(dueMomentOf({ startTime: '2026-09-08T04:00:00.000Z', allDay: true }).toISOString(), '2026-09-09T03:59:00.000Z')
  assert.equal(dueMomentOf({ startTime: '2026-09-08T15:30:00.000Z', allDay: false }).toISOString(), '2026-09-08T15:30:00.000Z')
  assert.equal(dueMomentOf({ startTime: 'garbage' }), null)
  assert.equal(dueMomentOf(null), null)
})

test('selectDueItems applies the window, categories, completions and delivery log', () => {
  const calendarItems = [
    { id: 'a', title: 'HW 3', category: 'assignment', startTime: '2026-09-08T14:45:00Z' }, // in 45 min
    { id: 'b', title: 'Quiz 2', category: 'quiz', startTime: '2026-09-08T16:00:00Z' }, // in 2 h: outside a 60 min lead
    { id: 'c', title: 'Lecture', category: 'class', startTime: '2026-09-08T14:30:00Z' }, // not a deadline category
    { id: 'd', title: 'Done already', category: 'assignment', startTime: '2026-09-08T14:20:00Z' },
    { id: 'e', title: 'Already told', category: 'exam', startTime: '2026-09-08T14:10:00Z' },
    { id: 'f', title: 'Just passed', category: 'assignment', startTime: '2026-09-08T13:57:00Z' }, // 3 min ago: inside grace
    { id: 'g', title: 'Long gone', category: 'assignment', startTime: '2026-09-08T13:00:00Z' },
    { id: 'h', title: 'Paper', category: 'project', startTime: '2026-09-08T00:00:00Z', allDay: true }, // due 23:59 EDT today
  ]
  const manualTasks = [
    { id: 'm1', title: 'Email advisor', dueAt: '2026-09-08T14:30:00Z', completedAt: null },
    { id: 'm2', title: 'Finished', dueAt: '2026-09-08T14:30:00Z', completedAt: '2026-09-07T00:00:00Z' },
  ]
  const picked = selectDueItems({
    calendarItems,
    manualTasks,
    completedIds: new Set(['d']),
    deliveredKeys: new Set(['calendar:e']),
    now: NOW,
    leadMinutes: 60,
  })
  assert.deepEqual(picked.map((i) => i.key), ['calendar:f', 'manual:m1', 'calendar:a'])

  const wide = selectDueItems({ calendarItems, manualTasks, now: NOW, leadMinutes: 24 * 60 })
  assert.ok(wide.some((i) => i.key === 'calendar:h'), 'all-day project is due tonight')
  assert.equal(wide.find((i) => i.key === 'calendar:h').dueAt.toISOString(), '2026-09-09T03:59:00.000Z')
  assert.ok(wide.some((i) => i.key === 'calendar:b'))
})

test('reminder copy is short, campus-time, and category aware', () => {
  assert.equal(describeDueIn(new Date('2026-09-08T14:45:00Z'), NOW), 'due in 45 min')
  assert.equal(describeDueIn(new Date('2026-09-08T15:30:00Z'), NOW), 'due in 1 h 30 min')
  assert.equal(describeDueIn(new Date('2026-09-08T17:00:00Z'), NOW), 'due in 3 h')
  assert.equal(describeDueIn(new Date('2026-09-10T14:00:00Z'), NOW), 'due in 2 days')
  assert.equal(describeDueIn(new Date('2026-09-08T13:58:00Z'), NOW), 'due now')

  assert.equal(formatDueTime(new Date('2026-09-09T03:59:00Z'), { now: NOW }), 'at 11:59 PM')
  assert.equal(formatDueTime(new Date('2026-09-09T13:00:00Z'), { now: NOW }), 'tomorrow at 9:00 AM')
  assert.equal(formatDueTime(new Date('2026-09-11T13:00:00Z'), { now: NOW }), 'Fri at 9:00 AM')

  const payload = buildDeadlinePayload(
    { key: 'calendar:a', title: 'HW 3', category: 'assignment', dueAt: new Date('2026-09-08T14:45:00Z') },
    NOW,
  )
  assert.deepEqual(payload, {
    title: 'Assignment due in 45 min',
    body: 'HW 3 is due at 10:45 AM.',
    url: '/assignments',
    tag: 'deadline-calendar-a',
    kind: 'deadline',
  })
  assert.equal(buildDeadlinePayload({ key: 'manual:1', title: 'Call', category: 'manual_task', dueAt: new Date('2026-09-08T14:30:00Z') }, NOW).title, 'Task due in 30 min')
  assert.equal(buildTestPayload().kind, 'test')
  assert.equal(isMissingTableError({ code: 'PGRST205' }), true)
  assert.equal(isMissingTableError({ message: 'relation "push_settings" does not exist' }), true)
  assert.equal(isMissingTableError({ code: '23505', message: 'duplicate key' }), false)
})

// Minimal thenable query builder in the shape of supabase-js: every call is
// recorded, and `respond(op)` supplies the result when the builder is awaited.
function makeClient(respond) {
  const calls = []
  return {
    calls,
    from(table) {
      const op = { table, kind: 'select', filters: [], payload: null }
      calls.push(op)
      const builder = {}
      for (const kind of ['select', 'insert', 'delete', 'update', 'upsert']) {
        builder[kind] = (arg) => {
          op.kind = kind
          op.payload = arg
          return builder
        }
      }
      for (const f of ['eq', 'in', 'gte', 'lte', 'is', 'limit']) {
        builder[f] = (...args) => {
          op.filters.push([f, ...args])
          return builder
        }
      }
      builder.then = (resolve, reject) => Promise.resolve().then(() => respond(op)).then(resolve, reject)
      return builder
    },
  }
}

test('runDeadlineReminders claims, sends, and prunes gone subscriptions', async () => {
  const sent = []
  const client = makeClient((op) => {
    if (op.table === 'push_settings') return { data: [{ user_id: 'u1', lead_minutes: 60 }, { user_id: 'u2', lead_minutes: 60 }], error: null }
    if (op.table === 'push_subscriptions' && op.kind === 'select') {
      return {
        data: [
          { id: 's1', user_id: 'u1', endpoint: 'https://push.example/1', p256dh: 'k1', auth: 'a1' },
          { id: 's2', user_id: 'u1', endpoint: 'https://push.example/2', p256dh: 'k2', auth: 'a2' },
        ],
        error: null,
      }
    }
    if (op.table === 'push_subscriptions' && op.kind === 'delete') return { data: null, error: null }
    if (op.table === 'calendar_items') {
      return {
        data: [
          { id: 'a', title: 'HW 3', start_time: '2026-09-08T14:45:00Z', category: 'assignment', all_day: false },
          { id: 'e', title: 'Told', start_time: '2026-09-08T14:10:00Z', category: 'exam', all_day: false },
        ],
        error: null,
      }
    }
    if (op.table === 'user_manual_tasks') return { data: [], error: null }
    if (op.table === 'user_task_completions') return { data: [], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'select') return { data: [{ item_key: 'calendar:e' }], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'insert') return { data: null, error: null }
    if (op.table === 'push_devices' && op.kind === 'select') return { data: [], error: null }
    throw new Error(`unexpected query ${op.table} ${op.kind}`)
  })
  const send = async ({ subscription, payload, topic }) => {
    sent.push({ endpoint: subscription.endpoint, title: payload.title, topic })
    return subscription.endpoint.endsWith('/2')
      ? { ok: false, status: 410, gone: true, retry: false, error: 'gone' }
      : { ok: true, status: 201, gone: false, retry: false }
  }
  const summary = await runDeadlineReminders({ client, keys: { publicKey: 'x' }, now: NOW, send, log: { warn() {} } })
  assert.deepEqual(summary, { ok: true, ranAt: NOW.toISOString(), users: 1, checked: 1, sent: 1, failed: 1, removed: 1, skipped: 1 })
  assert.deepEqual(sent, [
    { endpoint: 'https://push.example/1', title: 'Assignment due in 45 min', topic: 'deadline-calendar-a' },
    { endpoint: 'https://push.example/2', title: 'Assignment due in 45 min', topic: 'deadline-calendar-a' },
  ])
  const claim = client.calls.find((c) => c.table === 'push_deliveries' && c.kind === 'insert')
  assert.deepEqual(claim.payload, { user_id: 'u1', item_key: 'calendar:a', kind: 'deadline', sent_at: NOW.toISOString() })
  const removal = client.calls.find((c) => c.table === 'push_subscriptions' && c.kind === 'delete')
  assert.deepEqual(removal.filters, [['eq', 'id', 's2']])
  const calendarQuery = client.calls.find((c) => c.table === 'calendar_items')
  assert.deepEqual(calendarQuery.filters[1], ['in', 'category', ['assignment', 'quiz', 'exam', 'project', 'deadline']])
})

test('runDeadlineReminders reports missing tables, missing keys, and duplicate claims', async () => {
  const missing = makeClient(() => ({ data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }))
  const a = await runDeadlineReminders({ client: missing, keys: { publicKey: 'x' }, now: NOW })
  assert.equal(a.ok, false)
  assert.equal(a.reason, 'not_configured')

  const b = await runDeadlineReminders({ client: missing, keys: null, now: NOW })
  assert.equal(b.reason, 'no_vapid_keys')

  let sends = 0
  const dup = makeClient((op) => {
    if (op.table === 'push_settings') return { data: [{ user_id: 'u1', lead_minutes: 60 }], error: null }
    if (op.table === 'push_subscriptions') return { data: [{ id: 's1', user_id: 'u1', endpoint: 'https://p/1', p256dh: 'k', auth: 'a' }], error: null }
    if (op.table === 'calendar_items') return { data: [{ id: 'a', title: 'HW', start_time: '2026-09-08T14:30:00Z', category: 'assignment' }], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'insert') return { data: null, error: { code: '23505', message: 'duplicate' } }
    return { data: [], error: null }
  })
  const c = await runDeadlineReminders({ client: dup, keys: { publicKey: 'x' }, now: NOW, send: async () => { sends += 1; return { ok: true } } })
  assert.equal(sends, 0)
  assert.equal(c.skipped, 1)
  assert.equal(c.checked, 1)
})

test('a transient 504 on the settings query is retried once through runCronTick, and the retry sends', async () => {
  let settingsCalls = 0
  const sends = []
  const client = makeClient((op) => {
    if (op.table === 'push_settings') {
      settingsCalls += 1
      // What supabase-js hands back for a gateway timeout: a non-JSON body as the message, status kept on the result.
      if (settingsCalls === 1) return { data: null, error: { code: 'PGRST003', message: 'Gateway Timeout' }, status: 504 }
      return { data: [{ user_id: 'u1', lead_minutes: 60 }], error: null, status: 200 }
    }
    if (op.table === 'push_subscriptions') return { data: [{ id: 's1', user_id: 'u1', endpoint: 'https://p/1', p256dh: 'k', auth: 'a' }], error: null }
    if (op.table === 'calendar_items') return { data: [{ id: 'a', title: 'HW', start_time: '2026-09-08T14:30:00Z', category: 'assignment' }], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'insert') return { data: null, error: null }
    return { data: [], error: null }
  })
  const send = async ({ payload }) => {
    sends.push(payload.title)
    return { ok: true }
  }
  const run = () => runDeadlineReminders({ client, keys: { publicKey: 'x' }, now: NOW, send })

  // On its own the runner rejects with the status and code kept, so the route can tell a hiccup from a bug.
  await assert.rejects(
    run,
    (err) => err.name === 'SupabaseQueryError' && err.status === 504 && err.code === 'PGRST003' && err.message === 'push_settings select: Gateway Timeout (HTTP 504)',
  )
  assert.equal(settingsCalls, 1)
  assert.deepEqual(sends, [])

  // Through runCronTick the second attempt re-runs the whole tick and sends.
  settingsCalls = 0
  const outcome = await runCronTick('run-reminders', run, { log: { log() {} }, sleep: async () => {} })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.retried, true)
  assert.equal(settingsCalls, 2)
  assert.deepEqual(sends, ['Assignment due in 30 min'])
  assert.equal(outcome.summary.sent, 1)
})

// ── Native devices (issue #194) ─────────────────────────────────────────────

const PHONE = 'ExponentPushToken[phone000000000000000001]'
const HW_DUE = { id: 'a', title: 'HW 3', start_time: '2026-09-08T14:45:00Z', category: 'assignment', all_day: false }

// One student with reminders on, one HW due in 45 minutes, nothing delivered
// yet; `subs` and `devices` are what the push tables hold for them.
function reminderClient({ subs = [], devices = [], devicesError = null } = {}) {
  return makeClient((op) => {
    if (op.table === 'push_settings') return { data: [{ user_id: 'u1', lead_minutes: 60 }], error: null }
    if (op.table === 'push_subscriptions' && op.kind === 'select') return { data: subs, error: null }
    if (op.table === 'push_devices' && op.kind === 'select') return devicesError ? { data: null, error: devicesError } : { data: devices, error: null }
    if (op.table === 'push_devices') return { data: null, error: null }
    if (op.table === 'calendar_items') return { data: [HW_DUE], error: null }
    if (op.table === 'user_manual_tasks') return { data: [], error: null }
    if (op.table === 'user_task_completions') return { data: [], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'select') return { data: [], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'insert') return { data: null, error: null }
    throw new Error(`unexpected query ${op.table} ${op.kind}`)
  })
}

const ok = (messages) => messages.map((m) => ({ token: m.to, ok: true, ticketId: `t-${m.to}` }))

test('a student with one browser and one phone gets the reminder on both, claimed once', async () => {
  const client = reminderClient({
    subs: [{ id: 's1', user_id: 'u1', endpoint: 'https://push.example/1', p256dh: 'k1', auth: 'a1' }],
    devices: [{ id: 'd1', user_id: 'u1', token: PHONE, failure_count: 0 }],
  })
  const webSends = []
  const expoSends = []
  const summary = await runDeadlineReminders({
    client,
    keys: { publicKey: 'x' },
    now: NOW,
    send: async ({ subscription, payload }) => {
      webSends.push({ endpoint: subscription.endpoint, title: payload.title })
      return { ok: true, status: 201 }
    },
    sendExpo: async ({ messages }) => {
      expoSends.push(messages)
      return ok(messages)
    },
    log: { warn() {} },
  })

  assert.deepEqual(webSends, [{ endpoint: 'https://push.example/1', title: 'Assignment due in 45 min' }])
  assert.equal(expoSends.length, 1, 'one Expo request for the item')
  assert.deepEqual(
    expoSends[0].map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data })),
    [{ to: PHONE, title: 'Assignment due in 45 min', body: 'HW 3 is due at 10:45 AM.', data: { url: '/assignments', kind: 'deadline', tag: 'deadline-calendar-a' } }],
  )
  const claims = client.calls.filter((c) => c.table === 'push_deliveries' && c.kind === 'insert')
  assert.equal(claims.length, 1, 'the delivery row is written once for both devices')
  assert.deepEqual(claims[0].payload, { user_id: 'u1', item_key: 'calendar:a', kind: 'deadline', sent_at: NOW.toISOString() })
  assert.deepEqual(summary, { ok: true, ranAt: NOW.toISOString(), users: 1, checked: 1, sent: 2, failed: 0, removed: 0, skipped: 0 })
  const deviceQuery = client.calls.find((c) => c.table === 'push_devices' && c.kind === 'select')
  assert.deepEqual(deviceQuery.filters, [['in', 'user_id', ['u1']]])
  assert.equal(client.calls.filter((c) => c.table === 'push_devices' && c.kind !== 'select').length, 0, 'a clean success writes nothing back')
})

test('a student with only a phone is not skipped', async () => {
  const client = reminderClient({ devices: [{ id: 'd1', user_id: 'u1', token: PHONE, failure_count: 0 }] })
  let webCalls = 0
  const summary = await runDeadlineReminders({
    client,
    keys: { publicKey: 'x' },
    now: NOW,
    send: async () => {
      webCalls += 1
      return { ok: true }
    },
    sendExpo: async ({ messages }) => ok(messages),
  })
  assert.equal(webCalls, 0)
  assert.equal(summary.users, 1)
  assert.equal(summary.skipped, 0)
  assert.equal(summary.sent, 1)
})

test('before db/supabase-push-devices.sql runs, Web Push reminders carry on', async () => {
  const client = reminderClient({
    subs: [{ id: 's1', user_id: 'u1', endpoint: 'https://push.example/1', p256dh: 'k1', auth: 'a1' }],
    devicesError: { code: 'PGRST205', message: "Could not find the table 'public.push_devices' in the schema cache" },
  })
  let expoCalls = 0
  const summary = await runDeadlineReminders({
    client,
    keys: { publicKey: 'x' },
    now: NOW,
    send: async () => ({ ok: true, status: 201 }),
    sendExpo: async () => {
      expoCalls += 1
      return []
    },
  })
  assert.equal(summary.ok, true)
  assert.equal(summary.sent, 1)
  assert.equal(expoCalls, 0)
})

test('any other push_devices error stops the run with the status kept, for the cron retry', async () => {
  const client = reminderClient({ devicesError: { code: 'PGRST003', message: 'Gateway Timeout' } })
  await assert.rejects(
    () => runDeadlineReminders({ client, keys: { publicKey: 'x' }, now: NOW, sendExpo: async () => [] }),
    (err) => err.name === 'SupabaseQueryError' && err.code === 'PGRST003' && /^push_devices select: Gateway Timeout/.test(err.message),
  )
})

test('Expo answers keep the books: gone is deleted, a strike counts, a success clears, five strikes are dropped', async () => {
  const devices = [
    { id: 'd-gone', user_id: 'u1', token: 'ExponentPushToken[gone]', failure_count: 0 },
    { id: 'd-flaky', user_id: 'u1', token: 'ExponentPushToken[flaky]', failure_count: 2 },
    { id: 'd-back', user_id: 'u1', token: 'ExponentPushToken[back]', failure_count: 3 },
    { id: 'd-creds', user_id: 'u1', token: 'ExponentPushToken[creds]', failure_count: 1 },
    { id: 'd-out', user_id: 'u1', token: 'ExponentPushToken[out]', failure_count: 5 },
  ]
  const client = reminderClient({ devices })
  const sentTo = []
  const warnings = []
  const summary = await runDeadlineReminders({
    client,
    keys: { publicKey: 'x' },
    now: NOW,
    sendExpo: async ({ messages }) => {
      sentTo.push(...messages.map((m) => m.to))
      return messages.map((m) => {
        if (m.to.includes('gone')) return { token: m.to, ok: false, error: 'DeviceNotRegistered', gone: true, strike: false }
        if (m.to.includes('flaky')) return { token: m.to, ok: false, error: 'MessageRateExceeded', gone: false, strike: true }
        if (m.to.includes('creds')) return { token: m.to, ok: false, error: 'InvalidCredentials', gone: false, strike: false }
        return { token: m.to, ok: true, ticketId: 't' }
      })
    },
    log: { warn: (line) => warnings.push(line) },
  })

  assert.ok(!sentTo.includes('ExponentPushToken[out]'), 'a phone with five strikes is not sent to')
  assert.deepEqual(sentTo, ['ExponentPushToken[gone]', 'ExponentPushToken[flaky]', 'ExponentPushToken[back]', 'ExponentPushToken[creds]'])
  const writes = client.calls.filter((c) => c.table === 'push_devices' && c.kind !== 'select').map((c) => [c.kind, c.payload ?? null, c.filters])
  assert.deepEqual(writes, [
    ['delete', null, [['in', 'id', ['d-out']]]],
    ['delete', null, [['eq', 'id', 'd-gone']]],
    ['update', { failure_count: 3 }, [['eq', 'id', 'd-flaky']]],
    ['update', { failure_count: 0 }, [['eq', 'id', 'd-back']]],
  ])
  assert.deepEqual({ sent: summary.sent, failed: summary.failed, removed: summary.removed }, { sent: 1, failed: 3, removed: 2 })
  assert.deepEqual(warnings, ['[push] native delivery failed (MessageRateExceeded)', '[push] native delivery failed (InvalidCredentials)'])
  assert.ok(warnings.every((line) => !line.includes('PushToken')), 'tokens never reach the log')
})

test('loadPushDevices drops struck-out phones and reads a missing table as none', async () => {
  const rows = [
    { id: 'd1', user_id: 'u1', token: 'ExponentPushToken[a]', failure_count: 4 },
    { id: 'd2', user_id: 'u1', token: 'ExponentPushToken[b]', failure_count: 5 },
    { id: 'd3', user_id: 'u2', token: 'ExponentPushToken[c]', failure_count: 9 },
  ]
  const client = makeClient((op) => (op.kind === 'select' ? { data: rows, error: null } : { data: null, error: null }))
  const loaded = await loadPushDevices(client, ['u1', 'u2'])
  assert.deepEqual(loaded.devices.map((d) => d.id), ['d1'])
  assert.equal(loaded.removed, 2)
  assert.deepEqual(client.calls[1].filters, [['in', 'id', ['d2', 'd3']]])

  const failedDelete = makeClient((op) => (op.kind === 'select' ? { data: rows, error: null } : { data: null, error: { message: 'boom' } }))
  const warnings = []
  const kept = await loadPushDevices(failedDelete, ['u1'], { log: { warn: (line) => warnings.push(line) } })
  assert.deepEqual(kept.devices.map((d) => d.id), ['d1'], 'still not sent to')
  assert.equal(kept.removed, 0)
  assert.equal(warnings.length, 1)

  const none = await loadPushDevices(makeClient(() => { throw new Error('no query for an empty list') }), [])
  assert.deepEqual(none, { devices: [], removed: 0 })
  const missing = await loadPushDevices(makeClient(() => ({ data: null, error: { code: '42P01', message: 'relation "push_devices" does not exist' } })), ['u1'])
  assert.deepEqual(missing, { devices: [], removed: 0 })
})

test('deliverToPushDevices hands back the phones for the next item, with the strike counted', async () => {
  const client = makeClient(() => ({ data: null, error: null }))
  const devices = [
    { id: 'd1', user_id: 'u1', token: 'ExponentPushToken[a]', failure_count: 4 },
    { id: 'd2', user_id: 'u1', token: 'ExponentPushToken[b]', failure_count: 0 },
  ]
  const strike = async ({ messages }) => messages.map((m) => ({ token: m.to, ok: false, error: 'UnknownError', gone: false, strike: true }))
  const first = await deliverToPushDevices({ client, devices, payload: buildTestPayload(), send: strike, log: { warn() {} } })
  assert.deepEqual(first.devices.map((d) => [d.id, d.failure_count]), [['d1', 5], ['d2', 1]])
  assert.deepEqual({ sent: first.sent, failed: first.failed, removed: first.removed }, { sent: 0, failed: 2, removed: 0 })

  // d1 reached five strikes: skipped from now on, and deleted by the next run's loadPushDevices.
  const asked = []
  const second = await deliverToPushDevices({
    client,
    devices: first.devices,
    payload: buildTestPayload(),
    send: async ({ messages }) => {
      asked.push(...messages.map((m) => m.to))
      return ok(messages)
    },
  })
  assert.deepEqual(asked, ['ExponentPushToken[b]'])
  assert.equal(second.sent, 1)

  const nothing = await deliverToPushDevices({ client, devices: [], payload: buildTestPayload(), send: async () => { throw new Error('not called') } })
  assert.deepEqual(nothing, { sent: 0, failed: 0, removed: 0, devices: [] })
})
