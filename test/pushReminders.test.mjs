import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LEAD_MINUTES,
  buildDeadlinePayload,
  buildTestPayload,
  deadlineItemUrl,
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
  settingsConflict,
  settingsFromRow,
} from '../src/pushReminders.mjs'
import { runCronTick } from '../src/cronTick.mjs'
import { CAPPED_KINDS } from '../src/pushPolicy.mjs'

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
    kinds: false,
  })
  assert.equal(parseSettingsPatch({ leadMinutes: 0 }).ok, false)
  assert.equal(parseSettingsPatch({ deadlineReminders: 'yes' }).ok, false)
  assert.equal(parseSettingsPatch({}).ok, false)
  assert.equal(parseSettingsPatch(null).ok, false)

  const pick = (settings) => ({ deadlineReminders: settings.deadlineReminders, leadMinutes: settings.leadMinutes, diningFavoriteAlerts: settings.diningFavoriteAlerts })
  assert.deepEqual(pick(settingsFromRow(null)), { deadlineReminders: true, leadMinutes: DEFAULT_LEAD_MINUTES, diningFavoriteAlerts: false })
  assert.deepEqual(pick(settingsFromRow({ deadline_reminders: false, lead_minutes: 15 })), { deadlineReminders: false, leadMinutes: 15, diningFavoriteAlerts: false })
  assert.deepEqual(pick(settingsFromRow({ deadline_reminders: true, lead_minutes: 99999 })), { deadlineReminders: true, leadMinutes: DEFAULT_LEAD_MINUTES, diningFavoriteAlerts: false })

  // The favorite-dish alerts switch (issue #469): off unless the row says true.
  assert.equal(settingsFromRow({ deadline_reminders: true, lead_minutes: 60, dining_favorite_alerts: true }).diningFavoriteAlerts, true)
  assert.deepEqual(parseSettingsPatch({ diningFavoriteAlerts: true }), { ok: true, patch: { dining_favorite_alerts: true }, kinds: false })
  assert.equal(parseSettingsPatch({ diningFavoriteAlerts: 'on' }).ok, false)
})

// Issue #550, README step 53: the choices by kind on the account.
test('settingsFromRow reads the choices by kind, and before step 53 gives what the step gives an existing row', () => {
  assert.deepEqual(settingsFromRow(null), {
    deadlineReminders: true,
    leadMinutes: 60,
    diningFavoriteAlerts: false,
    classReminders: false,
    classLeadMinutes: 15,
    digestMinute: 18 * 60,
    deadlineItems: false,
    quietStart: 23 * 60,
    quietEnd: 8 * 60,
    campusAlerts: true,
    kindsMigrated: false,
  })
  // A row from before step 53 keeps its per-item reminders, and gains the list and quiet hours.
  const before = settingsFromRow({ deadline_reminders: true, lead_minutes: 120 })
  assert.deepEqual([before.deadlineItems, before.digestMinute, before.quietStart, before.quietEnd], [true, 1080, 1380, 480])
  assert.equal(settingsFromRow({ deadline_reminders: false, lead_minutes: 60 }).deadlineItems, false)
  // After it, the columns say.
  const after = settingsFromRow({
    deadline_reminders: true,
    lead_minutes: 30,
    class_reminders: true,
    class_lead_minutes: 10,
    digest_minute: null,
    deadline_items: false,
    quiet_start: null,
    quiet_end: null,
    campus_alerts: false,
    kinds_migrated_at: '2026-11-02T12:00:00.000Z',
  })
  assert.deepEqual(after, {
    deadlineReminders: true,
    leadMinutes: 30,
    diningFavoriteAlerts: false,
    classReminders: true,
    classLeadMinutes: 10,
    digestMinute: null,
    deadlineItems: false,
    quietStart: null,
    quietEnd: null,
    campusAlerts: false,
    kindsMigrated: true,
  })
  // Out-of-range values fall back rather than reach a client.
  const odd = settingsFromRow({ deadline_reminders: true, lead_minutes: 60, class_lead_minutes: 7, digest_minute: 5000, quiet_start: 600, quiet_end: 600 })
  assert.deepEqual([odd.classLeadMinutes, odd.digestMinute, odd.quietStart, odd.quietEnd], [15, null, null, null])
})

test('parseSettingsPatch takes the choices by kind, quiet hours as a pair', () => {
  assert.deepEqual(
    parseSettingsPatch({ classReminders: true, classLeadMinutes: 30, digestMinute: 1140, deadlineItems: true, quietStart: 1320, quietEnd: 420, campusAlerts: false }),
    {
      ok: true,
      patch: { class_reminders: true, class_lead_minutes: 30, digest_minute: 1140, deadline_items: true, quiet_start: 1320, quiet_end: 420, campus_alerts: false },
      kinds: true,
    },
  )
  assert.deepEqual(parseSettingsPatch({ digestMinute: null, quietStart: null, quietEnd: null }).patch, { digest_minute: null, quiet_start: null, quiet_end: null })
  assert.deepEqual(parseSettingsPatch({ kindsMigrated: true }), { ok: true, patch: { kinds_migrated_at: true }, kinds: true })
  for (const [body, error] of [
    [{ classLeadMinutes: 20 }, /classLeadMinutes must be one of 5, 10, 15, 30/],
    [{ digestMinute: 1440 }, /digestMinute/],
    [{ digestMinute: 18.5 }, /digestMinute/],
    [{ quietStart: 1380 }, /change together/],
    [{ quietStart: 1380, quietEnd: null }, /both be null/],
    [{ quietStart: 600, quietEnd: 600 }, /differ/],
    [{ classReminders: 'yes' }, /classReminders must be true or false/],
    [{ kindsMigrated: false }, /can only be set to true/],
  ]) {
    const parsed = parseSettingsPatch(body)
    assert.equal(parsed.ok, false, JSON.stringify(body))
    assert.match(parsed.error, error)
  }
})

test('settingsConflict refuses an evening list inside quiet hours', () => {
  const base = settingsFromRow(null)
  assert.equal(settingsConflict(base), null)
  assert.match(settingsConflict({ ...base, digestMinute: 23 * 60 + 30 }), /cannot go out during quiet hours/)
  assert.match(settingsConflict({ ...base, digestMinute: 7 * 60 }), /cannot go out during quiet hours/)
  // The end of quiet hours is outside them; with quiet hours or the list off there is nothing to refuse.
  assert.equal(settingsConflict({ ...base, digestMinute: 8 * 60 }), null)
  assert.equal(settingsConflict({ ...base, quietStart: null, quietEnd: null, digestMinute: 23 * 60 + 30 }), null)
  assert.equal(settingsConflict({ ...base, digestMinute: null }), null)
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
    { key: 'calendar:a', id: 'a', kind: 'calendar', title: 'HW 3', category: 'assignment', dueAt: new Date('2026-09-08T14:45:00Z') },
    NOW,
  )
  assert.deepEqual(payload, {
    title: 'Assignment due in 45 min',
    body: 'HW 3 is due at 10:45 AM.',
    // Issue #550: the reminder opens the task itself, and names it for the app.
    url: '/assignments?taskId=a&taskKind=calendar',
    tag: 'deadline-calendar-a',
    kind: 'deadline',
    itemId: 'a',
    itemKind: 'calendar',
    // A phone keeps an undelivered reminder until the item is due.
    expiresAt: '2026-09-08T14:45:00.000Z',
  })
  const task = buildDeadlinePayload({ key: 'manual:7f3c', id: '7f3c', kind: 'manual', title: 'Call', category: 'manual_task', dueAt: new Date('2026-09-08T14:30:00Z') }, NOW)
  assert.equal(task.title, 'Task due in 30 min')
  assert.equal(task.url, '/assignments?taskId=7f3c&taskKind=manual')
  assert.deepEqual([task.itemId, task.itemKind], ['7f3c', 'manual'])
  assert.equal(deadlineItemUrl({ id: 'a b&c', kind: 'calendar' }), '/assignments?taskId=a+b%26c&taskKind=calendar', 'the id is escaped')
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
  assert.deepEqual(summary, { ok: true, ranAt: NOW.toISOString(), users: 1, checked: 1, sent: 1, failed: 1, removed: 1, skipped: 1, digests: 0, held: 0, capped: 0 })
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

// Issue #550, item 2: the test push says what the device gets. A phone whose
// app schedules the reminders itself gets only the dish alerts from here.
test('the test push is worded for the device it reaches', () => {
  const browser = buildTestPayload()
  assert.deepEqual(browser, {
    title: 'BoilerIndy notifications are on',
    body: 'You will get deadline reminders on this device.',
    url: '/settings',
    tag: 'test',
    kind: 'test',
  })
  assert.deepEqual(buildTestPayload({ localReminders: false, platform: 'ios' }), browser)
  assert.deepEqual(buildTestPayload({ localReminders: true, platform: 'ios' }), {
    title: 'Notifications are on for this iPhone',
    body: 'Favorite dish alerts come here. Class and task reminders come from the phone itself.',
    url: '/settings',
    tag: 'test',
    kind: 'test',
  })
  assert.equal(buildTestPayload({ localReminders: true, platform: 'android' }).title, 'Notifications are on for this phone')
  assert.equal(buildTestPayload({ localReminders: true }).title, 'Notifications are on for this iPhone', 'releases are iOS only')
})

// Issue #550: PUSH_KINDS_OFF with both deadline kinds stops the run before it
// reads or claims anything, so an item still in its window gets its reminder
// once they are back on.
test('with both deadline kinds switched off the run reads nothing and claims nothing', async () => {
  const quiet = makeClient(() => {
    throw new Error('no query expected')
  })
  const off = await runDeadlineReminders({ client: quiet, keys: { publicKey: 'x' }, now: NOW, kindsOff: new Set(['deadline', 'deadline-digest']) })
  assert.deepEqual(off, {
    ok: false,
    reason: 'kind_off',
    ranAt: NOW.toISOString(),
    users: 0,
    checked: 0,
    sent: 0,
    failed: 0,
    removed: 0,
    skipped: 0,
    digests: 0,
    held: 0,
    capped: 0,
  })
  assert.equal(quiet.calls.length, 0)

  // One of them, or another kind, switched off: the run goes on to read the settings.
  const missing = makeClient(() => ({ data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }))
  for (const kindsOff of [new Set(['deadline']), new Set(['deadline-digest']), new Set(['dining-favorites', 'test'])]) {
    const other = await runDeadlineReminders({ client: missing, keys: { publicKey: 'x' }, now: NOW, kindsOff })
    assert.equal(other.reason, 'not_configured', [...kindsOff].join())
  }
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
// `flagColumnMissing` answers a select that names local_reminders the way
// Postgres does before README step 47 adds it.
const FLAG_COLUMN_MISSING = { code: '42703', message: 'column push_devices.local_reminders does not exist' }
function reminderClient({ subs = [], devices = [], devicesError = null, flagColumnMissing = false } = {}) {
  return makeClient((op) => {
    if (op.table === 'push_settings') return { data: [{ user_id: 'u1', lead_minutes: 60 }], error: null }
    if (op.table === 'push_subscriptions' && op.kind === 'select') return { data: subs, error: null }
    if (op.table === 'push_devices' && op.kind === 'select' && flagColumnMissing && String(op.payload).includes('local_reminders')) {
      return { data: null, error: FLAG_COLUMN_MISSING }
    }
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
    [
      {
        to: PHONE,
        title: 'Assignment due in 45 min',
        body: 'HW 3 is due at 10:45 AM.',
        // Issue #550, item 5: the tap opens HW 3, and Mark done can name it.
        data: { url: '/assignments?taskId=a&taskKind=calendar', kind: 'deadline', tag: 'deadline-calendar-a', itemId: 'a', itemKind: 'calendar' },
      },
    ],
  )
  // Issue #550: the deadline kind's fields, and a lifetime that ends when HW 3 is due.
  const [message] = expoSends[0]
  assert.deepEqual(
    [message.interruptionLevel, message.threadId, message.categoryId, message.sound, message.priority, message.ttl],
    ['active', 'deadline', 'deadline', 'default', 'high', 45 * 60],
  )
  const claims = client.calls.filter((c) => c.table === 'push_deliveries' && c.kind === 'insert')
  assert.equal(claims.length, 1, 'the delivery row is written once for both devices')
  assert.deepEqual(claims[0].payload, { user_id: 'u1', item_key: 'calendar:a', kind: 'deadline', sent_at: NOW.toISOString() })
  assert.deepEqual(summary, { ok: true, ranAt: NOW.toISOString(), users: 1, checked: 1, sent: 2, failed: 0, removed: 0, skipped: 0, digests: 0, held: 0, capped: 0 })
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

// ── Phones with local reminders (Antoniodeoliveirasegura/boilerindy-app#55) ─

const BROWSER = { id: 's1', user_id: 'u1', endpoint: 'https://push.example/1', p256dh: 'k1', auth: 'a1' }

test('a phone with local reminders gets no deadline reminder, while the browser and the other phone do', async () => {
  const client = reminderClient({
    subs: [BROWSER],
    devices: [
      { id: 'd-local', user_id: 'u1', token: 'ExponentPushToken[local]', failure_count: 0, local_reminders: true },
      { id: 'd-remote', user_id: 'u1', token: 'ExponentPushToken[remote]', failure_count: 0, local_reminders: false },
    ],
  })
  const webSends = []
  const expoSends = []
  const summary = await runDeadlineReminders({
    client,
    keys: { publicKey: 'x' },
    now: NOW,
    send: async ({ subscription }) => {
      webSends.push(subscription.endpoint)
      return { ok: true, status: 201 }
    },
    sendExpo: async ({ messages }) => {
      expoSends.push(messages.map((m) => m.to))
      return ok(messages)
    },
    log: { warn() {} },
  })
  assert.deepEqual(webSends, ['https://push.example/1'])
  assert.deepEqual(expoSends, [['ExponentPushToken[remote]']], 'only the phone without local reminders')
  assert.equal(client.calls.filter((c) => c.table === 'push_deliveries' && c.kind === 'insert').length, 1, 'claimed once, as before')
  assert.deepEqual(summary, { ok: true, ranAt: NOW.toISOString(), users: 1, checked: 1, sent: 2, failed: 0, removed: 0, skipped: 0, digests: 0, held: 0, capped: 0 })
  const deviceQuery = client.calls.find((c) => c.table === 'push_devices' && c.kind === 'select')
  assert.equal(deviceQuery.payload, 'id, user_id, token, platform, failure_count, local_reminders')
})

test('a student whose only phone has local reminders is skipped, and nothing is claimed', async () => {
  const client = reminderClient({ devices: [{ id: 'd-local', user_id: 'u1', token: PHONE, failure_count: 0, local_reminders: true }] })
  let sends = 0
  const summary = await runDeadlineReminders({
    client,
    keys: { publicKey: 'x' },
    now: NOW,
    send: async () => {
      sends += 1
      return { ok: true }
    },
    sendExpo: async ({ messages }) => {
      sends += messages.length
      return ok(messages)
    },
  })
  assert.equal(sends, 0)
  assert.deepEqual(summary, { ok: true, ranAt: NOW.toISOString(), users: 0, checked: 0, sent: 0, failed: 0, removed: 0, skipped: 1, digests: 0, held: 0, capped: 0 })
  assert.equal(
    client.calls.filter((c) => c.table === 'push_deliveries').length,
    0,
    'unclaimed, so the item still gets its reminder if local reminders are turned off while it is due',
  )
})

test('before README step 47 runs, every phone gets its deadline reminder, and the log names the file once', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const run = async () => {
    const client = reminderClient({ subs: [BROWSER], devices: [{ id: 'd1', user_id: 'u1', token: PHONE, failure_count: 0 }], flagColumnMissing: true })
    const expoSends = []
    const summary = await runDeadlineReminders({
      client,
      keys: { publicKey: 'x' },
      now: NOW,
      send: async () => ({ ok: true, status: 201 }),
      sendExpo: async ({ messages }) => {
        expoSends.push(...messages.map((m) => m.to))
        return ok(messages)
      },
    })
    return { client, expoSends, summary }
  }
  const first = await run()
  assert.deepEqual(first.expoSends, [PHONE], 'the phone is not read as gone')
  assert.equal(first.summary.sent, 2)
  const selects = first.client.calls.filter((c) => c.table === 'push_devices' && c.kind === 'select').map((c) => c.payload)
  assert.deepEqual(selects, ['id, user_id, token, platform, failure_count, local_reminders', 'id, user_id, token, platform, failure_count'])
  const second = await run()
  assert.deepEqual(second.expoSends, [PHONE])
  assert.equal(log.mock.callCount(), 1, 'the next tick does not log it again')
  assert.match(String(log.mock.calls[0].arguments[0]), /^\[push_local_reminders\] schema missing: run db\/supabase-push-local-reminders\.sql/)
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

// ── Issue #550, README step 53: the evening list, quiet hours, the merge, the cap

// One student with a browser: their settings row (at the step's defaults
// unless overridden), their open calendar items, the ledger's claims today,
// and the claims this run makes. `before53` answers the settings read the way
// Postgres does before the step's columns exist.
function kindsClient({ settings = {}, items = [], cappedToday = 0, conflicts = [], before53 = false } = {}) {
  const claims = []
  const client = makeClient((op) => {
    if (op.table === 'push_settings') {
      if (before53 && String(op.payload).includes('deadline_items')) {
        return { data: null, error: { code: '42703', message: 'column push_settings.deadline_items does not exist (step 53 test)' } }
      }
      const kinds = before53 ? {} : { deadline_items: false, digest_minute: 1080, quiet_start: 1380, quiet_end: 480, ...settings }
      return { data: [{ user_id: 'u1', lead_minutes: 60, ...kinds }], error: null }
    }
    if (op.table === 'push_subscriptions') return { data: [{ id: 's1', user_id: 'u1', endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' }], error: null }
    if (op.table === 'push_devices') return { data: [], error: null }
    if (op.table === 'calendar_items') return { data: items, error: null }
    if (op.table === 'user_manual_tasks' || op.table === 'user_task_completions') return { data: [], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'select') {
      const capQuery = op.filters.some(([f, column]) => f === 'in' && column === 'kind')
      return { data: capQuery ? Array.from({ length: cappedToday }, () => ({ kind: 'deadline' })) : [], error: null }
    }
    if (op.table === 'push_deliveries' && op.kind === 'insert') {
      claims.push(op.payload)
      return conflicts.includes(op.payload.item_key) ? { data: null, error: { code: '23505', message: 'duplicate key' } } : { data: null, error: null }
    }
    throw new Error(`unexpected query ${op.table} ${op.kind}`)
  })
  return { client, claims }
}

async function runAt(iso, client) {
  const sent = []
  const summary = await runDeadlineReminders({
    client,
    keys: { publicKey: 'x' },
    now: new Date(iso),
    send: async ({ payload }) => {
      sent.push(payload)
      return { ok: true, status: 201 }
    },
    log: { warn() {} },
  })
  return { sent, summary }
}

const calendarItem = (id, title, startTime, extra = {}) => ({ id, title, start_time: startTime, category: 'assignment', all_day: false, ...extra })
const ITEMS_ONLY = { deadline_items: true, digest_minute: null }

test('the evening list goes once a day at its minute, naming what is due before the next one', async () => {
  // HW 3 tonight at 11:59 PM, Quiz 4 tomorrow at 10:00 AM, Lab 5 tomorrow at 7:00 PM (after tomorrow's list).
  const items = [
    calendarItem('a', 'HW 3', '2026-09-09T03:59:00Z'),
    calendarItem('b', 'Quiz 4', '2026-09-09T14:00:00Z'),
    calendarItem('c', 'Lab 5', '2026-09-09T23:00:00Z'),
  ]
  let k = kindsClient({ items })
  let run = await runAt('2026-09-08T21:55:00Z', k.client) // 5:55 PM
  assert.deepEqual([run.sent, k.claims], [[], []], 'not before 6:00 PM')

  k = kindsClient({ items })
  run = await runAt('2026-09-08T22:05:00Z', k.client) // 6:05 PM
  assert.deepEqual(
    run.sent.map((p) => [p.title, p.subtitle, p.body, p.kind, p.url, p.tag, p.expiresAt]),
    [['2 due by tomorrow at 10:00 AM', 'First due at 11:59 PM', 'HW 3 and Quiz 4.', 'deadline-digest', '/assignments', 'deadline-digest-2026-09-08', '2026-09-09T03:59:00.000Z']],
  )
  assert.deepEqual(k.claims, [{ user_id: 'u1', item_key: 'deadline-digest:2026-09-08', kind: 'deadline-digest', sent_at: '2026-09-08T22:05:00.000Z' }])
  assert.equal(run.summary.digests, 1)

  // Only tonight's: the words say so.
  k = kindsClient({ items: items.slice(0, 1) })
  run = await runAt('2026-09-08T22:05:00Z', k.client)
  assert.deepEqual(run.sent.map((p) => [p.title, p.subtitle, p.body]), [['1 due tonight', 'By 11:59 PM', 'HW 3.']])

  // Already sent today: the claim is taken, and nothing goes.
  k = kindsClient({ items, conflicts: ['deadline-digest:2026-09-08'] })
  run = await runAt('2026-09-08T22:10:00Z', k.client)
  assert.deepEqual([run.sent, run.summary.digests], [[], 0])
})

test('no evening list inside quiet hours, with nothing due, or with the list off', async () => {
  const items = [calendarItem('a', 'HW 3', '2026-09-09T05:00:00Z')] // 1:00 AM
  let k = kindsClient({ items })
  await runAt('2026-09-09T03:30:00Z', k.client) // 11:30 PM: past 6:00 PM, but quiet hours have begun
  assert.deepEqual(k.claims, [])

  k = kindsClient({ items: [] })
  await runAt('2026-09-08T22:05:00Z', k.client)
  assert.deepEqual(k.claims, [])

  k = kindsClient({ items, settings: { digest_minute: null } })
  await runAt('2026-09-08T22:05:00Z', k.client)
  assert.deepEqual(k.claims, [])
})

test('a reminder that falls in quiet hours waits for them to end, or is dropped once its item is due, across both clock changes', async () => {
  // The morning of 2027-03-14, when the clocks went forward: HW 3 at 7:45 AM, Quiz 4 at 8:40 AM.
  const march = [calendarItem('a', 'HW 3', '2027-03-14T11:45:00Z'), calendarItem('b', 'Quiz 4', '2027-03-14T12:40:00Z')]
  let k = kindsClient({ settings: ITEMS_ONLY, items: march })
  let run = await runAt('2027-03-14T11:00:00Z', k.client) // 7:00 AM EDT, inside quiet hours
  assert.deepEqual([run.sent, k.claims, run.summary.held], [[], [], 1])
  k = kindsClient({ settings: ITEMS_ONLY, items: march })
  run = await runAt('2027-03-14T12:00:00Z', k.client) // 8:00 AM EDT, quiet hours over
  assert.deepEqual(k.claims.map((c) => c.item_key), ['calendar:b'], 'HW 3 was due at 7:45 and is dropped')
  assert.deepEqual(run.sent.map((p) => p.title), ['Assignment due in 40 min'])

  // The night into 2027-11-07, when they went back: an item due at 11:50 PM EDT.
  const november = [calendarItem('n', 'Essay', '2027-11-07T03:50:00Z')]
  k = kindsClient({ settings: ITEMS_ONLY, items: november })
  run = await runAt('2027-11-07T03:10:00Z', k.client) // 11:10 PM EDT
  assert.deepEqual([k.claims, run.summary.held], [[], 1])
  k = kindsClient({ settings: ITEMS_ONLY, items: november })
  run = await runAt('2027-11-07T13:00:00Z', k.client) // 8:00 AM EST, ten hours later
  assert.deepEqual([run.sent, k.claims], [[], []])
})

test('reminders due within 30 minutes of each other go as one push, which the cap counts once', async () => {
  const items = [
    calendarItem('a', 'HW 3', '2026-09-09T03:59:00Z'),
    calendarItem('b', 'Quiz 4', '2026-09-09T03:59:00Z'),
    calendarItem('c', 'Lab 2 report', '2026-09-09T03:40:00Z'),
  ]
  const k = kindsClient({ settings: ITEMS_ONLY, items })
  const run = await runAt('2026-09-09T02:50:00Z', k.client) // 10:50 PM EDT, before quiet hours
  assert.deepEqual(
    run.sent.map((p) => [p.title, p.body, p.url, p.kind, p.expiresAt]),
    [['3 due in 50 min', 'Lab 2 report, HW 3 and Quiz 4 are due by 11:59 PM.', '/assignments', 'deadline', '2026-09-09T03:40:00.000Z']],
  )
  assert.deepEqual(k.claims.map((c) => [c.item_key, c.kind]), [['calendar:c', 'deadline'], ['calendar:a', 'deadline-merged'], ['calendar:b', 'deadline-merged']])
})

test('the daily cap: past 6 server pushes nothing more is claimed until campus midnight', async () => {
  const items = [calendarItem('a', 'HW 3', '2026-09-08T15:00:00Z')] // 11:00 AM EDT
  let k = kindsClient({ settings: ITEMS_ONLY, items, cappedToday: 5 })
  let run = await runAt('2026-09-08T14:30:00Z', k.client)
  assert.deepEqual([run.sent.length, k.claims.length], [1, 1], 'the sixth goes')

  k = kindsClient({ settings: ITEMS_ONLY, items, cappedToday: 6 })
  run = await runAt('2026-09-08T14:30:00Z', k.client)
  assert.deepEqual([run.sent, k.claims, run.summary.capped], [[], [], 1], 'a seventh waits, unclaimed')
  const capQuery = k.client.calls.find((c) => c.table === 'push_deliveries' && c.filters.some(([f, column]) => f === 'in' && column === 'kind'))
  assert.deepEqual(capQuery.filters, [
    ['eq', 'user_id', 'u1'],
    ['in', 'kind', CAPPED_KINDS],
    ['gte', 'sent_at', '2026-09-08T04:00:00.000Z'],
  ])

  // An evening list past the cap is skipped that day.
  k = kindsClient({ items: [calendarItem('t', 'HW 3', '2026-09-09T03:59:00Z')], cappedToday: 6 })
  run = await runAt('2026-09-08T22:05:00Z', k.client)
  assert.deepEqual([run.sent, k.claims, run.summary.capped], [[], [], 1])
})

test('an all-day item is reminded at 9:00 AM on its day, not an hour before 11:59 PM', async () => {
  const items = [calendarItem('p', 'Paper', '2026-09-08T00:00:00Z', { all_day: true })]
  let k = kindsClient({ settings: ITEMS_ONLY, items })
  await runAt('2026-09-08T12:55:00Z', k.client) // 8:55 AM EDT
  assert.deepEqual(k.claims, [])
  k = kindsClient({ settings: ITEMS_ONLY, items })
  const run = await runAt('2026-09-08T13:05:00Z', k.client) // 9:05 AM EDT
  assert.deepEqual(run.sent.map((p) => p.body), ['Paper is due at 11:59 PM.'])
})

test('before README step 53 the run works as it did, and the log names the file once', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const k = kindsClient({ before53: true, items: [calendarItem('a', 'HW 3', '2026-09-08T22:30:00Z')] }) // 6:30 PM EDT
  const run = await runAt('2026-09-08T22:05:00Z', k.client) // 6:05 PM: no evening list, the reminder an hour ahead
  assert.deepEqual(run.sent.map((p) => p.kind), ['deadline'])
  assert.deepEqual(k.claims.map((c) => [c.item_key, c.kind]), [['calendar:a', 'deadline']])
  assert.equal(run.summary.digests, 0)
  const selects = k.client.calls.filter((c) => c.table === 'push_settings').map((c) => c.payload)
  assert.deepEqual(selects, ['user_id, lead_minutes, deadline_items, digest_minute, quiet_start, quiet_end', 'user_id, lead_minutes'])
  assert.equal(log.mock.callCount(), 1)
  assert.match(String(log.mock.calls[0].arguments[0]), /db\/supabase-push-kinds\.sql/)
})
