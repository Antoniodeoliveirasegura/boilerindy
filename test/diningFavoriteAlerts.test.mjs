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
  diningAlertKey,
  dishesOnMenu,
  favoritesOnMenu,
  inAlertWindow,
  isMissingColumnError,
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
      menus: [
        { meal: 'lunch', stations: [{ name: 'Homestyle', items: [{ name: 'Honey Garlic Fried Chicken' }] }, { name: 'Daily Grill', items: [{ name: 'Veggie Burger' }] }] },
        { meal: 'dinner', stations: [{ name: 'Daily Grill', items: [{ name: 'Veggie Burger' }] }, { name: 'Homestyle', items: [{ name: 'Beef Stroganoff' }] }] },
      ],
    },
    { name: 'Campus Center', menus: [], stations: [] },
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
  assert.deepEqual(dishes.get('veggie burger'), { name: 'Veggie Burger', location: 'Tower Dining', meals: ['lunch', 'dinner'] })
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

test('the push names the dishes, their meals and the hall, and opens the Dining page', () => {
  const dishes = dishesOnMenu(SNAPSHOT)
  const one = buildDiningFavoritesPayload(favoritesOnMenu(['veggie burger'], dishes), '2026-10-14')
  assert.deepEqual(one, {
    title: 'Veggie Burger is on the menu today',
    body: 'Veggie Burger (lunch and dinner, Tower Dining).',
    url: '/dining',
    tag: 'dining-favorites-2026-10-14',
    kind: 'dining-favorites',
  })
  const many = buildDiningFavoritesPayload(
    [...['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, location: 'Tower Dining', meals: ['lunch'] }))],
    '2026-10-14',
  )
  assert.equal(many.title, '5 of your favorites are on the menu today')
  assert.equal(many.body, 'A (lunch, Tower Dining); B (lunch, Tower Dining); C (lunch, Tower Dining); and 2 more.')
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
// menu, u3 was already sent today's alert.
function alertsClient({ deliveryConflict = false, settingsError = null } = {}) {
  return makeClient((op) => {
    if (op.table === 'push_settings') return settingsError ? { data: null, error: settingsError } : { data: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'select') return { data: [{ user_id: 'u3' }], error: null }
    if (op.table === 'push_deliveries' && op.kind === 'insert') {
      return deliveryConflict ? { data: null, error: { code: '23505', message: 'duplicate key' } } : { data: null, error: null }
    }
    if (op.table === 'user_dining_favorites') {
      return { data: [{ user_id: 'u1', item_name: 'beef stroganoff' }, { user_id: 'u2', item_name: 'jamaican jerk chicken' }], error: null }
    }
    if (op.table === 'push_subscriptions' && op.kind === 'select') {
      return { data: [{ id: 's1', user_id: 'u1', endpoint: 'https://push.example/1', p256dh: 'k1', auth: 'a1' }], error: null }
    }
    if (op.table === 'push_devices' && op.kind === 'select') return { data: [], error: null }
    throw new Error(`unexpected query ${op.table} ${op.kind}`)
  })
}

test('the run claims and sends one alert to each student whose favorite is on the menu', async () => {
  const client = alertsClient()
  const sent = []
  const send = async ({ subscription, payload, topic }) => {
    sent.push({ endpoint: subscription.endpoint, title: payload.title, body: payload.body, topic })
    return { ok: true, status: 201 }
  }
  const snapshots = []
  const summary = await runDiningFavoriteAlerts({
    client,
    keys: KEYS,
    getSnapshot: async (options) => (snapshots.push(options), SNAPSHOT),
    now: at('08:05'),
    send,
    log: { warn() {} },
  })
  assert.deepEqual(summary, { users: 1, matched: 1, sent: 1, failed: 0, removed: 0, skipped: 1 })
  assert.deepEqual(sent, [
    { endpoint: 'https://push.example/1', title: 'Beef Stroganoff is on the menu today', body: 'Beef Stroganoff (dinner, Tower Dining).', topic: 'dining-favorites-2026-10-14' },
  ])
  const claim = client.calls.find((c) => c.table === 'push_deliveries' && c.kind === 'insert')
  assert.deepEqual(claim.payload, { user_id: 'u1', item_key: 'dining-favorites:2026-10-14', kind: 'dining-favorites', sent_at: at('08:05').toISOString() })
  // Only students not yet sent today are read, and the opted-in filter is on the switch.
  const settings = client.calls.find((c) => c.table === 'push_settings')
  assert.deepEqual(settings.filters[0], ['eq', 'dining_favorite_alerts', true])
  const favorites = client.calls.find((c) => c.table === 'user_dining_favorites')
  assert.deepEqual(favorites.filters, [['in', 'user_id', ['u1', 'u2']]])
  assert.equal(snapshots.length, 1)
})

test('a claim that already exists is skipped: two overlapping runs send once', async () => {
  const client = alertsClient({ deliveryConflict: true })
  let sends = 0
  const summary = await runDiningFavoriteAlerts({ client, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('12:00'), send: async () => (sends++, { ok: true }) })
  assert.equal(sends, 0)
  assert.equal(summary.users, 0)
  assert.equal(summary.skipped, 2)
})

test('outside the window, without keys, before the migration, or without a menu nothing is read or sent', async () => {
  const quiet = makeClient(() => {
    throw new Error('no query expected')
  })
  assert.equal((await runDiningFavoriteAlerts({ client: quiet, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('07:30') })).reason, 'outside_window')
  assert.equal((await runDiningFavoriteAlerts({ client: quiet, keys: null, getSnapshot: async () => SNAPSHOT, now: at('09:00') })).reason, 'no_vapid_keys')

  const missing = alertsClient({ settingsError: { code: '42703', message: 'column push_settings.dining_favorite_alerts does not exist' } })
  assert.equal((await runDiningFavoriteAlerts({ client: missing, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('09:00') })).reason, 'not_configured')

  const noMenu = alertsClient()
  const summary = await runDiningFavoriteAlerts({ client: noMenu, keys: KEYS, getSnapshot: async () => ({ ok: false, locations: [] }), now: at('09:00') })
  assert.equal(summary.reason, 'no_menu')
  assert.ok(!noMenu.calls.some((c) => c.table === 'push_deliveries' && c.kind === 'insert'))

  const broken = alertsClient({ settingsError: { code: '57014', message: 'canceling statement due to statement timeout' } })
  await assert.rejects(runDiningFavoriteAlerts({ client: broken, keys: KEYS, getSnapshot: async () => SNAPSHOT, now: at('09:00') }), /push_settings select/)
})
