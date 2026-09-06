import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LEAD_MINUTES,
  buildDeadlinePayload,
  buildTestPayload,
  describeDueIn,
  dueMomentOf,
  endOfDayInZone,
  formatDueTime,
  isMissingTableError,
  normalizeLeadMinutes,
  parseSettingsPatch,
  runDeadlineReminders,
  selectDueItems,
  settingsFromRow,
} from '../src/pushReminders.mjs'

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
