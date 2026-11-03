// Campus alert pushes (issue #550, item 9; issue #34). The banner on the
// website and the app shows IU's alert for the Indianapolis campus to a
// student who has BoilerIndy open; this pushes it to the students who do not.
//
// The fast tick (POST /api/internal/push/fast-tick, src/routes/push.mjs)
// reads IU's feed through the banner's cache (readCampusAlertCached), so it
// never adds a request to IU. The feed holds one message, the latest. The tick
// keeps each message it sees once (campus_alert_messages, README step 56) and
// groups them into incidents (campus_alert_incidents):
//
// - An emergency's first message opens an incident and is pushed
//   (campus-alert) to every device that takes the kind (deviceTakes: a phone
//   that listed it, or one from before phones listed kinds) and every browser,
//   of each account that has not turned campus alerts off. It is
//   time-sensitive and ignores quiet hours and the daily cap.
// - Updates and finals join the open incident and only change the banner.
// - IU's "Campus Status Normal" closes what is open, and each closed incident
//   that was pushed gets one all clear (campus-all-clear) under the alert's
//   collapse id, `campus-<incident>`, so it replaces the alert. In a
//   student's quiet hours it goes silent: passive and without a sound. An
//   incident that was never pushed gets none.
// - IU's tests open incidents of their own and go to admins only
//   (users.is_admin or ADMIN_EMAILS), all clear included, so the owner can
//   check the whole path on a phone.
// - A message first seen more than LATE_AFTER_MINUTES after IU sent it stays
//   banner-only, an all clear too: a late push about an emergency misleads.
//   Its incident still opens, so the Normal after it closes it.
// - A reading the cache kept serving while IU could not be reached is not
//   acted on, so an all clear only ever follows a Normal actually read.
//
// Claim before send, as everywhere in push: alert_pushed_at and
// clear_pushed_at are set by a conditional update right before the broadcast,
// so overlapping ticks, or a second instance during a deploy, never push
// twice. The incident a message opens takes an id made from the message's
// (incidentIdFor), so a tick that failed halfway and runs again finds that
// incident instead of opening a second one; the message row, written last,
// marks the message done. The audience is read before the claim, so a
// database error there leaves nothing claimed for the retry.
//
// One incident is open at a time (one real, one test). Two valves keep one
// whose Normal the tick never saw (a new message replaced it in the feed
// between two reads) from taking the next emergency as an update: a message
// after the incident's final, or more than INCIDENT_IDLE_HOURS after its last
// message, closes it without an all clear and opens a new one.
//
// The second source of issue #34 (PurdueALERT, joining an incident within 15
// minutes) is not read yet; the schema allows its rows. See
// docs/campus-alerts.md, "Push notifications".

import { createHash } from 'node:crypto'
import { IU_ALERT_SOURCE, STALE_AFTER_MS } from './campusAlert.mjs'
import { queryError } from './cronTick.mjs'
import { DB_FEATURES, logSchemaMissingOnce } from './dbErrors.mjs'
import { CAMPUS_TIME_ZONE, minutesInZone } from './diningMeals.mjs'
import { sendExpoPush } from './expoPush.mjs'
import { isMissingColumnError } from './moderation.mjs'
import { notificationKind } from './notificationKinds.mjs'
import { fetchAllPages } from './pagedSelect.mjs'
import { isQuietMinute, quietWindow } from './pushPolicy.mjs'
import { deliverToPushDevices, isMissingTableError, settingsFromRow, withDeviceColumns } from './pushReminders.mjs'
import { sendWebPush } from './webPush.mjs'

export const LATE_AFTER_MINUTES = 30
export const INCIDENT_IDLE_HOURS = 12
// Browsers are sent to this many at a time; Expo takes 100 phones a request.
export const WEB_PUSH_CONCURRENCY = 8
// The pause before a failed Expo batch is sent again, once.
export const EXPO_RETRY_DELAY_MS = 2000
// Every row of the audience, paged past PostgREST's 1,000-row responses.
const AUDIENCE_MAX_ROWS = 50_000
const SOURCE = 'iu'
const CAMPUS_ALERT_SCHEMA = { feature: 'campus_alert_push', sqlFile: 'db/supabase-campus-alert-push.sql' }

const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: CAMPUS_TIME_ZONE, hour: 'numeric', minute: '2-digit' })
// Expo's whole-request failures worth one more try: the request never got
// tickets back. A ticket's own error (DeviceNotRegistered) or a refusal
// (http_400, http_401) would only fail again.
const EXPO_RETRYABLE = /^(timeout|network|bad_response|http_(429|5\d\d))\b/

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What a message is before its incident is known: 'normal' (IU's all clear),
 * 'test', 'final' (IU's "final alert", or "no longer a threat"), or 'alert'.
 */
export function messageRole(alert) {
  if (alert.normal) return 'normal'
  if (alert.test) return 'test'
  if (/\bfinal\b/i.test(alert.headline) || /\bno longer a threat\b/i.test(alert.message ?? '')) return 'final'
  return 'alert'
}

/**
 * The incident a message opens: a UUID made from the source and the message's
 * id, the same on every run, shaped as a name-based (version 5) UUID.
 */
export function incidentIdFor(source, sourceId) {
  const hex = createHash('sha256').update(`campus-alert:${source}:${sourceId}`).digest('hex')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * The push for an incident's alert or all clear, in the shape every sender
 * takes: IU's words unchanged (the headline, then IU's description and
 * instruction when it sent them), credited as the banner credits them ("IU
 * Indianapolis alert"), with the time IU sent it. `silent` is the all clear in
 * a student's quiet hours; by day it renotifies, since it replaces the alert
 * under the same tag.
 */
export function campusAlertPayload(alert, { kind, incidentId, silent = false }) {
  const sent = Date.parse(alert.sentAt ?? '')
  const payload = {
    kind,
    title: `${IU_ALERT_SOURCE} ${alert.test ? 'test' : 'alert'}`,
    body: [alert.headline, alert.message, alert.instruction].filter(Boolean).join(' '),
    url: `/safety?incident=${incidentId}`,
    tag: `campus-${incidentId}`,
  }
  if (Number.isFinite(sent)) payload.subtitle = `Sent ${CLOCK.format(new Date(sent))}`
  if (kind === 'campus-all-clear') Object.assign(payload, silent ? { silent: true } : { renotify: true })
  return payload
}

/** Expo's send, sending the messages of a batch that got no tickets back once more after a pause. */
export function retryFailedBatchOnce(sendExpo, { sleep = wait, delayMs = EXPO_RETRY_DELAY_MS } = {}) {
  return async (options) => {
    const results = await sendExpo(options)
    const again = []
    results.forEach((result, i) => {
      if (!result.ok && EXPO_RETRYABLE.test(String(result.error ?? ''))) again.push(i)
    })
    if (again.length === 0) return results
    await sleep(delayMs)
    const retried = await sendExpo({ ...options, messages: again.map((i) => options.messages[i]) })
    const merged = [...results]
    again.forEach((i, k) => {
      if (retried[k]) merged[i] = retried[k]
    })
    return merged
  }
}

async function eachLimit(items, limit, run) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

const iso = (ms) => new Date(ms).toISOString()

// The accounts a test goes to: users.is_admin (README step 6's column, read
// as no one before it runs) and ADMIN_EMAILS.
async function adminUserIds(client, adminEmails) {
  const ids = new Set()
  const flagged = await client.from('users').select('id').eq('is_admin', true).limit(100)
  if (flagged.error && !isMissingColumnError(flagged.error)) throw queryError(flagged, 'users select (admins)')
  for (const row of flagged.data || []) ids.add(row.id)
  if (adminEmails.length) {
    const named = await client.from('users').select('id').in('email', adminEmails).limit(100)
    if (named.error) throw queryError(named, 'users select (admin emails)')
    for (const row of named.data || []) ids.add(row.id)
  }
  return [...ids]
}

/**
 * Who gets an incident's pushes: every browser and phone of the accounts that
 * have not turned campus alerts off (README step 53's campus_alerts; before it,
 * every account), or only the admins' for a test, with each account's quiet
 * hours for the all clear. Returns { subs, devices, quietFor(userId) }. The
 * phones are every one of them; deliverToPushDevices sends only to those that
 * take the kind. A missing table reads as no rows.
 */
async function loadAudience(client, { userIds }) {
  const scoped = (query) => (userIds ? query.in('user_id', userIds) : query)
  const empty = { subs: [], devices: [], quietFor: () => null }
  if (userIds && userIds.length === 0) return empty

  const readSettings = (columns) =>
    fetchAllPages(() => scoped(client.from('push_settings').select(columns)).order('user_id'), { max: AUDIENCE_MAX_ROWS })
  let settingsRes = await readSettings('user_id, campus_alerts, quiet_start, quiet_end')
  if (settingsRes.error && isMissingColumnError(settingsRes.error)) {
    // Before README step 53: every account is in, with the default quiet hours.
    logSchemaMissingOnce(DB_FEATURES.push_kinds, settingsRes.error)
    settingsRes = await readSettings('user_id')
  }
  if (settingsRes.error) {
    if (isMissingTableError(settingsRes.error)) return empty
    throw queryError(settingsRes, 'push_settings select (campus alerts)')
  }
  const settingsByUser = new Map((settingsRes.data || []).map((row) => [row.user_id, settingsFromRow(row)]))
  const wants = (userId) => settingsByUser.get(userId)?.campusAlerts !== false

  const subsRes = await fetchAllPages(
    () => scoped(client.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth')).order('id'),
    { max: AUDIENCE_MAX_ROWS },
  )
  if (subsRes.error && !isMissingTableError(subsRes.error)) throw queryError(subsRes, 'push_subscriptions select (campus alerts)')
  const devicesRes = await withDeviceColumns(({ kinds, local }) =>
    fetchAllPages(
      () =>
        scoped(
          client
            .from('push_devices')
            .select(['id, user_id, token, platform, failure_count', ...(local ? ['local_reminders'] : []), ...(kinds ? ['kinds', 'channels'] : [])].join(', ')),
        ).order('id'),
      { max: AUDIENCE_MAX_ROWS },
    ),
  )
  if (devicesRes.error && !isMissingTableError(devicesRes.error)) throw queryError(devicesRes, 'push_devices select (campus alerts)')

  return {
    subs: (subsRes.error ? [] : subsRes.data || []).filter((sub) => wants(sub.user_id)),
    devices: (devicesRes.error ? [] : devicesRes.data || []).filter((device) => wants(device.user_id)),
    quietFor: (userId) => {
      const settings = settingsByUser.get(userId) ?? settingsFromRow(null)
      return quietWindow(settings.quietStart, settings.quietEnd)
    },
  }
}

// Sends one incident's push to its audience. `payloadFor(userId)` words it per
// account (the all clear goes silent in that account's quiet hours); phones
// that share a wording go out together. Browsers whose push service says they
// are gone are deleted; phones keep their books in deliverToPushDevices.
async function broadcast({ client, keys, audience, kind, payloadFor, send, sendExpo, now, log }) {
  const outcome = { sent: 0, failed: 0, removed: 0 }
  const ttl = notificationKind(kind).ttl.seconds
  await eachLimit(audience.subs, WEB_PUSH_CONCURRENCY, async (sub) => {
    const payload = payloadFor(sub.user_id)
    const result = await send({
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      keys,
      ttl,
      urgency: kind === 'campus-alert' ? 'high' : payload.silent ? 'low' : 'normal',
      topic: payload.tag,
      now: now.getTime(),
    })
    if (result.ok) {
      outcome.sent += 1
      return
    }
    outcome.failed += 1
    if (result.gone) {
      const del = await client.from('push_subscriptions').delete().eq('id', sub.id)
      if (!del.error) outcome.removed += 1
    } else {
      log.warn(`[push] campus alert delivery failed (${result.status})`)
    }
  })
  const byWording = new Map()
  for (const device of audience.devices) {
    const payload = payloadFor(device.user_id)
    const key = JSON.stringify(payload)
    if (!byWording.has(key)) byWording.set(key, { payload, devices: [] })
    byWording.get(key).devices.push(device)
  }
  for (const group of byWording.values()) {
    const native = await deliverToPushDevices({ client, devices: group.devices, payload: group.payload, send: sendExpo, log, now })
    outcome.sent += native.sent
    outcome.failed += native.failed
    outcome.removed += native.removed
  }
  return outcome
}

// Set `column` (alert_pushed_at or clear_pushed_at) on an incident unless
// another run set it first. True when this run did, and so sends.
async function claimIncident(client, incidentId, column, now) {
  const res = await client
    .from('campus_alert_incidents')
    .update({ [column]: now.toISOString() })
    .eq('id', incidentId)
    .is(column, null)
    .select('id')
  if (res.error) throw queryError(res, `campus_alert_incidents update (${column})`)
  return (res.data || []).length > 0
}

// Whether a message joins the open incident: not after the incident's final
// (unless it is a final too), and not more than INCIDENT_IDLE_HOURS after its
// last message.
async function incidentStillRunning(client, incident, role, now) {
  const last = await client
    .from('campus_alert_messages')
    .select('role, sent_at')
    .eq('incident_id', incident.id)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (last.error) throw queryError(last, 'campus_alert_messages select (last)')
  if (last.data?.role === 'final' && role !== 'final') return false
  const lastAt = Date.parse(last.data?.sent_at ?? incident.opened_at)
  return now.getTime() - lastAt <= INCIDENT_IDLE_HOURS * 60 * 60_000
}

/**
 * One tick: read IU's message, and the first time it is seen, record it, open,
 * join or close incidents, and push what is due. Returns a summary for the
 * cron log, `seen: true` while the message is one already handled. Throws a
 * SupabaseQueryError on a database error other than the tables missing, so the
 * route can tell a hiccup worth one retry (runCronTick) from a bug.
 *
 * `readAlert()` resolves with the banner's reading ({ fetchedAt, alert }, see
 * src/campusAlert.mjs) or throws when there is none. With `campus-alert` in
 * `kindsOff` (PUSH_KINDS_OFF) incidents still open and close but nothing is
 * pushed; with `campus-all-clear`, no all clear.
 */
export async function runCampusAlertPush({
  client,
  keys,
  readAlert,
  kindsOff = new Set(),
  adminEmails = [],
  now = new Date(),
  send = sendWebPush,
  sendExpo = sendExpoPush,
  sleep = wait,
  log = console,
}) {
  const summary = { ok: true, ranAt: now.toISOString() }
  if (!keys) return { ...summary, ok: false, reason: 'no_vapid_keys' }
  let reading
  try {
    reading = await readAlert()
  } catch {
    return { ...summary, ok: false, reason: 'feed_unavailable' }
  }
  if (!reading?.alert || now.getTime() - reading.fetchedAt > STALE_AFTER_MS) return { ...summary, ok: false, reason: 'feed_stale' }
  const alert = reading.alert
  const sourceId = alert.id || (alert.sentAt ? `sent:${alert.sentAt}` : null)
  if (!sourceId) return { ...summary, ok: false, reason: 'no_message_id' }

  const seen = await client.from('campus_alert_messages').select('role').eq('source', SOURCE).eq('source_id', sourceId).maybeSingle()
  if (seen.error) {
    if (isMissingTableError(seen.error)) {
      logSchemaMissingOnce(CAMPUS_ALERT_SCHEMA, seen.error)
      return { ...summary, ok: false, reason: 'not_configured' }
    }
    throw queryError(seen, 'campus_alert_messages select')
  }
  if (seen.data) return { ...summary, seen: true }

  // A message seen for the first time.
  const sentMs = Date.parse(alert.sentAt ?? '')
  const late = !Number.isFinite(sentMs) || now.getTime() - sentMs > LATE_AFTER_MINUTES * 60_000
  const kind = messageRole(alert)
  const openRes = await client
    .from('campus_alert_incidents')
    .select('id, test, opened_at, alert_pushed_at')
    .is('closed_at', null)
    .order('opened_at', { ascending: true })
  if (openRes.error) throw queryError(openRes, 'campus_alert_incidents select')
  const open = openRes.data || []
  const closeIncidents = async (ids) => {
    if (!ids.length) return
    const res = await client.from('campus_alert_incidents').update({ closed_at: now.toISOString() }).in('id', ids).is('closed_at', null)
    if (res.error) throw queryError(res, 'campus_alert_incidents update (close)')
  }

  // What to push: [{ kind, incident }], decided before anything is claimed.
  const due = []
  let incidentId = null
  let role
  if (kind === 'normal') {
    role = 'normal'
    if (!late && !kindsOff.has('campus-all-clear')) {
      for (const incident of open) if (incident.alert_pushed_at) due.push({ kind: 'campus-all-clear', incident })
    }
    incidentId = (open.find((incident) => !incident.test) ?? open[0])?.id ?? null
  } else {
    const test = kind === 'test'
    const ownId = incidentIdFor(SOURCE, sourceId)
    const current = open.filter((incident) => incident.test === test).at(-1)
    const joins = Boolean(current) && current.id !== ownId && (await incidentStillRunning(client, current, kind, now))
    if (joins) {
      incidentId = current.id
      role = test ? 'test' : kind === 'final' ? 'final' : 'update'
    } else {
      if (current && current.id !== ownId) await closeIncidents([current.id])
      incidentId = ownId
      role = test ? 'test' : kind === 'final' ? 'final' : 'new'
      if (current?.id !== ownId) {
        const opened = await client.from('campus_alert_incidents').insert({ id: ownId, test, opened_at: iso(Number.isFinite(sentMs) ? sentMs : now.getTime()) })
        if (opened.error && opened.error.code !== '23505') throw queryError(opened, 'campus_alert_incidents insert')
      }
      if (kind !== 'final' && !late && !kindsOff.has('campus-alert')) due.push({ kind: 'campus-alert', incident: { id: ownId, test } })
    }
  }

  // The audiences first, then each claim right before its send.
  const audiences = new Map()
  const audienceFor = async (test) => {
    if (!audiences.has(test)) {
      const userIds = test ? await adminUserIds(client, adminEmails) : null
      audiences.set(test, await loadAudience(client, { userIds }))
    }
    return audiences.get(test)
  }
  for (const push of due) await audienceFor(push.incident.test)

  const totals = { sent: 0, failed: 0, removed: 0 }
  const pushed = []
  const expo = retryFailedBatchOnce(sendExpo, { sleep })
  const minute = minutesInZone(now)
  for (const push of due) {
    const column = push.kind === 'campus-alert' ? 'alert_pushed_at' : 'clear_pushed_at'
    if (!(await claimIncident(client, push.incident.id, column, now))) continue
    const audience = await audienceFor(push.incident.test)
    const payloadFor = (userId) =>
      campusAlertPayload(alert, {
        kind: push.kind,
        incidentId: push.incident.id,
        silent: push.kind === 'campus-all-clear' && isQuietMinute(minute, audience.quietFor(userId)),
      })
    const outcome = await broadcast({ client, keys, audience, kind: push.kind, payloadFor, send, sendExpo: expo, now, log })
    totals.sent += outcome.sent
    totals.failed += outcome.failed
    totals.removed += outcome.removed
    pushed.push(push.kind)
  }
  if (kind === 'normal') await closeIncidents(open.map((incident) => incident.id))

  // Last, the message itself: from here on every tick reads it as seen.
  const record = await client.from('campus_alert_messages').insert({
    source: SOURCE,
    source_id: sourceId,
    incident_id: incidentId,
    role,
    sent_at: iso(Number.isFinite(sentMs) ? sentMs : now.getTime()),
    headline: alert.headline,
  })
  if (record.error && record.error.code !== '23505') throw queryError(record, 'campus_alert_messages insert')
  return { ...summary, role, incident: incidentId, late, pushed, ...totals }
}
