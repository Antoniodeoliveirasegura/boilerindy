import express from 'express'
import { normalizeApnsToken } from '../apnsLiveActivity.mjs'
import { readCampusAlertCached } from '../campusAlert.mjs'
import { runCampusAlertPush } from '../campusAlertPush.mjs'
import { runCronTick } from '../cronTick.mjs'
import { DB_FEATURES, respondDbError, respondSchemaMissing } from '../dbErrors.mjs'
import { isMissingColumnError, runDiningFavoriteAlerts } from '../diningFavoriteAlerts.mjs'
import { fetchExpoReceipts, parsePushTokenBody, sendExpoPush } from '../expoPush.mjs'
import {
  endLiveActivity,
  liveActivitiesEnabled,
  parseActivityId,
  parseLiveActivityStart,
  runLiveActivities,
  startLiveActivity,
  updateLiveActivityToken,
} from '../liveActivities.mjs'
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
  withDeviceColumns,
} from '../pushReminders.mjs'
import { runPushReceipts } from '../pushReceipts.mjs'
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
//
// The fast tick, POST /api/internal/push/fast-tick, pushes IU's campus
// alerts (src/campusAlertPush.mjs) behind CAMPUS_ALERTS and CAMPUS_ALERT_PUSH,
// and keeps Track this bus, the app's Live Activity, current over APNs
// (src/liveActivities.mjs) once APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID are
// set. The app reports each Live Activity at /api/live-activities, signed in
// or out, which is why those routes ask for no session.

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

function liveActivityDisabled(res) {
  return res.status(503).json({
    error: { code: 'live_activity_disabled', message: 'Track this bus is not available right now.', status: 503 },
  })
}

function liveActivityGone(res, status, code) {
  return res.status(status).json({ error: { code, message: 'This bus is no longer being tracked.', status } })
}

function summarizePushSubscription(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    userAgent: row.user_agent || null,
    lastUsedAt: row.last_used_at || null,
  }
}

// What POST /api/me/push-token stored, as the app reads it back: never the
// token nor the Live Activity start token. Before README step 47 (or 54) the
// row lacks the columns and they read as false and null.
function summarizeRegistration(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    localReminders: row.local_reminders === true,
    kinds: Array.isArray(row.kinds) ? row.kinds : null,
    channels: Array.isArray(row.channels) ? row.channels : null,
    kindsVersion: Number.isInteger(row.kinds_version) ? row.kinds_version : null,
    redact: row.redact === true,
  }
}

// Never the token: like a push endpoint, it lets anyone notify the phone.
// localReminders is false for a row read before README step 47 added it, and
// kinds null before step 54 (issue #550) or for an older app build.
function summarizePushDevice(row) {
  return {
    id: row.id,
    platform: row.platform,
    deviceName: row.device_name || null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at || null,
    localReminders: row.local_reminders === true,
    kinds: Array.isArray(row.kinds) ? row.kinds : null,
  }
}

/**
 * GET /api/push/config, the public key a browser subscribes with, the kind
 * registry's version and digest (`kinds`), which the app compares with its own
 * copy's, and whether campus alerts are pushed (`campusAlertPush`) and Track
 * this bus runs (`liveActivities`), so a client offers each only where it does
 * something. server.mjs mounts this in its public reads block, before the
 * session middleware, where the route used to be registered. Paths stay
 * absolute (`/api/push/config`) so docs/RATE_LIMITS.md and its guard test read
 * the same whether a route lives here or in server.mjs.
 *
 * @param {object}      deps
 * @param {Function}    deps.publicReadIpRateLimit the per-address cap across the public reads
 * @param {Function}    deps.publicReadRateLimit   the shared public-read bucket
 * @param {object|null} deps.vapidKeys             loadVapidKeys() from src/webPush.mjs, or null when push is off
 * @param {boolean}     [deps.campusAlertPush]     CAMPUS_ALERTS and CAMPUS_ALERT_PUSH both on
 * @param {boolean}     [deps.liveActivities]      liveActivitiesEnabled() from src/liveActivities.mjs:
 *   the APNs key set, push on, and the kind not in PUSH_KINDS_OFF
 */
export function createPushPublicRouter({ publicReadIpRateLimit, publicReadRateLimit, vapidKeys, campusAlertPush = false, liveActivities = false }) {
  const router = express.Router()
  // The registry is fixed for the life of the process, so its digest is taken once.
  const kinds = notificationKindsDigest().then((digest) => ({ version: NOTIFICATION_KINDS_VERSION, digest }))

  async function handlePushConfig(_req, res) {
    res.set('Cache-Control', 'no-store')
    res.json({
      enabled: Boolean(vapidKeys),
      publicKey: vapidKeys ? vapidKeys.publicKey : null,
      kinds: await kinds,
      campusAlertPush: Boolean(vapidKeys) && campusAlertPush,
      liveActivities: Boolean(liveActivities),
    })
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
 * @param {Function}    [deps.getExpoReceipts]     fetchExpoReceipts from src/expoPush.mjs, the default
 * @param {Function}    [deps.getCached]           server.mjs's shared stale-on-failure cache, through
 *   which the fast tick reads IU's alert feed with the banner (readCampusAlertCached)
 * @param {boolean}     [deps.campusAlertPush]     CAMPUS_ALERTS and CAMPUS_ALERT_PUSH both on; off,
 *   the fast tick reads nothing
 * @param {string[]}    [deps.adminEmails]         ADMIN_EMAILS, lowercased: with users.is_admin, the
 *   accounts IU's test alerts are pushed to
 * @param {Function}    [deps.readCampusAlert]     how the fast tick reads the alert; the default reads
 *   it through getCached, and the tests hand in a fake
 * @param {Function}    deps.widgetReadIpRateLimit the per-address cap on the widgets' arrivals read,
 *   which the Live Activity routes share
 * @param {Function}    deps.widgetReadRateLimit   the widget-read bucket (issue #549)
 * @param {Function}    [deps.getCurrentUser]      server.mjs's session user, or null: the Live
 *   Activity routes take a signed-out phone too
 * @param {Function}    [deps.sendLiveActivity]    the APNs sender's send (createApnsSender in
 *   src/apnsLiveActivity.mjs), or null while APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID are unset;
 *   the tests hand in a stub
 * @param {Function}    [deps.readArrivals]        a stop's arrivals through the widgets' cache
 *   (createTransitReads in src/routes/campus.mjs), which the fast tick's Live Activities read
 */
export function createPushRouter({
  supabase,
  requireAuth,
  pushWriteRateLimit,
  pushTestRateLimit,
  widgetReadIpRateLimit,
  widgetReadRateLimit,
  vapidKeys,
  PUSH_CRON_SECRET,
  pushCronSecretMatches,
  warnCronTransient,
  getDiningSnapshot,
  kindsOff = new Set(),
  expoAccessToken = '',
  sendExpo = sendExpoPush,
  getExpoReceipts = fetchExpoReceipts,
  getCached = null,
  campusAlertPush = false,
  adminEmails = [],
  readCampusAlert = getCached ? () => readCampusAlertCached(getCached) : null,
  getCurrentUser = async () => null,
  sendLiveActivity = null,
  readArrivals = null,
}) {
  const router = express.Router()
  // Every Expo request, from the test send and the cron runs alike, carries
  // the access token; nothing else ever sees it.
  const sendToExpo = (options) => sendExpo({ ...options, accessToken: expoAccessToken })
  const receiptsFromExpo = (ids) => getExpoReceipts({ ids, accessToken: expoAccessToken })

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
        withDeviceColumns(({ kinds, local }) =>
          supabase
            .from('push_devices')
            .select(`id, platform, device_name, created_at, last_seen_at${local ? ', local_reminders' : ''}${kinds ? ', kinds' : ''}`)
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
      // Every registration replaces what the phone reported last time, so a
      // body from an older build stores no kinds (README step 54, issue #550).
      const { data, error } = await withDeviceColumns(({ kinds, local }) => {
        const row = { ...device }
        if (local) row.local_reminders = parsed.localReminders
        if (kinds) {
          Object.assign(row, {
            kinds: parsed.kinds,
            channels: parsed.channels,
            kinds_version: parsed.kindsVersion,
            redact: parsed.redact,
            activity_start_token: parsed.activityStartToken,
          })
        }
        const columns = ['id, created_at', ...(local ? ['local_reminders'] : []), ...(kinds ? ['kinds', 'channels', 'kinds_version', 'redact'] : [])]
        return supabase.from('push_devices').upsert(row, { onConflict: 'token' }).select(columns.join(', ')).single()
      })
      if (error) throw error
      res.status(201).json({ device: summarizeRegistration(data) })
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
    // Then the Expo receipts of earlier sends (issue #550, item 7), which only
    // record what Expo answers, so re-reading them is safe as well.
    const outcome = await runCronTick('run-reminders', async () => {
      const summary = await runDeadlineReminders({ client: supabase, keys: vapidKeys, sendExpo: sendToExpo, kindsOff })
      if (getDiningSnapshot) {
        summary.dining = await runDiningFavoriteAlerts({ client: supabase, keys: vapidKeys, getSnapshot: getDiningSnapshot, sendExpo: sendToExpo, kindsOff })
      }
      if (vapidKeys) summary.receipts = await runPushReceipts({ client: supabase, getReceipts: receiptsFromExpo })
      return summary
    })
    if (outcome.ok) {
      const summary = outcome.summary
      if (summary.sent || summary.failed || summary.dining?.sent || summary.dining?.failed || summary.receipts?.failed || summary.receipts?.removed) {
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

  // Track this bus (issue #550; boilerindy-app#173, item 5): the app reports
  // each Live Activity it starts, and the fast tick below keeps it current
  // over APNs (src/liveActivities.mjs). Signed in or out (decision 4 of the
  // notifications build): a signed-out phone is held to the widget-read limits
  // on its address and the activity's 30-minute life. The activity id, which
  // only the phone knows, is what PATCH and DELETE ask for. While Track this
  // bus is off, POST and PATCH answer 503 live_activity_disabled; DELETE always
  // works, since ending one is always safe.
  const liveActivitiesOn = liveActivitiesEnabled({ send: sendLiveActivity, vapidKeys, kindsOff })

  // Body { activityId, token, env, stop, routeId? }; 201 { endsAt } for a new
  // activity, 200 with the same endsAt when the app sends one again.
  router.post('/api/live-activities', widgetReadIpRateLimit, widgetReadRateLimit, async (req, res) => {
    if (!liveActivitiesOn) return liveActivityDisabled(res)
    const parsed = parseLiveActivityStart(req.body)
    if (!parsed.ok) return res.status(400).json({ error: { message: parsed.error, status: 400 } })
    try {
      const user = await getCurrentUser(req)
      const started = await startLiveActivity(supabase, parsed.activity, { userId: user?.id ?? null })
      if (started.status === 'ended') return liveActivityGone(res, 409, 'live_activity_ended')
      res.status(started.status === 'started' ? 201 : 200).json({ endsAt: started.endsAt })
    } catch (error) {
      respondDbError(res, error, DB_FEATURES.live_activities)
    }
  })

  // Body { token }: the activity's new push token, which ActivityKit can hand
  // the app while the activity runs.
  router.patch('/api/live-activities/:activityId', widgetReadIpRateLimit, widgetReadRateLimit, async (req, res) => {
    if (!liveActivitiesOn) return liveActivityDisabled(res)
    const activityId = parseActivityId(req.params.activityId)
    const token = normalizeApnsToken(req.body?.token)
    if (!activityId || !token) {
      return res.status(400).json({ error: { message: 'A Live Activity id and its push token, in hex, are required.', status: 400 } })
    }
    try {
      const updated = await updateLiveActivityToken(supabase, activityId, token)
      if (!updated) return liveActivityGone(res, 404, 'live_activity_not_found')
      res.json({ endsAt: updated.endsAt })
    } catch (error) {
      respondDbError(res, error, DB_FEATURES.live_activities)
    }
  })

  // The student ended it on the phone: no more pushes. { ended } says whether
  // an open activity had the id.
  router.delete('/api/live-activities/:activityId', widgetReadIpRateLimit, widgetReadRateLimit, async (req, res) => {
    const activityId = parseActivityId(req.params.activityId)
    if (!activityId) return res.status(400).json({ error: { message: 'A Live Activity id is required.', status: 400 } })
    try {
      res.json({ ended: await endLiveActivity(supabase, activityId) })
    } catch (error) {
      respondDbError(res, error, DB_FEATURES.live_activities)
    }
  })

  // The fast tick (issue #550), called every minute by the pg_cron job in
  // db/supabase-push-fast-tick.sql (README step 57) with the same bearer
  // token: campus alerts first (src/campusAlertPush.mjs), then the Live
  // Activities (src/liveActivities.mjs), each under its own runCronTick, so a
  // failure in one leaves the other its turn. With both off it answers at once
  // and reads nothing. A tick that comes while the last one is still sending
  // (a broadcast to every device can outlast a tick) is skipped; the lock is per
  // process, and the claims in the database cover a second instance. A
  // transient Supabase failure gets one retry, as the reminder run's does.
  const OFF = Object.freeze({ ok: false, reason: 'off' })
  let fastTickRunning = false
  router.post('/api/internal/push/fast-tick', async (req, res, next) => {
    if (!PUSH_CRON_SECRET) return next()
    if (!pushCronSecretMatches(req.get('authorization'))) {
      return res.status(401).json({ error: { message: 'Invalid cron secret.', status: 401 } })
    }
    const campusOn = campusAlertPush && Boolean(readCampusAlert)
    const liveOn = liveActivitiesOn && Boolean(readArrivals)
    if (!campusOn && !liveOn) return res.json({ campusAlerts: OFF, liveActivities: OFF })
    if (fastTickRunning) return res.json({ skipped: 'busy' })
    fastTickRunning = true
    try {
      const summary = { campusAlerts: OFF, liveActivities: OFF }
      const failures = []
      if (campusOn) {
        const outcome = await runCronTick('fast-tick', () =>
          runCampusAlertPush({ client: supabase, keys: vapidKeys, readAlert: readCampusAlert, kindsOff, adminEmails, sendExpo: sendToExpo }),
        )
        if (outcome.ok) {
          summary.campusAlerts = outcome.summary
          // A line only for a message seen for the first time: its role, the
          // incident, and the counts. Never a token or an endpoint.
          if (outcome.summary.role) console.log(`[push] campus alert: ${JSON.stringify({ ...outcome.summary, ranAt: undefined })}`)
        } else {
          failures.push(outcome)
        }
      }
      if (liveOn) {
        const outcome = await runCronTick('fast-tick live activities', () => runLiveActivities({ client: supabase, send: sendLiveActivity, readArrivals }))
        if (outcome.ok) {
          summary.liveActivities = outcome.summary
          // A line only when a push went out or failed or an activity ended:
          // counts and APNs' reason codes, never a token or an activity id.
          const live = outcome.summary
          if (live.updates || live.arriving || live.failed || Object.keys(live.ended).length) {
            console.log(`[push] live activities: ${JSON.stringify({ ...live, ranAt: undefined })}`)
          }
        } else {
          failures.push(outcome)
        }
      }
      if (!failures.length) return res.json(summary)
      for (const failure of failures) {
        if (failure.transient) warnCronTransient('POST /api/internal/push/fast-tick', failure.error)
        else console.error('POST /api/internal/push/fast-tick:', failure.error?.message || failure.error)
      }
      if (failures.every((failure) => failure.transient)) {
        return res.status(503).json({ ok: false, error: 'Fast tick skipped: upstream unavailable, the next tick will retry.' })
      }
      res.status(500).json({ ok: false, error: 'Fast tick failed.' })
    } finally {
      fastTickRunning = false
    }
  })

  return router
}
