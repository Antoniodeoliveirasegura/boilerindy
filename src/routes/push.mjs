import express from 'express'
import { runCronTick } from '../cronTick.mjs'
import { DB_FEATURES, respondSchemaMissing } from '../dbErrors.mjs'
import { isMissingColumnError, runDiningFavoriteAlerts } from '../diningFavoriteAlerts.mjs'
import { parsePushTokenBody, sendExpoPush } from '../expoPush.mjs'
import {
  KIND_SETTING_COLUMNS,
  buildTestPayload,
  deliverToPushDevices,
  isMissingTableError,
  loadPushDevices,
  parseSettingsPatch,
  runDeadlineReminders,
  settingsConflict,
  settingsFromRow,
  withLocalRemindersColumn,
} from '../pushReminders.mjs'
import { NOTIFICATION_KINDS_VERSION, notificationKindsDigest } from '../notificationKinds.mjs'
import { isValidSubscription, sendWebPush } from '../webPush.mjs'

// Push notifications (issue #9): Web Push subscriptions, settings, test sends
// and the deadline reminder cron route. See docs/push-notifications.md.
// Without VAPID keys every route reports enabled:false and nothing is ever
// sent. Tables: db/supabase-push.sql, and until that runs the routes answer
// 503 push_not_configured instead of failing. Moved out of server.mjs as a
// feature router (issue #191) with the handlers unchanged apart from nowIso()
// inlined. Two routers, because GET /api/push/config is one of the
// session-free public reads registered ahead of the session middleware
// (issue #250).
//
// The native app's Expo push tokens (issue #194) register at
// /api/me/push-token, the path the app already calls, into push_devices
// (db/supabase-push-devices.sql). They live here rather than in the /api/me
// router because they share this router's tables, limiter and answers, as the
// other /api/me/<feature> routes live with their feature. The settings,
// the test send and the reminders cover both kinds of device, except that a
// phone registered with localReminders: true gets no deadline reminders
// (Antoniodeoliveirasegura/boilerindy-app#55, see src/pushReminders.mjs).
//
// Every notification is a kind of the kind registry (src/notificationKinds.mjs,
// issue #550). The public config reports the registry's version and digest,
// the kinds PUSH_KINDS_OFF names are not sent, and every Expo request carries
// EXPO_ACCESS_TOKEN when it is set.

const PUSH_MAX_SUBSCRIPTIONS_PER_USER = 10
const PUSH_MAX_DEVICES_PER_USER = 10
const PUSH_SQL_FILE = 'db/supabase-push.sql (issue #9)'
const PUSH_DEVICES_SQL_FILE = 'db/supabase-push-devices.sql (issue #194)'

function pushNotConfigured(res, sqlFile = PUSH_SQL_FILE) {
  return res.status(503).json({
    error: {
      code: 'push_not_configured',
      message: `Push notifications are not set up on this server yet. Run ${sqlFile}.`,
      status: 503,
    },
  })
}

function pushDisabledResponse(res) {
  return res.status(503).json({
    error: { code: 'push_disabled', message: 'Push notifications are switched off on this server.', status: 503 },
  })
}

function pushKindOffResponse(res) {
  return res.status(503).json({
    error: { code: 'push_kind_off', message: 'Test notifications are switched off on this server.', status: 503 },
  })
}

function summarizePushSubscription(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    userAgent: row.user_agent || null,
    lastUsedAt: row.last_used_at || null,
  }
}

// Never the token: like a push endpoint, it lets anyone notify the phone.
// localReminders is false for a row read before README step 47 added it.
function summarizePushDevice(row) {
  return {
    id: row.id,
    platform: row.platform,
    deviceName: row.device_name || null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at || null,
    localReminders: row.local_reminders === true,
  }
}

/**
 * GET /api/push/config, the public key a browser subscribes with, and the
 * kind registry's version and digest (`kinds`), which the app compares with
 * its own copy's. server.mjs mounts this in its public reads block, before the
 * session middleware, where the route used to be registered. Paths stay
 * absolute (`/api/push/config`) so docs/RATE_LIMITS.md and its guard test read
 * the same whether a route lives here or in server.mjs.
 *
 * @param {object}      deps
 * @param {Function}    deps.publicReadIpRateLimit the per-address cap across the public reads
 * @param {Function}    deps.publicReadRateLimit   the shared public-read bucket
 * @param {object|null} deps.vapidKeys             loadVapidKeys() from src/webPush.mjs, or null when push is off
 */
export function createPushPublicRouter({ publicReadIpRateLimit, publicReadRateLimit, vapidKeys }) {
  const router = express.Router()
  // The registry is fixed for the life of the process, so its digest is taken once.
  const kinds = notificationKindsDigest().then((digest) => ({ version: NOTIFICATION_KINDS_VERSION, digest }))

  async function handlePushConfig(_req, res) {
    res.set('Cache-Control', 'no-store')
    res.json({ enabled: Boolean(vapidKeys), publicKey: vapidKeys ? vapidKeys.publicKey : null, kinds: await kinds })
  }

  router.get('/api/push/config', publicReadIpRateLimit, publicReadRateLimit, handlePushConfig)

  return router
}

/**
 * The push settings, subscription and test-send routes, behind the session,
 * and the reminder runner the Supabase pg_cron job calls with the cron bearer
 * token, mounted by server.mjs where they used to be.
 *
 * @param {object}      deps
 * @param {object}      deps.supabase              the Supabase client
 * @param {Function}    deps.requireAuth           loads req.currentUser or answers 401
 * @param {Function}    deps.pushWriteRateLimit    the settings and subscription write limiter
 * @param {Function}    deps.pushTestRateLimit     the test-send limiter
 * @param {object|null} deps.vapidKeys             loadVapidKeys() from src/webPush.mjs, or null when push is off
 * @param {string}      deps.PUSH_CRON_SECRET      the cron bearer token; empty leaves the cron route to the 404
 * @param {Function}    deps.pushCronSecretMatches checks an Authorization header against it
 * @param {Function}    deps.warnCronTransient     server.mjs's warning for a transient failure that
 *   survived the tick's retry; the source re-sync route uses these three too
 * @param {Set<string>} [deps.kindsOff]            the kinds PUSH_KINDS_OFF stops (kindsOffFromSetting
 *   in src/notificationKinds.mjs); none by default
 * @param {string}      [deps.expoAccessToken]     EXPO_ACCESS_TOKEN, sent with every Expo request when set
 * @param {Function}    [deps.sendExpo]            sendExpoPush from src/expoPush.mjs, the default;
 *   the tests hand in a fake so nothing reaches Expo
 */
export function createPushRouter({
  supabase,
  requireAuth,
  pushWriteRateLimit,
  pushTestRateLimit,
  vapidKeys,
  PUSH_CRON_SECRET,
  pushCronSecretMatches,
  warnCronTransient,
  getDiningSnapshot,
  kindsOff = new Set(),
  expoAccessToken = '',
  sendExpo = sendExpoPush,
}) {
  const router = express.Router()
  // Every Expo request, from the test send and the cron runs alike, carries
  // the access token; nothing else ever sees it.
  const sendToExpo = (options) => sendExpo({ ...options, accessToken: expoAccessToken })

  // The favorite-dish switch (issue #469) and the choices by kind (issue #550)
  // are columns that db/supabase-dining-favorite-alerts.sql (README step 42)
  // and db/supabase-push-kinds.sql (step 53) add. Until they run the settings
  // still load without them, and `diningAlertsAvailable` and `kindsAvailable`
  // say so: each read names the columns of the steps it assumes, the most
  // first, and falls back while a column is missing.
  async function loadPushSettingsRow(userId) {
    const query = (columns) => supabase.from('push_settings').select(columns.join(', ')).eq('user_id', userId).maybeSingle()
    const attempts = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ]
    for (const [i, [dining, kinds]] of attempts.entries()) {
      const columns = ['deadline_reminders', 'lead_minutes', ...(dining ? ['dining_favorite_alerts'] : []), ...(kinds ? KIND_SETTING_COLUMNS : [])]
      const { data, error } = await query(columns)
      if (!error) return { row: data, diningAlertsAvailable: dining, kindsAvailable: kinds }
      if (!isMissingColumnError(error) || i === attempts.length - 1) throw error
    }
  }

  router.get('/api/push/settings', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const [{ row: settingsRow, diningAlertsAvailable, kindsAvailable }, subsRes, devicesRes] = await Promise.all([
        loadPushSettingsRow(userId),
        supabase
          .from('push_subscriptions')
          .select('id, created_at, user_agent, last_used_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: true }),
        withLocalRemindersColumn((withFlag) =>
          supabase
            .from('push_devices')
            .select(`id, platform, device_name, created_at, last_seen_at${withFlag ? ', local_reminders' : ''}`)
            .eq('user_id', userId)
            .order('created_at', { ascending: true }),
        ),
      ])
      if (subsRes.error) throw subsRes.error
      // Before db/supabase-push-devices.sql runs the student simply has no
      // phones yet; the browser settings keep working. Before README step 47
      // the phones are listed without the column, as localReminders false.
      if (devicesRes.error && !isMissingTableError(devicesRes.error)) throw devicesRes.error
      res.set('Cache-Control', 'no-store')
      res.json({
        enabled: Boolean(vapidKeys),
        settings: settingsFromRow(settingsRow),
        diningAlertsAvailable,
        kindsAvailable,
        subscriptions: (subsRes.data || []).map(summarizePushSubscription),
        devices: devicesRes.error ? [] : (devicesRes.data || []).map(summarizePushDevice),
      })
    } catch (error) {
      if (isMissingTableError(error)) return pushNotConfigured(res)
      console.error('GET /api/push/settings:', error?.message || error)
      res.status(500).json({ error: { message: 'Could not load notification settings.', status: 500 } })
    }
  })

  router.put('/api/push/settings', pushWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const parsed = parseSettingsPatch(req.body)
    if (!parsed.ok) return res.status(400).json({ error: { message: parsed.error, status: 400 } })
    try {
      const { row: currentRow, diningAlertsAvailable, kindsAvailable } = await loadPushSettingsRow(userId)
      if ('dining_favorite_alerts' in parsed.patch && !diningAlertsAvailable) {
        return respondSchemaMissing(res, DB_FEATURES.dining_alerts, { code: '42703', message: 'push_settings.dining_favorite_alerts does not exist' })
      }
      if (parsed.kinds && !kindsAvailable) {
        return respondSchemaMissing(res, DB_FEATURES.push_kinds, { code: '42703', message: 'push_settings.digest_minute does not exist' })
      }
      const current = settingsFromRow(currentRow)
      const value = (column, saved) => (column in parsed.patch ? parsed.patch[column] : saved)
      const row = {
        user_id: userId,
        deadline_reminders: value('deadline_reminders', current.deadlineReminders),
        lead_minutes: value('lead_minutes', current.leadMinutes),
        updated_at: new Date().toISOString(),
      }
      if (diningAlertsAvailable) row.dining_favorite_alerts = value('dining_favorite_alerts', current.diningFavoriteAlerts)
      if (kindsAvailable) {
        Object.assign(row, {
          class_reminders: value('class_reminders', current.classReminders),
          class_lead_minutes: value('class_lead_minutes', current.classLeadMinutes),
          digest_minute: value('digest_minute', current.digestMinute),
          deadline_items: value('deadline_items', current.deadlineItems),
          quiet_start: value('quiet_start', current.quietStart),
          quiet_end: value('quiet_end', current.quietEnd),
          campus_alerts: value('campus_alerts', current.campusAlerts),
          // Set once, by the first phone on an app build with kinds, which
          // fills in the account from the old switches (boilerindy-app#172).
          kinds_migrated_at: currentRow?.kinds_migrated_at ?? (parsed.patch.kinds_migrated_at ? new Date().toISOString() : null),
        })
        const conflict = settingsConflict(settingsFromRow(row))
        if (conflict) return res.status(400).json({ error: { message: conflict, status: 400 } })
      }
      const { error } = await supabase.from('push_settings').upsert(row, { onConflict: 'user_id' })
      if (error) throw error
      res.json({ settings: settingsFromRow(row), diningAlertsAvailable, kindsAvailable })
    } catch (error) {
      if (isMissingTableError(error)) return pushNotConfigured(res)
      console.error('PUT /api/push/settings:', error?.message || error)
      res.status(500).json({ error: { message: 'Could not save notification settings.', status: 500 } })
    }
  })

  router.post('/api/push/subscriptions', pushWriteRateLimit, requireAuth, async (req, res) => {
    if (!vapidKeys) return pushDisabledResponse(res)
    const userId = req.currentUser.id
    const subscription = req.body?.subscription
    if (!isValidSubscription(subscription)) {
      return res.status(400).json({
        error: { message: 'A valid push subscription (https endpoint, p256dh and auth keys) is required.', status: 400 },
      })
    }
    const userAgent = (
      typeof req.body?.userAgent === 'string' ? req.body.userAgent : req.get('user-agent') || ''
    ).slice(0, 300)
    const expiration = Number.isFinite(subscription.expirationTime)
      ? new Date(subscription.expirationTime).toISOString()
      : null
    try {
      const existingRes = await supabase.from('push_subscriptions').select('id, endpoint').eq('user_id', userId)
      if (existingRes.error) throw existingRes.error
      const existing = existingRes.data || []
      const known = existing.some((row) => row.endpoint === subscription.endpoint)
      if (!known && existing.length >= PUSH_MAX_SUBSCRIPTIONS_PER_USER) {
        return res.status(409).json({
          error: {
            message: `You can register at most ${PUSH_MAX_SUBSCRIPTIONS_PER_USER} devices. Turn notifications off on an old device first.`,
            status: 409,
          },
        })
      }
      const { data, error } = await supabase
        .from('push_subscriptions')
        .upsert(
          {
            user_id: userId,
            endpoint: subscription.endpoint,
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
            expiration_time: expiration,
            user_agent: userAgent || null,
            last_used_at: new Date().toISOString(),
            failure_count: 0,
          },
          { onConflict: 'endpoint' },
        )
        .select('id, created_at')
        .single()
      if (error) throw error
      res.status(201).json({ subscription: { id: data.id, createdAt: data.created_at } })
    } catch (error) {
      if (isMissingTableError(error)) return pushNotConfigured(res)
      console.error('POST /api/push/subscriptions:', error?.message || error)
      res.status(500).json({ error: { message: 'Could not register this device.', status: 500 } })
    }
  })

  router.delete('/api/push/subscriptions', pushWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const endpoint = req.body?.endpoint
    if (typeof endpoint !== 'string' || !endpoint) {
      return res.status(400).json({ error: { message: 'endpoint is required.', status: 400 } })
    }
    try {
      const { data, error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('endpoint', endpoint)
        .select('id')
      if (error) throw error
      res.json({ removed: (data || []).length > 0 })
    } catch (error) {
      if (isMissingTableError(error)) return pushNotConfigured(res)
      console.error('DELETE /api/push/subscriptions:', error?.message || error)
      res.status(500).json({ error: { message: 'Could not remove this device.', status: 500 } })
    }
  })

  // The native app (issue #194). Body { token, platform, deviceName?,
  // localReminders? }, the token an ExponentPushToken[...]. Upserts by token,
  // so registering again refreshes last_seen_at, clears the strikes and
  // replaces localReminders, and a phone that signs in to another account
  // moves to that student. It also makes sure the student has a push_settings
  // row (the defaults, never overwriting a saved choice): the reminder runner
  // only reads students who have one.
  //
  // localReminders (Antoniodeoliveirasegura/boilerindy-app#55): true while the
  // app schedules the student's reminders on the phone, so the reminder run
  // sends it no deadline reminders; a body without it stores false. Before
  // README step 47 adds the column the phone registers without it, the log
  // names the file once, and the answer's localReminders says false, which is
  // how the reminder run treats the phone until then.
  router.post('/api/me/push-token', pushWriteRateLimit, requireAuth, async (req, res) => {
    if (!vapidKeys) return pushDisabledResponse(res)
    const userId = req.currentUser.id
    const parsed = parsePushTokenBody(req.body)
    if (!parsed.ok) return res.status(400).json({ error: { message: parsed.error, status: 400 } })
    try {
      const settingsRes = await supabase
        .from('push_settings')
        .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true })
      if (settingsRes.error) throw settingsRes.error
    } catch (error) {
      if (isMissingTableError(error)) return pushNotConfigured(res)
      console.error('POST /api/me/push-token:', error?.message || error)
      return res.status(500).json({ error: { message: 'Could not register this device.', status: 500 } })
    }
    try {
      const existingRes = await supabase.from('push_devices').select('id, token').eq('user_id', userId)
      if (existingRes.error) throw existingRes.error
      const existing = existingRes.data || []
      const known = existing.some((row) => row.token === parsed.token)
      if (!known && existing.length >= PUSH_MAX_DEVICES_PER_USER) {
        return res.status(409).json({
          error: {
            message: `You can register at most ${PUSH_MAX_DEVICES_PER_USER} devices. Turn notifications off on an old device first.`,
            status: 409,
          },
        })
      }
      const device = {
        user_id: userId,
        kind: 'expo',
        token: parsed.token,
        platform: parsed.platform,
        device_name: parsed.deviceName,
        last_seen_at: new Date().toISOString(),
        failure_count: 0,
      }
      const { data, error } = await withLocalRemindersColumn((withFlag) =>
        supabase
          .from('push_devices')
          .upsert(withFlag ? { ...device, local_reminders: parsed.localReminders } : device, { onConflict: 'token' })
          .select(withFlag ? 'id, created_at, local_reminders' : 'id, created_at')
          .single(),
      )
      if (error) throw error
      res.status(201).json({ device: { id: data.id, createdAt: data.created_at, localReminders: data.local_reminders === true } })
    } catch (error) {
      if (isMissingTableError(error)) return pushNotConfigured(res, PUSH_DEVICES_SQL_FILE)
      console.error('POST /api/me/push-token:', error?.message || error)
      res.status(500).json({ error: { message: 'Could not register this device.', status: 500 } })
    }
  })

  router.delete('/api/me/push-token', pushWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const token = req.body?.token
    if (typeof token !== 'string' || !token) {
      return res.status(400).json({ error: { message: 'token is required.', status: 400 } })
    }
    try {
      const { data, error } = await supabase
        .from('push_devices')
        .delete()
        .eq('user_id', userId)
        .eq('token', token)
        .select('id')
      if (error) throw error
      res.json({ removed: (data || []).length > 0 })
    } catch (error) {
      if (isMissingTableError(error)) return pushNotConfigured(res, PUSH_DEVICES_SQL_FILE)
      console.error('DELETE /api/me/push-token:', error?.message || error)
      res.status(500).json({ error: { message: 'Could not remove this device.', status: 500 } })
    }
  })

  // `payloadFor(device)` words the push for each device: null for a browser,
  // else the phone's push_devices row. The phones that share a wording go out
  // in one Expo request.
  async function deliverPushToUser(userId, payloadFor, { topic = null } = {}) {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, failure_count')
      .eq('user_id', userId)
    if (error) throw error
    // The student's phones (issue #194), read before anything is sent so a
    // database error fails the request cleanly. Every one of them, local
    // reminders or not: only the deadline reminders leave those phones out.
    const loaded = await loadPushDevices(supabase, [userId])
    const outcome = { sent: 0, failed: 0, removed: loaded.removed }
    const payload = payloadFor(null)
    for (const row of data || []) {
      const result = await sendWebPush({
        subscription: { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
        keys: vapidKeys,
        topic,
      })
      if (result.ok) {
        outcome.sent += 1
        await supabase.from('push_subscriptions').update({ last_used_at: new Date().toISOString(), failure_count: 0 }).eq('id', row.id)
        continue
      }
      outcome.failed += 1
      if (result.gone) {
        await supabase.from('push_subscriptions').delete().eq('id', row.id)
        outcome.removed += 1
      } else {
        console.warn(`[push] delivery failed (${result.status}): ${result.error}`)
        await supabase
          .from('push_subscriptions')
          .update({ failure_count: (row.failure_count || 0) + 1 })
          .eq('id', row.id)
      }
    }
    // Then the phones, with the same strike and removal bookkeeping as the
    // reminder runner.
    const byWording = new Map()
    for (const device of loaded.devices) {
      const devicePayload = payloadFor(device)
      const key = JSON.stringify(devicePayload)
      if (!byWording.has(key)) byWording.set(key, { payload: devicePayload, devices: [] })
      byWording.get(key).devices.push(device)
    }
    for (const group of byWording.values()) {
      const native = await deliverToPushDevices({ client: supabase, devices: group.devices, payload: group.payload, send: sendToExpo })
      outcome.sent += native.sent
      outcome.failed += native.failed
      outcome.removed += native.removed
    }
    return outcome
  }

  // The test push says what each device gets (issue #550, item 2): a phone
  // with local reminders on hears that its reminders come from the phone.
  const testPayloadFor = (device) =>
    buildTestPayload(device ? { localReminders: device.local_reminders === true, platform: device.platform ?? null } : {})

  router.post('/api/push/test', pushTestRateLimit, requireAuth, async (req, res) => {
    if (!vapidKeys) return pushDisabledResponse(res)
    if (kindsOff.has('test')) return pushKindOffResponse(res)
    try {
      const outcome = await deliverPushToUser(req.currentUser.id, testPayloadFor, { topic: 'test' })
      res.json(outcome)
    } catch (error) {
      if (isMissingTableError(error)) return pushNotConfigured(res)
      console.error('POST /api/push/test:', error?.message || error)
      res.status(500).json({ error: { message: 'Could not send a test notification.', status: 500 } })
    }
  })

  // Called by the Supabase pg_cron job in db/supabase-push.sql every 5 minutes.
  // Bearer token, not a session: PUSH_CRON_SECRET. With the secret unset the
  // route falls through to the JSON 404, so nothing can trigger sends by accident.
  // A transient Supabase failure gets one retry (runCronTick); re-running the
  // tick is safe because every delivery is claimed in push_deliveries first.
  router.post('/api/internal/push/run-reminders', async (req, res, next) => {
    if (!PUSH_CRON_SECRET) return next()
    if (!pushCronSecretMatches(req.get('authorization'))) {
      return res.status(401).json({ error: { message: 'Invalid cron secret.', status: 401 } })
    }
    // The favorite-dish alerts (issue #469) ride the same tick; re-running a
    // tick is safe for them too, since each student is claimed once a day.
    const outcome = await runCronTick('run-reminders', async () => {
      const summary = await runDeadlineReminders({ client: supabase, keys: vapidKeys, sendExpo: sendToExpo, kindsOff })
      if (getDiningSnapshot) {
        summary.dining = await runDiningFavoriteAlerts({ client: supabase, keys: vapidKeys, getSnapshot: getDiningSnapshot, sendExpo: sendToExpo, kindsOff })
      }
      return summary
    })
    if (outcome.ok) {
      const summary = outcome.summary
      if (summary.sent || summary.failed || summary.dining?.sent || summary.dining?.failed) {
        console.log(`[push] reminders: ${JSON.stringify(summary)}`)
      }
      return res.json(summary)
    }
    if (outcome.transient) {
      warnCronTransient('POST /api/internal/push/run-reminders', outcome.error)
      return res.status(503).json({ ok: false, error: 'Reminder run skipped: upstream unavailable, the next tick will retry.' })
    }
    console.error('POST /api/internal/push/run-reminders:', outcome.error?.message || outcome.error)
    res.status(500).json({ ok: false, error: 'Reminder run failed.' })
  })

  return router
}
