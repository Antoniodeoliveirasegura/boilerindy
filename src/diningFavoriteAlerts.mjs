// Favorite-dish alerts (issue #469): once a day, a push to each student who
// turned them on, naming their favorite dishes on that day's menu.
//
// They ride the deadline reminder run (POST /api/internal/push/run-reminders,
// every 5 minutes): no new cron job. A student opts in with
// push_settings.dining_favorite_alerts (db/supabase-dining-favorite-alerts.sql,
// off by default); before that migration runs the column is missing and this
// run does nothing. Each student is claimed once per day in push_deliveries
// as "dining-favorites:<YYYY-MM-DD>" before anything is sent, so overlapping
// runs cannot both notify, and a student with no favorite on the menu is not
// claimed (a menu that changes later in the day can still match).
//
// Pure pieces (the window, the matching, the copy) are exported for the tests;
// the runner takes the Supabase client, the VAPID keys and the dining snapshot
// reader from the push router.

import { minutesInZone } from './diningMeals.mjs'
import { normalizeItemName } from './diningFavorites.mjs'
import { MAX_DEVICE_STRIKES, sendExpoPush } from './expoPush.mjs'
import { sendWebPush } from './webPush.mjs'
import { queryError } from './cronTick.mjs'
import { deliverToPushDevices, isMissingTableError, loadPushDevices } from './pushReminders.mjs'
import { todayYmdInZone } from './nutrisliceDining.mjs'

// Sent from 8:00 AM campus time, when the day's menu is firm, and not after
// 7:00 PM, when there is little left to eat that day.
export const DINING_ALERT_FROM_MINUTES = 8 * 60
export const DINING_ALERT_UNTIL_MINUTES = 19 * 60
export const DINING_ALERT_URL = '/dining'
// Dishes named in one message before "and N more".
const NAMED_DISHES = 3

/** True between DINING_ALERT_FROM_MINUTES and DINING_ALERT_UNTIL_MINUTES on the campus clock. */
export function inAlertWindow(now = new Date()) {
  const minutes = minutesInZone(now)
  return minutes >= DINING_ALERT_FROM_MINUTES && minutes < DINING_ALERT_UNTIL_MINUTES
}

/** The claim key for a student's alert on a campus date. */
export function diningAlertKey(ymd) {
  return `dining-favorites:${ymd}`
}

/** A missing column, which is what the alerts column looks like before its migration runs. */
export function isMissingColumnError(error) {
  const code = String(error?.code || '')
  if (code === '42703' || code === 'PGRST204') return true
  return /column .+ does not exist|Could not find the .+ column/i.test(String(error?.message || ''))
}

/**
 * Every dish on a snapshot's menus, keyed by normalized name: { name,
 * location, meals } with the meals in serving order. Per-meal menus when the
 * snapshot has them, else the merged stations and each item's `meals`.
 */
export function dishesOnMenu(snapshot) {
  const dishes = new Map()
  const add = (name, location, meal) => {
    const key = normalizeItemName(name)
    if (!key) return
    if (!dishes.has(key)) dishes.set(key, { name, location, meals: [] })
    const dish = dishes.get(key)
    if (meal && !dish.meals.includes(meal)) dish.meals.push(meal)
  }
  for (const loc of snapshot?.locations || []) {
    if (Array.isArray(loc.menus) && loc.menus.length) {
      for (const menu of loc.menus) for (const station of menu.stations || []) for (const item of station.items || []) add(item.name, loc.name, menu.meal)
    } else {
      for (const station of loc.stations || []) {
        for (const item of station.items || []) {
          if (item.meals?.length) for (const meal of item.meals) add(item.name, loc.name, meal)
          else add(item.name, loc.name, null)
        }
      }
    }
  }
  return dishes
}

/** The dishes on the menu among a student's favorites (normalized names), in menu order. */
export function favoritesOnMenu(favoriteNames, dishes) {
  const wanted = new Set([...(favoriteNames || [])].map(normalizeItemName).filter(Boolean))
  return [...dishes.entries()].filter(([key]) => wanted.has(key)).map(([, dish]) => dish)
}

/** The push for a student's favorites on the day's menu. */
export function buildDiningFavoritesPayload(matches, ymd) {
  const describe = (dish) => `${dish.name} (${dish.meals.length ? `${dish.meals.join(' and ')}, ` : ''}${dish.location})`
  const named = matches.slice(0, NAMED_DISHES).map(describe)
  const more = matches.length - named.length
  return {
    title: matches.length === 1 ? `${matches[0].name} is on the menu today` : `${matches.length} of your favorites are on the menu today`,
    body: `${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`,
    url: DINING_ALERT_URL,
    tag: `dining-favorites-${ymd}`,
    kind: 'dining-favorites',
  }
}

/**
 * Send today's favorite-dish alerts. Returns a summary for the cron log, with
 * `reason` when nothing could be considered (no keys, outside the window, the
 * column not migrated, no menu). Database errors other than a missing table or
 * column throw a SupabaseQueryError, as the deadline run does.
 */
export async function runDiningFavoriteAlerts({
  client,
  keys,
  getSnapshot,
  now = new Date(),
  send = sendWebPush,
  sendExpo = sendExpoPush,
  maxUsers = 200,
  maxSends = 300,
  log = console,
}) {
  const summary = { users: 0, matched: 0, sent: 0, failed: 0, removed: 0, skipped: 0 }
  if (!keys) return { ...summary, reason: 'no_vapid_keys' }
  if (!inAlertWindow(now)) return { ...summary, reason: 'outside_window' }

  const settingsRes = await client.from('push_settings').select('user_id').eq('dining_favorite_alerts', true).limit(maxUsers)
  if (settingsRes.error) {
    if (isMissingTableError(settingsRes.error) || isMissingColumnError(settingsRes.error)) return { ...summary, reason: 'not_configured' }
    throw queryError(settingsRes, 'push_settings select (dining alerts)')
  }
  const optedIn = (settingsRes.data || []).map((row) => row.user_id)
  if (!optedIn.length) return summary

  const today = todayYmdInZone(now)
  const key = diningAlertKey(today)
  const deliveredRes = await client.from('push_deliveries').select('user_id').eq('item_key', key).in('user_id', optedIn)
  if (deliveredRes.error) throw queryError(deliveredRes, 'push_deliveries select (dining alerts)')
  const delivered = new Set((deliveredRes.data || []).map((row) => row.user_id))
  const pending = optedIn.filter((id) => !delivered.has(id))
  summary.skipped += delivered.size
  if (!pending.length) return summary

  const snapshot = await getSnapshot({ now })
  const dishes = snapshot?.ok ? dishesOnMenu(snapshot) : new Map()
  if (!dishes.size) return { ...summary, reason: 'no_menu' }

  const favRes = await client.from('user_dining_favorites').select('user_id, item_name').in('user_id', pending)
  if (favRes.error) {
    if (isMissingTableError(favRes.error)) return { ...summary, reason: 'not_configured' }
    throw queryError(favRes, 'user_dining_favorites select')
  }
  const favoritesByUser = new Map()
  for (const row of favRes.data || []) {
    if (!favoritesByUser.has(row.user_id)) favoritesByUser.set(row.user_id, [])
    favoritesByUser.get(row.user_id).push(row.item_name)
  }
  const matchesByUser = new Map()
  for (const userId of pending) {
    const matches = favoritesOnMenu(favoritesByUser.get(userId) || [], dishes)
    if (matches.length) matchesByUser.set(userId, matches)
  }
  summary.matched = matchesByUser.size
  if (!matchesByUser.size) return summary

  const userIds = [...matchesByUser.keys()]
  const subsRes = await client.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').in('user_id', userIds)
  if (subsRes.error) throw queryError(subsRes, 'push_subscriptions select (dining alerts)')
  const subsByUser = new Map()
  for (const sub of subsRes.data || []) {
    if (!subsByUser.has(sub.user_id)) subsByUser.set(sub.user_id, [])
    subsByUser.get(sub.user_id).push(sub)
  }
  const loaded = await loadPushDevices(client, userIds, { log })
  summary.removed += loaded.removed
  const devicesByUser = new Map()
  for (const device of loaded.devices) {
    if (!devicesByUser.has(device.user_id)) devicesByUser.set(device.user_id, [])
    devicesByUser.get(device.user_id).push(device)
  }

  for (const [userId, matches] of matchesByUser) {
    if (summary.sent + summary.failed >= maxSends) break
    const subs = subsByUser.get(userId) || []
    const devices = (devicesByUser.get(userId) || []).filter((d) => (d.failure_count || 0) < MAX_DEVICE_STRIKES)
    if (!subs.length && !devices.length) {
      summary.skipped += 1
      continue
    }
    const claim = await client.from('push_deliveries').insert({ user_id: userId, item_key: key, kind: 'dining-favorites', sent_at: now.toISOString() })
    if (claim.error) {
      if (claim.error.code === '23505') {
        summary.skipped += 1
        continue
      }
      throw queryError(claim, 'push_deliveries insert (dining alerts)')
    }
    summary.users += 1
    const payload = buildDiningFavoritesPayload(matches, today)
    for (const sub of subs) {
      const result = await send({
        subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        keys,
        topic: payload.tag,
        now: now.getTime(),
      })
      if (result.ok) {
        summary.sent += 1
        continue
      }
      summary.failed += 1
      if (result.gone) {
        const del = await client.from('push_subscriptions').delete().eq('id', sub.id)
        if (!del.error) summary.removed += 1
      } else {
        log.warn(`[push] dining alert delivery failed (${result.status}): ${result.error}`)
      }
    }
    if (devices.length) {
      const native = await deliverToPushDevices({ client, devices, payload, send: sendExpo, log })
      summary.sent += native.sent
      summary.failed += native.failed
      summary.removed += native.removed
    }
  }
  return summary
}
