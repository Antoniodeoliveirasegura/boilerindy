import express from 'express'
import { runCronTick } from '../cronTick.mjs'
import {
  buildTestPayload,
  isMissingTableError,
  parseSettingsPatch,
  runDeadlineReminders,
  settingsFromRow,
} from '../pushReminders.mjs'
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

const PUSH_MAX_SUBSCRIPTIONS_PER_USER = 10

function pushNotConfigured(res) {
  return res.status(503).json({
    error: {
      code: 'push_not_configured',
      message: 'Push notifications are not set up on this server yet. Run db/supabase-push.sql (issue #9).',
      status: 503,
    },
  })
}

function pushDisabledResponse(res) {
  return res.status(503).json({
    error: { code: 'push_disabled', message: 'Push notifications are switched off on this server.', status: 503 },
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

/**
 * GET /api/push/config, the public key a browser subscribes with. server.mjs
 * mounts this in its public reads block, before the session middleware, where
 * the route used to be registered. Paths stay absolute (`/api/push/config`)
 * so docs/RATE_LIMITS.md and its guard test read the same whether a route
 * lives here or in server.mjs.
 *
 * @param {object}      deps
 * @param {Function}    deps.publicReadIpRateLimit the per-address cap across the public reads
 * @param {Function}    deps.publicReadRateLimit   the shared public-read bucket
 * @param {object|null} deps.vapidKeys             loadVapidKeys() from src/webPush.mjs, or null when push is off
 */
export function createPushPublicRouter({ publicReadIpRateLimit, publicReadRateLimit, vapidKeys }) {
  const router = express.Router()

  function handlePushConfig(_req, res) {
    res.set('Cache-Control', 'no-store')
    res.json({ enabled: Boolean(vapidKeys), publicKey: vapidKeys ? vapidKeys.publicKey : null })
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
}) {
  const router = express.Router()

  async function loadPushSettingsRow(userId) {
    const { data, error } = await supabase
      .from('push_settings')
      .select('deadline_reminders, lead_minutes')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  router.get('/api/push/settings', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const [settingsRow, subsRes] = await Promise.all([
        loadPushSettingsRow(userId),
        supabase
          .from('push_subscriptions')
          .select('id, created_at, user_agent, last_used_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: true }),
      ])
      if (subsRes.error) throw subsRes.error
      res.set('Cache-Control', 'no-store')
      res.json({
        enabled: Boolean(vapidKeys),
        settings: settingsFromRow(settingsRow),
        subscriptions: (subsRes.data || []).map(summarizePushSubscription),
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
      const current = settingsFromRow(await loadPushSettingsRow(userId))
      const row = {
        user_id: userId,
        deadline_reminders:
          'deadline_reminders' in parsed.patch ? parsed.patch.deadline_reminders : current.deadlineReminders,
        lead_minutes: 'lead_minutes' in parsed.patch ? parsed.patch.lead_minutes : current.leadMinutes,
        updated_at: new Date().toISOString(),
      }
      const { error } = await supabase.from('push_settings').upsert(row, { onConflict: 'user_id' })
      if (error) throw error
      res.json({ settings: settingsFromRow(row) })
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

  async function deliverPushToUser(userId, payload, { topic = null } = {}) {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, failure_count')
      .eq('user_id', userId)
    if (error) throw error
    const outcome = { sent: 0, failed: 0, removed: 0 }
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
    return outcome
  }

  router.post('/api/push/test', pushTestRateLimit, requireAuth, async (req, res) => {
    if (!vapidKeys) return pushDisabledResponse(res)
    try {
      const outcome = await deliverPushToUser(req.currentUser.id, buildTestPayload(), { topic: 'test' })
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
    const outcome = await runCronTick('run-reminders', () => runDeadlineReminders({ client: supabase, keys: vapidKeys }))
    if (outcome.ok) {
      const summary = outcome.summary
      if (summary.sent || summary.failed) console.log(`[push] reminders: ${JSON.stringify(summary)}`)
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
