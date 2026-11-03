// Favorite-dish alerts (issue #469): once a day, from 8:00 AM campus time, a
// push naming a student's favorites on that day's menu, claimed in
// push_deliveries before it is sent. Pure helpers first, then the runner
// against a recording fake client in the shape of supabase-js.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DINING_ALERT_FROM_MINUTES,
  DINING_ALERT_UNTIL_MINUTES,
  buildDiningFavoritesPayload,
  diningAlertExpiresAt,
  diningAlertKey,
  dishesOnMenu,
  favoritesOnMenu,
  inAlertWindow,
  alertMinuteFor,
  isMissingColumnError,
  mealEndsAt,
  runDiningFavoriteAlerts,
} from '../src/diningFavoriteAlerts.mjs'

// Indianapolis is UTC-4 in October; 2026-10-14 is a Wednesday.
const at = (hhmm) => new Date(`2026-10-14T${hhmm}:00-04:00`)
const KEYS = { publicKey: 'x' }

const SNAPSHOT = {
  ok: true,
  date: '2026-10-14',
  locations: [
    {
      name: 'Tower Dining',
      slug: 'tower-dining',
      menus: [
        { meal: 'lunch', stations: [{ name: 'Homestyle', items: [{ name: 'Honey Garlic Fried Chicken' }] }, { name: 'Daily Grill', items: [{ name: 'Veggie Burger' }] }] },
        { meal: 'dinner', stations: [{ name: 'Daily Grill', items: [{ name: 'Veggie Burger' }] }, { name: 'Homestyle', items: [{ name: 'Beef Stroganoff' }] }] },
      ],
    },
    { name: 'Campus Center', slug: 'campus-center', menus: [], stations: [] },
  ],
}

test('the window runs from 8:00 AM to 7:00 PM on the campus clock', () => {
  assert.equal(DINING_ALERT_FROM_MINUTES, 8 * 60)
  assert.equal(DINING_ALERT_UNTIL_MINUTES, 19 * 60)
  assert.equal(inAlertWindow(at('07:59')), false)
  assert.equal(inAlertWindow(at('08:00')), true)
  assert.equal(inAlertWindow(at('18:59')), true)
  assert.equal(inAlertWindow(at('19:00')), false)
  // 9 AM in Seoul is 8 PM on campus.
  assert.equal(inAlertWindow(new Date('2026-10-15T09:00:00+09:00')), false)
  assert.equal(diningAlertKey('2026-10-14'), 'dining-favorites:2026-10-14')
})

test('dishesOnMenu lists every dish once with its meals; favoritesOnMenu matches by normalized name', () => {
  const dishes = dishesOnMenu(SNAPSHOT)
  assert.deepEqual(dishes.get('veggie burger'), { name: 'Veggie Burger', location: 'Tower Dining', hall: 'tower-dining', meals: ['lunch', 'dinner'] })
  assert.equal(dishes.size, 3)
  // A snapshot from before per-meal menus: the merged list and its meals.
  const merged = dishesOnMenu({ locations: [{ name: 'Tower Dining', stations: [{ items: [{ name: 'Pancakes', meals: ['breakfast'] }, { name: 'Toast' }] }] }] })
  assert.deepEqual(merged.get('pancakes').meals, ['breakfast'])
  assert.deepEqual(merged.get('toast').meals, [])
  assert.deepEqual(
    favoritesOnMenu(['  BEEF   stroganoff ', 'jamaican jerk chicken'], dishes).map((d) => d.name),
    ['Beef Stroganoff'],
  )
  assert.deepEqual(favoritesOnMenu([], dishes), [])
})

// Issue #550, items 2 and 5: the news first, and a tap that opens the hall
// and the meal (the app compares the hall id, tower-dining, exactly).
test('the push leads with the dish, puts its hall and meals in the subtitle, and opens that hall and meal', () => {
  const dishes = dishesOnMenu(SNAPSHOT)
  // The snapshot lists no hours, so lunch runs to the end of its window, 4:30 PM.
  const one = buildDiningFavoritesPayload(favoritesOnMenu(['veggie burger'], dishes), '2026-10-14', { snapshot: SNAPSHOT, now: at('09:00') })
  assert.deepEqual(one, {
    title: 'Veggie Burger is on today',
    subtitle: 'Tower Dining · lunch and dinner',
    body: 'Lunch is served until 4:30 PM.',
    url: '/dining?hall=tower-dining&meal=lunch',
    tag: 'dining-favorites-2026-10-14',
    kind: 'dining-favorites',
    // True until dinner, the last meal that serves it, ends at midnight.
    expiresAt: '2026-10-15T04:00:00.000Z',
  })

  // The other starred dishes go in the body, with their hall when it is another one.
  const twoHalls = {
    ...SNAPSHOT,
    locations: [SNAPSHOT.locations[0], { name: 'Campus Center', slug: 'campus-center', menus: [{ meal: 'dinner', stations: [{ name: 'Grill', items: [{ name: 'Smash Burger' }] }] }] }],
  }
  const three = buildDiningFavoritesPayload(favoritesOnMenu(['smash burger', 'beef stroganoff', 'veggie burger'], dishesOnMenu(twoHalls)), '2026-10-14', {
    snapshot: twoHalls,
    now: at('09:00'),
  })
  assert.equal(three.title, 'Veggie Burger is on today')
  assert.equal(three.body, 'Also on today: Beef Stroganoff and Smash Burger (Campus Center). Lunch is served until 4:30 PM.')

  // Three named at most; dinner's end is not known without the hall's hours.
  const six = buildDiningFavoritesPayload(
    ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({ name, location: 'Tower Dining', hall: 'tower-dining', meals: ['dinner'] })),
    '2026-10-14',
  )
  assert.deepEqual([six.title, six.subtitle, six.body, six.url], ['A is on today', 'Tower Dining · dinner', 'Also on today: B, C, D and 2 more.', '/dining?hall=tower-dining&meal=dinner'])

  // A dish from a snapshot with no hall id or meal still opens Dining.
  const bare = buildDiningFavoritesPayload([{ name: 'Toast', location: 'Tower Dining', hall: null, meals: [] }], '2026-10-14')
  assert.deepEqual([bare.title, bare.subtitle, bare.body, bare.url], ['Toast is on today', 'Tower Dining', '', '/dining'])
  assert.equal(
    buildDiningFavoritesPayload([{ name: 'A', location: 'Tower Dining', hall: 'tower-dining', meals: ['lunch'] }], '2026-10-14').expiresAt,
    '2026-10-14T20:30:00.000Z',
    'lunch ends at 4:30 PM',
  )
})

test("mealEndsAt reads a meal's end from the hall's hours, as the Dining widget does", () => {
  const withHours = { ...SNAPSHOT, locations: [{ ...SNAPSHOT.locations[0], weekly_hours: { Wednesday: '7:00 AM - 8:00 PM' } }] }
  // Dinner ends when the hall closes; lunch at the end of its window.
  assert.equal(new Date(mealEndsAt(withHours, 'tower-dining', 'dinner', at('09:00'))).toISOString(), '2026-10-15T00:00:00.000Z')
  assert.equal(new Date(mealEndsAt(withHours, 'tower-dining', 'lunch', at('09:00'))).toISOString(), '2026-10-14T20:30:00.000Z')
  const dinner = buildDiningFavoritesPayload([{ name: 'Beef Stroganoff', location: 'Tower Dining', hall: 'tower-dining', meals: ['dinner'] }], '2026-10-14', {
    snapshot: withHours,
    now: at('09:00'),
  })
  assert.equal(dinner.body, 'Dinner is served until 8:00 PM.')
  // Without hours the last meal's end is not known, and an unknown hall or meal says nothing.
  assert.equal(mealEndsAt(SNAPSHOT, 'tower-dining', 'dinner', at('09:00')), null)
  assert.equal(mealEndsAt(SNAPSHOT, 'nowhere', 'lunch', at('09:00')), null)
  assert.equal(mealEndsAt(SNAPSHOT, 'tower-dining', null, at('09:00')), null)
  assert.equal(mealEndsAt(null, 'tower-dining', 'lunch', at('09:00')), null)
})

// Issue #550: a dish alert is kept, undelivered, until the last meal that
// serves a starred dish ends, by the clock's usual meal windows.
test('diningAlertExpiresAt is the end of the last meal that serves one of the dishes', () => {
  const dish = (meals) => ({ name: 'Dish', location: 'Tower Dining', meals })
  const ymd = '2026-10-14' // EDT, UTC-4
  assert.equal(diningAlertExpiresAt([dish(['breakfast'])], ymd), '2026-10-14T14:30:00.000Z') // 10:30 AM
  assert.equal(diningAlertExpiresAt([dish(['brunch'])], ymd), '2026-10-14T20:30:00.000Z') // 4:30 PM, as lunch
  assert.equal(diningAlertExpiresAt([dish(['breakfast']), dish(['lunch'])], ymd), '2026-10-14T20:30:00.000Z')
  assert.equal(diningAlertExpiresAt([dish(['lunch', 'dinner'])], ymd), '2026-10-15T04:00:00.000Z') // midnight
  // A meal the windows do not name, and a dish with no meal, run to midnight.
  assert.equal(diningAlertExpiresAt([dish(['late-night'])], ymd), '2026-10-15T04:00:00.000Z')
  assert.equal(diningAlertExpiresAt([dish([])], ymd), '2026-10-15T04:00:00.000Z')
  // Campus time in winter (EST, UTC-5).
  assert.equal(diningAlertExpiresAt([dish(['lunch'])], '2026-12-08'), '2026-12-08T21:30:00.000Z')
})

test('isMissingColumnError knows the column-missing codes and messages', () => {
  assert.equal(isMissingColumnError({ code: '42703', message: 'column push_settings.dining_favorite_alerts does not exist' }), true)
  assert.equal(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'dining_favorite_alerts' column of 'push_settings'" }), true)
  assert.equal(isMissingColumnError({ code: '23505', message: 'duplicate key' }), false)
  assert.equal(isMissingColumnError(null), false)
})

// Minimal thenable query builder in the shape of supabase-js, as in
// test/pushReminders.test.mjs: every call is recorded, and `respond(op)`
// supplies the result when the builder is awaited.
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

// Three students opted in: u1 likes the stroganoff, u2 likes nothing on today's
// menu, u3 was already sent today's alert. `devices` are u1's phones;
// `flagColumnMissing` answers a select that names local_reminders the way
// Postgres does before README step 47 adds it. Issue #550: `quiet` is every
// student's quiet hours (columns of README step 53, which `before53` makes
// missing), and `cappedToday` how many capped pushes each had today.
function alertsClient({ deliveryConflict = false, settingsError = null, devices = [], flagColumnMissing = false, quiet = {}, cappedToday = 0, before53 = false } = {}) {
  return makeClient((op) => {
    if (op.table === 'push_devices' && op.kind === 'select' && flagColumnMissing && String(op.payload).includes('local_reminders')) {
      return { data: null, error: { code: '42703', message: 'column push_devices.local_reminders does not exist' } }
    }
    if (op.table === 'push_settings' && before53 && String(op.payload).includes('quiet_start')) {
      return { data: null, error: { code: '42703', message: 'column push_settings.quiet_start does not exist' } }
    }
    if (op.table === 'push_settings') {
      return settingsError ? { data: null, error: settingsError } : { data: ['u1', 'u2', 'u3'].map((user_id) => ({ user_id, ...quiet })), error: null }
    }
    if (op.table === 'push_deliveries' && op.kind === 'select' && op.filters.some(([f, column]) => f === 'in' && column === 'kind')) {
      return { data: Array.from({ length: cappedToday }, () => ({ kind: 'deadline' })), error: null }
    }
    if (op.table === 'push_deliveries' && op.kind === 'select') return { data: [{ user_id: 'u3' }], error: null }
    if (op.table === 'push_tickets' && op.kind === 'insert') return { data: null, error: null }
    if (op.table === 'push_deliveries' && op.kind === 'insert') {
      return deliveryConflict ? { data: null, error: { code: '23505', message: 'duplicate key' } } : { data: null, error: null }
    }
    if (op.table === 'user_dining_favorites') {
      return { data: [{ user_id: 'u1', item_name: 'beef stroganoff' }, { user_id: 'u2', item_name: 'jamaican jerk chicken' }], error: null }
    }
    if (op.table === 'push_subscriptions' && op.kind === 'select') {
      return { data: [{ id: 's1', user_id: 'u1', endpoint: 'https://push.example/1', p256dh: 'k1', auth: 'a1' }], error: null }
    }
    if (op.table === 'push_devices' && op.kind === 'select') return { data: devices, error: null }
    throw new Error(`unexpected query ${op.table} ${op.kind}`)
  })
}

test('the run claims and sends one alert to each student whose favorite is on the menu', async () => {
  const client = alertsClient()
  const sent = []
  const send = async ({ subscription, payload, topic }) => {
    sent.push({ endpoint: subscription.endpoint, title: payload.title, subtitle: payload.subtitle, url: payload.url, topic })
    return { ok: true, status: 201 }
  }
  const snapshots = []
  const summary = await runDiningFavoriteAlerts({
    client,
    keys: KEYS,
    getSnapshot: async (options) => (snapshots.push(options), SNAPSHOT),
    now: at('16:05'), // Beef Stroganoff is a dinner dish: its alert goes from 4:00 PM (issue #550)
    send,
    log: { warn() {} },
  })
  assert.deepEqual(summary, { users: 1, matched: 1, sent: 1, failed: 0, removed: 0, skipped: 1, early: 0, held: 0, capped: 0 })
  assert.deepEqual(sent, [
    {
      endpoint: 'https://push.example/1',
      title: 'Beef Stroganoff is on today',
      subtitle: 'Tower Dining · dinner',
      url: '/dining?hall=tower-dining&meal=dinner',
      topic: 'dining-favorites-2026-10-14',
    },
  ])
  const claim = client.calls.find((c) => c.table === 'push_deliveries' && c.kind === 'insert')
  assert.deepEqual(claim.payload, { user_id: 'u1', item_key: 'dining-favorites:2026-10-14', kind: 'dining-favorites', sent_at: at('16:05').toISOString() })
  // Only students not yet sent today are read, and the opted-in filter is on the switch.
  const settings = client.calls.find((c) => c.table === 'push_settings')
  assert.deepEqual(settings.filters[0], ['eq', 'dining_favorite_alerts', true])
  const favorites = client.calls.find((c) => c.table === 'user_dining_favorites')
  assert.deepEqual(favorites.filters, [['in', 'user_id', ['u1', 'u2']]])
  assert.equal(snapshots.length, 1)
})

// Antoniodeoliveirasegura/boilerindy-app#55: a phone with local reminders gets
// no deadline reminders from the server, but the phone cannot know the day's
// menu ahead of time, so the favorite-dish alert still reaches it.
const PHONE = 'ExponentPushToken[phone000000000000000001]'

async function runWithPhones(client) {
  const expo = []
  const messages = []
  const summary = await runDiningFavoriteAlerts({
    client,
    keys: KEYS,
    getSnapshot: async () => SNAPSHOT,
    now: at('16:05'),
    send: async () => ({ ok: true, status: 201 }),
    sendExpo: async ({ messages: batch }) => {
      expo.push(...batch.map((m) => [m.to, m.data.kind]))
      messages.push(...batch)
      return batch.map((m) => ({ token: m.to, ok: true, ticketId: 't' }))
    },
    log: { warn() {} },
  })
  return { expo, messages, summary }
}

test('a phone with local reminders still gets the favorite-dish alert', async () => {
  const { expo, summary } = await runWithPhones(alertsClient({ devices: [{ id: 'd1', user_id: 'u1', token: PHONE, failure_count: 0, local_reminders: true }] }))
  assert.deepEqual(expo, [[PHONE, 'dining-favorites']])
  assert.equal(summary.sent, 2, 'the browser and the phone')
})

// Issue #550: the dining-favorites kind is passive, so it arrives quietly in
// its own stack, and it is kept only until the meal it names ends.
test('on a phone the dish alert is passive and silent, and kept until its last meal ends', async () => {
  const { messages } = await runWithPhones(alertsClient({ devices: [{ id: 'd1', user_id: 'u1', token: PHONE, failure_count: 0 }] }))
  const [message] = messages
  assert.equal(message.interruptionLevel, 'passive')
  assert.equal(message.threadId, 'dining')
  assert.equal(message.relevanceScore, 0.3)
  assert.equal(message.categoryId, 'dining')
  assert.equal(message.priority, 'normal')
  assert.equal('sound' in message, false, 'no sound')
  // Beef Stroganoff is a dinner dish: from 4:05 PM to midnight.
  assert.equal(message.ttl, (8 * 60 - 5) * 60)
})

test('before README step 47 runs, the favorite-dish alert still reaches the phones', async (t) => {
  t.mock.method(console, 'error', () => {})
  const client = alertsClient({ devices: [{ id: 'd1', user_id: 'u1', token: PHONE, failure_count: 0 }], flagColumnMissing: true })
  const { expo, summary } = await runWithPhones(client)
  assert.deepEqual(expo, [[PHONE, 'dining-favorites']])
  assert.equal(summary.sent, 2)
  const selects = client.calls.filter((c) => c.table === 'push_devices' && c.kind === 'select').map((c) => c.payload)
  assert.deepEqual(selects, ['id, user_id, token, platform, failure_count, local_reminders, kinds, channels', 'id, user_id, token, platform, failure_count'])
})

test('a claim that already exists is skipped: two overlapping runs send once', async () => {
  const client = alertsClient({ deliveryConflict: true })
  let sends = 0
  const summary = await runDiningFavoriteAlerts({ client, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('16:30'), send: async () => (sends++, { ok: true }) })
  assert.equal(sends, 0)
  assert.equal(summary.users, 0)
  assert.equal(summary.skipped, 2)
})

test('outside the window, without keys, switched off, before the migration, or without a menu nothing is read or sent', async () => {
  const quiet = makeClient(() => {
    throw new Error('no query expected')
  })
  assert.equal((await runDiningFavoriteAlerts({ client: quiet, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('07:30') })).reason, 'outside_window')
  assert.equal((await runDiningFavoriteAlerts({ client: quiet, keys: null, getSnapshot: async () => SNAPSHOT, now: at('09:00') })).reason, 'no_vapid_keys')
  // PUSH_KINDS_OFF=dining-favorites (issue #550).
  const off = await runDiningFavoriteAlerts({ client: quiet, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('09:00'), kindsOff: new Set(['dining-favorites']) })
  assert.equal(off.reason, 'kind_off')
  assert.equal(quiet.calls.length, 0)

  const missing = alertsClient({ settingsError: { code: '42703', message: 'column push_settings.dining_favorite_alerts does not exist' } })
  assert.equal((await runDiningFavoriteAlerts({ client: missing, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('09:00') })).reason, 'not_configured')

  const noMenu = alertsClient()
  const summary = await runDiningFavoriteAlerts({ client: noMenu, keys: KEYS, getSnapshot: async () => ({ ok: false, locations: [] }), now: at('09:00') })
  assert.equal(summary.reason, 'no_menu')
  assert.ok(!noMenu.calls.some((c) => c.table === 'push_deliveries' && c.kind === 'insert'))

  const broken = alertsClient({ settingsError: { code: '57014', message: 'canceling statement due to statement timeout' } })
  await assert.rejects(runDiningFavoriteAlerts({ client: broken, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('09:00') }), /push_settings select/)
})

// Issue #550 (README step 53): a dish alert never goes inside quiet hours,
// where it waits unclaimed for the first run after them, or past the daily cap.
test('a dish alert waits out quiet hours and stops at the daily cap', async () => {
  const run = (client, hhmm) => runDiningFavoriteAlerts({ client, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at(hhmm), send: async () => ({ ok: true, status: 201 }), log: { warn() {} } })
  const claimsOf = (client) => client.calls.filter((c) => c.table === 'push_deliveries' && c.kind === 'insert')

  // Quiet hours from 3:00 to 5:00 PM: at 4:05 the dinner alert waits; at 5:00 it goes.
  const afternoon = { quiet_start: 15 * 60, quiet_end: 17 * 60 }
  let client = alertsClient({ quiet: afternoon })
  let summary = await run(client, '16:05')
  assert.deepEqual([summary.held, summary.users, claimsOf(client).length], [1, 0, 0])
  client = alertsClient({ quiet: afternoon })
  summary = await run(client, '17:00')
  assert.deepEqual([summary.held, summary.users, claimsOf(client).length], [0, 1, 1])

  // Six capped pushes already today: no seventh.
  client = alertsClient({ cappedToday: 6 })
  summary = await run(client, '16:30')
  assert.deepEqual([summary.capped, summary.users, claimsOf(client).length], [1, 0, 0])
  client = alertsClient({ cappedToday: 5 })
  summary = await run(client, '16:30')
  assert.deepEqual([summary.capped, summary.users], [0, 1])

  // Before README step 53 neither applies, and the alert goes as before.
  client = alertsClient({ quiet: afternoon, cappedToday: 6, before53: true })
  summary = await run(client, '16:05')
  assert.deepEqual([summary.held, summary.capped, summary.users], [0, 0, 1])
  assert.deepEqual(
    client.calls.filter((c) => c.table === 'push_settings').map((c) => c.payload),
    ['user_id, quiet_start, quiet_end', 'user_id'],
  )
})

// Issue #550, item 6: the alert goes 30 minutes before the first meal that
// serves a starred dish, not at the first run after 8:00 AM.
test('the alert goes 30 minutes before the first meal that serves a starred dish', async () => {
  const dish = (meals) => ({ name: 'Dish', location: 'Tower Dining', hall: 'tower-dining', meals })
  assert.equal(alertMinuteFor([dish(['breakfast'])]), 8 * 60)
  assert.equal(alertMinuteFor([dish(['lunch'])]), 10 * 60)
  assert.equal(alertMinuteFor([dish(['brunch'])]), 10 * 60)
  assert.equal(alertMinuteFor([dish(['dinner'])]), 16 * 60)
  assert.equal(alertMinuteFor([dish(['dinner']), dish(['lunch', 'dinner'])]), 10 * 60, 'the first meal of the day wins')
  assert.equal(alertMinuteFor([dish([])]), 8 * 60, 'a dish with no meal counts from the morning')
  assert.equal(alertMinuteFor([dish(['late-night'])]), 8 * 60)

  // u1's Beef Stroganoff is on at dinner: at 3:55 PM it is too early, and nothing is claimed.
  const run = (client, hhmm) => runDiningFavoriteAlerts({ client, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at(hhmm), send: async () => ({ ok: true, status: 201 }), log: { warn() {} } })
  let client = alertsClient()
  let summary = await run(client, '15:55')
  assert.deepEqual([summary.early, summary.users], [1, 0])
  assert.equal(client.calls.filter((c) => c.table === 'push_deliveries' && c.kind === 'insert').length, 0)
  client = alertsClient()
  summary = await run(client, '16:00')
  assert.deepEqual([summary.early, summary.users, summary.sent], [0, 1, 1])
})

test('a phone that listed its kinds without the dish alerts does not get them', async () => {
  const devices = [
    { id: 'd1', user_id: 'u1', token: PHONE, failure_count: 0, kinds: ['deadline'], channels: ['deadlines'] },
    { id: 'd2', user_id: 'u1', token: 'ExponentPushToken[phone000000000000000002]', failure_count: 0, kinds: ['dining-favorites'], channels: ['dining'] },
  ]
  const { messages } = await runWithPhones(alertsClient({ devices }))
  assert.deepEqual(messages.map((m) => [m.to, m.channelId]), [['ExponentPushToken[phone000000000000000002]', 'dining']])
})
