import crypto from 'node:crypto'
import express from 'express'
import {
  isCampaignServable,
  isValidAdEventKind,
  listServableCampaigns,
  selectServableCampaign,
  toServedAd,
} from '../adServing.mjs'
import { normalizeAdvertiserSignIn, normalizeLeadInput, toAdvertiserProfile } from '../advertiserAuth.mjs'
import { CAMPAIGN_PLACEMENTS, mapCampaignRow, normalizeCampaignInput, normalizeCampaignPatch } from '../advertiserCampaign.mjs'
import {
  generateResetToken,
  hashResetToken,
  isResetTokenExpired,
  normalizeForgotPasswordInput,
  normalizeResetPasswordInput,
  resetTokenExpiry,
} from '../advertiserPasswordReset.mjs'
import { DB_FEATURES, isSchemaMissingError, respondDbError, respondSchemaMissing } from '../dbErrors.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { hashPassword, verifyPassword } from '../passwordHash.mjs'
import { SESSION_COOKIE_NAME } from '../publicReadKey.mjs'
import { DRAFT_CAMPAIGNS_CAP_MESSAGE, MAX_DRAFT_CAMPAIGNS, capCheck } from '../userWriteCaps.mjs'

// The advertiser portal (separate from student auth - see
// db/supabase-advertiser-portal.sql and docs/advertiser-portal.md) and the
// spotlight routes that serve its approved campaigns to students. Moved out of
// server.mjs as feature routers (issue #191) with the handlers unchanged apart
// from nowIso() and makeId() inlined.
//
// Isolation is the whole point: advertisers authenticate against the
// `advertisers` table and are tracked by req.session.advertiserId - NEVER
// req.session.userId. Sign-in regenerates the session, so a browser is either a
// student session or an advertiser session, never both. requireAdvertiserAuth
// gates advertiser routes; requireAuth (student) ignores advertiserId entirely.
// Two routers keep that split visible in the wiring: createAdvertiserRouter is
// never handed requireAuth, and createSpotlightRouter answers to the student
// session alone, through requireAuth. server.mjs mounts both behind the
// session middleware, back to back where the routes used to be.

const ADVERTISER_RESETS_SQL_FILE = 'db/supabase-advertiser-password-resets.sql'

// The forgot-password route answers advertiser_schema_missing too, but its log
// names the password-resets migration.
const ADVERTISER_RESETS_DB = {
  ...DB_FEATURES.advertiser,
  label: 'Password reset',
  sqlFile: ADVERTISER_RESETS_SQL_FILE,
}

function respondAdvertiserDbError(res, err) {
  return respondDbError(res, err, DB_FEATURES.advertiser)
}

function buildAdvertiserSessionPayload(advertiser, req) {
  if (!advertiser) return null
  const cookieExpires = req?.session?.cookie?.expires
  return {
    expiresAt: cookieExpires ? new Date(cookieExpires).toISOString() : null,
    advertiser: toAdvertiserProfile(advertiser),
  }
}

// Translate the camelCase fields from advertiserCampaign.mjs into DB columns.
function campaignFieldsToColumns(fields) {
  const columns = {}
  if (fields.name !== undefined) columns.name = fields.name
  if (fields.placement !== undefined) columns.placement = fields.placement
  if (fields.startsOn !== undefined) columns.starts_on = fields.startsOn
  if (fields.endsOn !== undefined) columns.ends_on = fields.endsOn
  if (fields.creative !== undefined) columns.creative = fields.creative
  if (fields.status !== undefined) columns.status = fields.status
  return columns
}

/**
 * The advertiser portal: sign-in, sign-out, the session probe, access
 * requests, the password reset and the campaigns. Sign-in, sign-out, me,
 * request-access, forgot-password and reset-password are open by design; the
 * four campaign routes sit behind requireAdvertiserAuth, defined in here, which
 * loads the advertiser named by req.session.advertiserId or answers 401, and
 * 403 for a suspended account. Paths stay absolute (`/api/advertiser/sign-in`)
 * so docs/RATE_LIMITS.md and its guard test read the same whether a route
 * lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase                         the Supabase client
 * @param {Function} deps.signInRateLimit                  the `sign-in` limiter, shared with student sign-in
 * @param {Function} deps.accountCreateRateLimit           the `account-create` limiter, shared with student registration
 * @param {Function} deps.passwordResetRateLimit           the `password-reset` limiter
 * @param {Function} deps.advertiserWriteRateLimit         the `advertiser-write` limiter, keyed by the advertiser
 * @param {Function} deps.sendAdvertiserPasswordResetEmail ({ to, resetUrl, companyName }) => { sent }, or
 *   { sent: false, skipped: true } when email is not configured (src/email.mjs)
 * @param {string}   deps.clientAppUrl                     the frontend origin the reset link points at
 * @param {boolean}  deps.isProduction                     whether an undelivered reset link must stay out of the log
 */
export function createAdvertiserRouter({
  supabase,
  signInRateLimit,
  accountCreateRateLimit,
  passwordResetRateLimit,
  advertiserWriteRateLimit,
  sendAdvertiserPasswordResetEmail,
  clientAppUrl,
  isProduction,
}) {
  const router = express.Router()

  async function getAdvertiserById(advertiserId) {
    if (!advertiserId) return null
    const { data, error } = await supabase
      .from('advertisers')
      .select('*')
      .eq('id', advertiserId)
      .single()
    if (error || !data) return null
    return data
  }

  async function getAdvertiserByEmail(email) {
    const { data, error } = await supabase
      .from('advertisers')
      .select('*')
      .eq('email', email)
      .single()
    // A "no rows" result is an expected miss, not a schema error - surface other
    // errors (e.g. table missing) to the caller.
    if (error) {
      if (error.code === 'PGRST116') return { advertiser: null, error: null }
      return { advertiser: null, error }
    }
    return { advertiser: data || null, error: null }
  }

  // Mirrors requireAuth, but reads the advertiser session key. An advertiser
  // session grants zero access to student (/api/me/*) routes and vice versa.
  async function requireAdvertiserAuth(req, res, next) {
    const advertiser = await getAdvertiserById(req.session.advertiserId)
    if (!advertiser) {
      return res.status(401).json({ error: { message: 'You must sign in to the advertiser portal.', status: 401 } })
    }
    if (advertiser.status !== 'active') {
      return res.status(403).json({ error: { message: 'This advertiser account is suspended.', status: 403 } })
    }
    req.currentAdvertiser = advertiser
    next()
  }

  router.post('/api/advertiser/sign-in', signInRateLimit, async (req, res) => {
    let credentials
    try {
      credentials = normalizeAdvertiserSignIn(req.body)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const { advertiser, error } = await getAdvertiserByEmail(credentials.email)
    if (error) return respondAdvertiserDbError(res, error)

    // Uniform message + always run verify against a real-ish hash shape to avoid
    // leaking which emails exist via response timing/content.
    const storedHash = advertiser?.password_hash || 'x:x'
    const passwordOk = verifyPassword(credentials.password, storedHash)
    if (!advertiser || !passwordOk) {
      return res.status(401).json({ error: { message: 'Invalid email or password.', status: 401 } })
    }
    if (advertiser.status !== 'active') {
      return res.status(403).json({ error: { message: 'This advertiser account is suspended.', status: 403 } })
    }

    // Regenerate wipes any prior session (including a student userId), enforcing
    // the student/advertiser split on a shared browser.
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
      }
      req.session.advertiserId = advertiser.id
      req.session.save(() => {
        res.json({ session: buildAdvertiserSessionPayload(advertiser, req) })
      })
    })
  })

  router.post('/api/advertiser/sign-out', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE_NAME)
      res.json({ ok: true })
    })
  })

  // Session probe for the advertiser portal. Like /api/session, this answers 200
  // whether or not an advertiser is signed in - a signed-out visit to /advertise
  // used to log a 401 in the browser console on every load (#157).
  // Signed out (or suspended): { authenticated: false, advertiser: null }.
  // Signed in: { authenticated: true, session: { expiresAt, advertiser } }.
  router.get('/api/advertiser/me', async (req, res) => {
    const advertiser = await getAdvertiserById(req.session.advertiserId)
    if (!advertiser || advertiser.status !== 'active') {
      return res.json({ authenticated: false, advertiser: null })
    }
    res.json({ authenticated: true, session: buildAdvertiserSessionPayload(advertiser, req) })
  })

  // Public (no auth): "Request advertiser access" from /advertise. Stores a lead
  // row reviewed manually for invite-only onboarding. Reuses the account-create
  // IP rate limiter to blunt spam.
  router.post('/api/advertiser/request-access', accountCreateRateLimit, async (req, res) => {
    let lead
    try {
      lead = normalizeLeadInput(req.body)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const { error } = await supabase.from('advertiser_leads').insert({
      id: crypto.randomUUID(),
      email: lead.email,
      company_name: lead.companyName,
      message: lead.message,
      created_at: new Date().toISOString(),
    })
    if (error) return respondAdvertiserDbError(res, error)

    res.status(201).json({ ok: true })
  })

  // ── Password reset (forgot-password) ─────────────────────────────────────────
  // Self-serve, isolated from student auth. forgot-password ALWAYS responds 200
  // (never reveals whether an email has an account); reset-password validates a
  // single-use, 1h token whose SHA-256 hash is stored in advertiser_password_resets.

  async function createAdvertiserResetToken(advertiserId) {
    const { token, tokenHash } = generateResetToken()
    const { error } = await supabase.from('advertiser_password_resets').insert({
      id: crypto.randomUUID(),
      advertiser_id: advertiserId,
      token_hash: tokenHash,
      expires_at: resetTokenExpiry(),
      created_at: new Date().toISOString(),
    })
    if (error) throw error
    return token
  }

  async function findAdvertiserResetByToken(token) {
    const { data, error } = await supabase
      .from('advertiser_password_resets')
      .select('*')
      .eq('token_hash', hashResetToken(token))
      .is('used_at', null)
      .single()
    if (error) {
      if (error.code === 'PGRST116') return { reset: null, error: null } // no matching/unused row
      return { reset: null, error }
    }
    return { reset: data || null, error: null }
  }

  router.post('/api/advertiser/forgot-password', passwordResetRateLimit, async (req, res) => {
    let input
    try {
      input = normalizeForgotPasswordInput(req.body)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const { advertiser, error } = await getAdvertiserByEmail(input.email)
    if (error) return respondAdvertiserDbError(res, error)

    // Only mint + email a token for an existing, active account - but never tell
    // the client either way (uniform 200) so the endpoint can't enumerate emails.
    if (advertiser && advertiser.status === 'active') {
      try {
        const token = await createAdvertiserResetToken(advertiser.id)
        const resetUrl = `${clientAppUrl}/advertise/reset-password?token=${encodeURIComponent(token)}`
        const result = await sendAdvertiserPasswordResetEmail({
          to: advertiser.email,
          resetUrl,
          companyName: advertiser.company_name,
        })
        // Email not configured (dev): surface the link in the server log so the
        // flow is testable without a provider (mirrors Sentry-disabled wiring).
        if (result?.skipped && !isProduction) {
          // Dev only: surface the link so the flow is testable without a provider.
          console.warn(`[advertiser reset] email disabled - reset link for ${advertiser.email}: ${resetUrl}`)
        } else if (result?.skipped) {
          // Never write a live reset token to production logs.
          console.error('[advertiser reset] email is not configured; reset link was not delivered')
        }
      } catch (sendErr) {
        if (isSchemaMissingError(sendErr)) return respondSchemaMissing(res, ADVERTISER_RESETS_DB, sendErr)
        console.error('Advertiser forgot-password failed:', sendErr?.message || sendErr)
        return res.status(500).json({ error: { message: 'Could not send the reset email. Please try again.', status: 500 } })
      }
    }

    res.json({ ok: true })
  })

  router.post('/api/advertiser/reset-password', passwordResetRateLimit, async (req, res) => {
    let input
    try {
      input = normalizeResetPasswordInput(req.body)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const { reset, error } = await findAdvertiserResetByToken(input.token)
    if (error) return respondAdvertiserDbError(res, error)
    if (!reset || isResetTokenExpired(reset.expires_at)) {
      return res.status(400).json({ error: { message: 'This reset link is invalid or has expired.', status: 400 } })
    }

    const { error: updateErr } = await supabase
      .from('advertisers')
      .update({ password_hash: hashPassword(input.password), updated_at: new Date().toISOString() })
      .eq('id', reset.advertiser_id)
    if (updateErr) return respondAdvertiserDbError(res, updateErr)

    // Burn this token AND any other outstanding tokens for the advertiser, so a
    // reset link can't be replayed and stale links stop working.
    await supabase
      .from('advertiser_password_resets')
      .update({ used_at: new Date().toISOString() })
      .eq('advertiser_id', reset.advertiser_id)
      .is('used_at', null)

    res.json({ ok: true })
  })

  // ── Campaigns (M2) ───────────────────────────────────────────────────────────
  // All campaign routes are gated by requireAdvertiserAuth and scoped to the
  // signed-in advertiser. Validation/approval-flow rules live in
  // advertiserCampaign.mjs. New campaigns start 'draft'; advertisers submit for
  // review but cannot self-activate (owner approves via scripts/review-campaign.mjs).

  async function getCampaignForAdvertiser(campaignId, advertiserId) {
    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .eq('advertiser_id', advertiserId)
      .single()
    if (error) {
      if (error.code === 'PGRST116') return { campaign: null, error: null }
      return { campaign: null, error }
    }
    return { campaign: data || null, error: null }
  }

  router.get('/api/advertiser/campaigns', requireAdvertiserAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('advertiser_id', req.currentAdvertiser.id)
      .order('created_at', { ascending: false })
    if (error) return respondAdvertiserDbError(res, error)
    res.json({ campaigns: (data || []).map(mapCampaignRow) })
  })

  router.post('/api/advertiser/campaigns', advertiserWriteRateLimit, requireAdvertiserAuth, async (req, res) => {
    let fields
    try {
      fields = normalizeCampaignInput(req.body)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const countResult = await supabase
      .from('campaigns')
      .select('id', { count: 'exact', head: true })
      .eq('advertiser_id', req.currentAdvertiser.id)
      .eq('status', 'draft')
    const cap = capCheck(countResult, MAX_DRAFT_CAMPAIGNS)
    if (cap.failure) console.error('POST /api/advertiser/campaigns:', cap.failure, countResult.error)
    if (cap.blocked) {
      return res.status(409).json({ error: { message: DRAFT_CAMPAIGNS_CAP_MESSAGE, status: 409 } })
    }

    const timestamp = new Date().toISOString()
    const { data, error } = await supabase
      .from('campaigns')
      .insert({
        id: crypto.randomUUID(),
        advertiser_id: req.currentAdvertiser.id,
        ...campaignFieldsToColumns(fields),
        status: 'draft',
        created_at: timestamp,
        updated_at: timestamp,
      })
      .select()
      .single()
    if (error) return respondAdvertiserDbError(res, error)

    res.status(201).json({ campaign: mapCampaignRow(data) })
  })

  router.patch('/api/advertiser/campaigns/:id', advertiserWriteRateLimit, requireIdParam('id'), requireAdvertiserAuth, async (req, res) => {
    const { campaign, error: lookupError } = await getCampaignForAdvertiser(req.params.id, req.currentAdvertiser.id)
    if (lookupError) return respondAdvertiserDbError(res, lookupError)
    if (!campaign) {
      return res.status(404).json({ error: { message: 'Campaign not found.', status: 404 } })
    }

    let patch
    try {
      patch = normalizeCampaignPatch(req.body, campaign)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const { data, error } = await supabase
      .from('campaigns')
      .update({ ...campaignFieldsToColumns(patch), updated_at: new Date().toISOString() })
      .eq('id', campaign.id)
      .eq('advertiser_id', req.currentAdvertiser.id)
      .select()
      .single()
    if (error) return respondAdvertiserDbError(res, error)

    res.json({ campaign: mapCampaignRow(data) })
  })

  // Aggregate impression/tap stats for one of the advertiser's own campaigns (M3).
  router.get('/api/advertiser/campaigns/:id/stats', requireIdParam('id'), requireAdvertiserAuth, async (req, res) => {
    const { campaign, error: lookupError } = await getCampaignForAdvertiser(req.params.id, req.currentAdvertiser.id)
    if (lookupError) return respondAdvertiserDbError(res, lookupError)
    if (!campaign) {
      return res.status(404).json({ error: { message: 'Campaign not found.', status: 404 } })
    }

    const [impRes, tapRes] = await Promise.all([
      supabase.from('ad_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('kind', 'impression'),
      supabase.from('ad_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('kind', 'tap'),
    ])
    if (impRes.error) return respondAdvertiserDbError(res, impRes.error)
    if (tapRes.error) return respondAdvertiserDbError(res, tapRes.error)

    const impressions = impRes.count || 0
    const taps = tapRes.count || 0
    res.json({ stats: { impressions, taps, ctr: impressions > 0 ? taps / impressions : 0 } })
  })

  return router
}

// ── Ad serving + tracking (M3) ───────────────────────────────────────────────
// Student-session routes (requireAuth), NOT advertiser-gated. They serve a single
// approved, in-window campaign into the student home dashboard and log aggregate
// impression/tap events (no student PII - see db/supabase-advertiser-ad-events.sql).
// Routed as /api/spotlight/* (not /api/ads/*) because ad-blocker filter lists
// match the ads keyword and silently block the requests for students running
// blockers. Client counterpart: boilerindy-react/src/lib/spotlightApi.js.

/**
 * The spotlight routes: the servable campaigns for a placement and the
 * impression and tap beacons, both behind requireAuth. Mounted by server.mjs
 * right after createAdvertiserRouter.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase         the Supabase client
 * @param {Function} deps.requireAuth      loads req.currentUser or answers 401
 * @param {Function} deps.adEventRateLimit the `ad-event` limiter
 * @param {Function} deps.getCached        server.mjs's TTL cache, (key, ttlMs, producer) => value,
 *   shared with the campus router
 */
export function createSpotlightRouter({ supabase, requireAuth, adEventRateLimit, getCached }) {
  const router = express.Router()

  router.get('/api/spotlight/active', requireAuth, async (req, res) => {
    const placement = CAMPAIGN_PLACEMENTS.includes(req.query.placement) ? req.query.placement : 'home-widget'
    const limit = Math.min(Math.max(Number(req.query.limit) || 1, 1), 12)
    // Active campaigns for a placement are the same for every user and change
    // rarely, so cache the row set ~60s. Date-based serving still runs per request.
    let data
    try {
      data = await getCached(`spotlight:${placement}`, 60 * 1000, async () => {
        const { data: rows, error } = await supabase
          .from('campaigns')
          .select('id, placement, status, starts_on, ends_on, creative')
          .eq('placement', placement)
          .eq('status', 'active')
        if (error) throw error
        return rows || []
      })
    } catch (error) {
      console.error('[/api/spotlight/active] query failed:', error?.message || error)
      return res.json({ ad: null, ads: [] })
    }
    const today = new Date().toISOString().slice(0, 10)
    if (limit > 1) {
      const ads = listServableCampaigns(data, today, limit).map(toServedAd).filter(Boolean)
      return res.json({ ads, ad: ads[0] || null })
    }
    const selected = selectServableCampaign(data, today)
    const ad = toServedAd(selected)
    res.json({ ad, ads: ad ? [ad] : [] })
  })

  router.post('/api/spotlight/:campaignId/event', adEventRateLimit, requireIdParam('campaignId'), requireAuth, async (req, res) => {
    const kind = req.body?.kind
    if (!isValidAdEventKind(kind)) {
      return res.status(400).json({ error: { message: 'Invalid ad event kind.', status: 400 } })
    }

    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('id, status, starts_on, ends_on')
      .eq('id', req.params.campaignId)
      .maybeSingle()

    if (campaignError) {
      console.error('[/api/spotlight/event] campaign lookup failed:', campaignError?.message || campaignError)
      return res.status(202).json({ ok: false })
    }

    const today = new Date().toISOString().slice(0, 10)
    if (!isCampaignServable(campaign, today)) {
      return res.status(400).json({ error: { message: 'Campaign is not active.', status: 400 } })
    }

    const { error } = await supabase.from('ad_events').insert({
      id: crypto.randomUUID(),
      campaign_id: req.params.campaignId,
      kind,
      occurred_at: new Date().toISOString(),
    })
    // Best-effort logging: an invalid campaign id or missing table shouldn't surface
    // to the student. Log and accept.
    if (error) {
      console.error('[/api/spotlight/event] insert failed:', error?.message || error)
      return res.status(202).json({ ok: false })
    }
    res.status(204).end()
  })

  return router
}
