import 'dotenv/config'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as Sentry from '@sentry/node'
import { scrubSentryEvent } from './src/sentryScrub.mjs'

// Error tracking (issue #50). Plain error capture only (no auto-tracing, which
// would need a pre-import hook). A missing DSN means Sentry is fully disabled —
// zero events in local dev; the human step is setting SENTRY_DSN on the host.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    sendDefaultPii: false,
    tracesSampleRate: 0, // errors only — keeps the free tier roomy
    beforeSend: scrubSentryEvent,
  })
}

import express from 'express'
import session from 'express-session'
import ical from 'node-ical'
import { createClient } from '@supabase/supabase-js'
import { cancelCalendarCapture, getCalendarCaptureJob, startCalendarCapture } from './src/purdueCalendarAutomation.mjs'
import { getDiningSnapshot } from './src/nutrisliceDining.mjs'
import { normalizeItemName } from './src/diningFavorites.mjs'
import {
  assertBoardPostTextAllowed,
  boardTextFailsPolicy,
  BOARD_PROFANITY_USER_MESSAGE,
} from './src/boardProfanity.mjs'
import { createRateLimiter } from './src/rateLimiter.mjs'
import { planSync, classifyFetchError, detectTimezoneFromFeed, expandRecurringEvents, icalText } from './src/scheduleSync.mjs'
import { createCalendarItemStore } from './src/calendarItemStore.mjs'
import { buildCalendarFeed } from './src/icsFeed.mjs'
import { hasFreeFood } from './src/freeFood.mjs'
import { normalizeLayout, defaultLayout } from './src/dashboardLayout.mjs'
import {
  LETTER_GRADES,
  MAX_COURSE_NAME,
  MAX_TERM_NAME,
  MAX_CREDIT_HOURS,
  DEFAULT_CREDIT_HOURS,
  DEFAULT_TERM,
} from './src/gradeTracker.mjs'
import { getProgram } from './src/degreePrograms.mjs'
import { validateGuideInput, mapGuideRow } from './src/guideRecommendations.mjs'
import { validateStudyGroupInput, normalizeCourseCode, coursesFromClassItems } from './src/studyGroups.mjs'
import { validateDealInput, mapDealRow, isDealActive } from './src/campusDeals.mjs'
import { normalizeAnalyticsBatch } from './src/analytics.mjs'
import { verifyPassword, hashPassword } from './src/passwordHash.mjs'
import { hasLegacyHash, resolveSignIn, applyPasswordChange } from './src/studentPasswordAuth.mjs'
import {
  normalizeAdvertiserSignIn,
  normalizeLeadInput,
  normalizeAdvertiserAccountInput,
  toAdvertiserProfile,
} from './src/advertiserAuth.mjs'
import {
  normalizeCampaignInput,
  normalizeCampaignPatch,
  mapCampaignRow,
  CAMPAIGN_PLACEMENTS,
  CAMPAIGN_STATUSES,
} from './src/advertiserCampaign.mjs'
import {
  isValidAdEventKind,
  isCampaignServable,
  selectServableCampaign,
  listServableCampaigns,
  toServedAd,
  summarizeAdEvents,
} from './src/adServing.mjs'
import { assertSafeHttpUrl } from './src/urlSafety.mjs'
import {
  LEAD_STATUSES,
  mapLeadRow,
  mapAdminAdvertiserRow,
  mapAdminCampaignRow,
  normalizeLeadStatusInput,
  normalizeAdminCampaignStatusInput,
  parseAdminListFilter,
} from './src/adminPortal.mjs'
import {
  normalizeForgotPasswordInput,
  normalizeResetPasswordInput,
  generateResetToken,
  hashResetToken,
  resetTokenExpiry,
  isResetTokenExpired,
} from './src/advertiserPasswordReset.mjs'
import { sendAdvertiserPasswordResetEmail } from './src/email.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TERM_ORDER = { spring: 1, summer: 2, fall: 3 }
const isProduction = process.env.NODE_ENV === 'production'

const app = express()
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '127.0.0.1'
const publicBaseUrl = (process.env.BACKEND_PUBLIC_URL || process.env.BETTER_AUTH_URL || `http://${host}:${port}`).replace(/\/$/, '')
const clientAppUrl = (process.env.CLIENT_APP_URL || 'http://localhost:5173').replace(/\/$/, '')
const purdueAuthMode = (process.env.PURDUE_AUTH_MODE || 'mock').toLowerCase()
// 'off' disables Purdue identity linking entirely (e.g. before CAS is wired):
// the connect UI is hidden, onboarding stops prompting a link, and calendar
// sources (Brightspace / Purdue timetable iCal) no longer require a linked
// Purdue identity. 'mock' = dev email-link; 'cas' = real Purdue CAS.
const purdueLinkingEnabled = purdueAuthMode !== 'off'
const defaultNextPath = '/setup'
const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
)

if (isProduction || process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1)
}

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables')
  console.error('Please set these in your .env file:')
  console.error('  SUPABASE_URL=https://your-project.supabase.co')
  console.error('  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

const sessionSecret = process.env.SESSION_SECRET || process.env.BETTER_AUTH_SECRET
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

if (isProduction) {
  if (!sessionSecret) {
    console.error('ERROR: SESSION_SECRET is required in production')
    process.exit(1)
  }
  if (!supabaseAnonKey) {
    console.error('ERROR: SUPABASE_ANON_KEY is required in production')
    process.exit(1)
  }
  if (purdueAuthMode === 'mock') {
    console.error('ERROR: PURDUE_AUTH_MODE=mock is not allowed in production')
    process.exit(1)
  }
}

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(
  session({
    name: 'pih.sid',
    secret: sessionSecret || 'dev-session-secret',
    resave: false,
    saveUninitialized: false,
    // Refresh the cookie on every response so active users are never logged
    // out mid-task; the client warns shortly before idle expiry (issue #23)
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  }),
)

// ── Abuse protection (issue #22) ────────────────────────────────────────────
// Per-user buckets when signed in, per-IP otherwise. Tunable via
// RATE_LIMIT_* env vars; full endpoint coverage in docs/RATE_LIMITS.md.
const signInRateLimit = createRateLimiter({
  name: 'sign-in',
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyBy: 'ip',
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
})
const accountCreateRateLimit = createRateLimiter({
  name: 'account-create',
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: 'ip',
  message: 'Too many account requests from this network. Please try again in an hour.',
})
// Advertiser forgot/reset password. Per-IP, generous enough for a fat-fingered
// retry but tight enough to blunt token-guessing and email-spam abuse.
const passwordResetRateLimit = createRateLimiter({
  name: 'password-reset',
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: 'ip',
  message: 'Too many password reset requests. Please try again in an hour.',
})
const sessionSyncRateLimit = createRateLimiter({
  name: 'session-sync',
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyBy: 'ip',
  message: 'Too many session requests. Please slow down and try again shortly.',
})
const boardWriteRateLimit = createRateLimiter({
  name: 'board-write',
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'You are posting too quickly. Take a short break and try again.',
})
const sourceSyncRateLimit = createRateLimiter({
  name: 'source-sync',
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many sync requests. Please wait a few minutes before syncing again.',
})
// The .ics feed is unauthenticated (calendar apps cannot log in), so it is
// keyed by IP. Calendar clients poll every 15–60 min; this budget tolerates
// that while blunting token-guessing sweeps.
const calendarFeedRateLimit = createRateLimiter({
  name: 'calendar-feed',
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyBy: 'ip',
  message: 'Too many calendar feed requests. Please try again shortly.',
})
// Lost & Found posting (issue #47): per-user budget on creates/edits.
const lostFoundWriteRateLimit = createRateLimiter({
  name: 'lost-found-write',
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'You are posting too quickly. Take a short break and try again.',
})
// Sponsored ad impression/tap logging (advertiser-portal M3). Per-user budget —
// generous because a student scrolling the dashboard legitimately fires several
// impressions, but capped to blunt automated inflation of an advertiser's stats.
const adEventRateLimit = createRateLimiter({
  name: 'ad-event',
  windowMs: 5 * 60 * 1000,
  max: 200,
  message: 'Too many ad events. Please slow down.',
})
// First-party analytics ingestion (issue #51). The client flushes a batch at
// most every 10s, so 60 requests per 5 minutes leaves ample headroom while
// capping abuse.
const publicReadRateLimit = createRateLimiter({
  name: 'public-read',
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyBy: 'ip',
  message: 'Too many requests. Please try again shortly.',
})
const analyticsRateLimit = createRateLimiter({
  name: 'analytics',
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: 'Too many analytics requests. Please slow down.',
})
const adminWriteRateLimit = createRateLimiter({
  name: 'admin-write',
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Too many admin actions. Please slow down.',
})

function nowIso() {
  return new Date().toISOString()
}

function startOfToday() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

function makeId() {
  return crypto.randomUUID()
}

function sanitizeNext(next) {
  if (!next || typeof next !== 'string' || !next.startsWith('/')) return defaultNextPath
  return next
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function deriveDisplayName(email, providedName = '') {
  if (providedName && providedName.trim()) return providedName.trim()
  if (!email) return 'Student'
  const local = email.split('@')[0] || 'student'
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

async function getUserById(userId) {
  if (!userId) return null
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single()
  if (error || !data) return null
  return data
}

async function getUserByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', normalizeEmail(email))
    .single()
  if (error || !data) return null
  return data
}

async function updateUserProfile(userId, { email, displayName, currentPassword, newPassword, analyticsOptOut }) {
  const user = await getUserById(userId)
  if (!user) throw new Error('User not found.')

  const normalizedEmail = normalizeEmail(email || user.email)
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Please enter a valid email address.')
  }

  const existingUser = await getUserByEmail(normalizedEmail)
  if (existingUser && existingUser.id !== userId) {
    throw new Error('That email address is already in use.')
  }

  const wantsPasswordChange = Boolean((currentPassword && currentPassword.trim()) || (newPassword && newPassword.trim()))
  if (wantsPasswordChange) {
    await applyPasswordChange(
      {
        verifySupabasePassword,
        setSupabasePassword: async (authUserId, password) => {
          const { error } = await supabase.auth.admin.updateUserById(authUserId, { password })
          if (error) throw new Error(error.message || 'Could not update your password.')
        },
        migrateLegacyUser: migrateLegacyUserToSupabaseAuth,
      },
      user,
      currentPassword,
      newPassword,
    )
  }

  // Keep the Supabase Auth email in sync so password sign-in keeps working.
  // user_not_found = legacy row that has not been migrated into Auth yet.
  if (normalizedEmail !== normalizeEmail(user.email)) {
    const { error: emailError } = await supabase.auth.admin.updateUserById(userId, {
      email: normalizedEmail,
      email_confirm: true,
    })
    if (emailError && emailError.code !== 'user_not_found') {
      throw new Error(emailError.message || 'Could not update your email.')
    }
  }

  const nextDisplayName = deriveDisplayName(normalizedEmail, displayName || user.display_name)

  const { data, error } = await supabase
    .from('users')
    .update({
      email: normalizedEmail,
      display_name: nextDisplayName,
      // After a password change Supabase Auth holds the password, so the
      // legacy scrypt mirror is dropped; otherwise leave it for migration.
      password_hash: wantsPasswordChange ? '' : user.password_hash,
      // Analytics opt-out (issue #51): only touch it when the request says so.
      ...(typeof analyticsOptOut === 'boolean' ? { analytics_opt_out: analyticsOptOut } : {}),
      updated_at: nowIso()
    })
    .eq('id', userId)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

async function verifyUserPasswordForDeletion(userRow, password) {
  if (!password) {
    throw new Error('Please enter your password to confirm deletion.')
  }
  const authUser = await verifySupabasePassword(userRow.email, password)
  if (authUser) return
  if (hasLegacyHash(userRow) && verifyPassword(password, userRow.password_hash)) return
  throw new Error('Password is incorrect.')
}

async function deleteUserAccount(userRow, { password, confirmation }) {
  if (confirmation !== 'DELETE') {
    throw new Error('Type DELETE in the confirmation box to permanently delete your account.')
  }
  await verifyUserPasswordForDeletion(userRow, password)

  const userId = userRow.id

  const { error: authError } = await supabase.auth.admin.deleteUser(userId)
  if (authError && authError.code !== 'user_not_found') {
    console.error('[deleteUserAccount] Supabase Auth delete failed:', authError.message)
    throw new Error('Could not delete your authentication account. Try again or contact support.')
  }

  const { error: dbError } = await supabase.from('users').delete().eq('id', userId)
  if (dbError) {
    console.error('[deleteUserAccount] public.users delete failed:', dbError.message)
    throw new Error('Could not delete your profile data.')
  }
}

function getAcademicTerm(dateValue) {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return null
  const month = date.getMonth()
  const year = date.getFullYear()
  let season = 'fall'
  if (month <= 4) season = 'spring'
  else if (month <= 6) season = 'summer'
  return {
    key: `${year}-${season}`,
    year,
    season,
    label: `${season.charAt(0).toUpperCase() + season.slice(1)} ${year}`,
  }
}

function parseTermKey(termKey) {
  const [yearPart, season] = String(termKey || '').split('-')
  const year = Number(yearPart)
  if (!year || !TERM_ORDER[season]) return null
  return { key: `${year}-${season}`, year, season, label: `${season.charAt(0).toUpperCase() + season.slice(1)} ${year}` }
}

function compareTermKeys(a, b) {
  const left = parseTermKey(a)
  const right = parseTermKey(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  if (left.year !== right.year) return left.year - right.year
  return TERM_ORDER[left.season] - TERM_ORDER[right.season]
}

function getPreferredClassTerm(items) {
  if (!items.length) return null

  const groups = new Map()
  for (const item of items) {
    const term = getAcademicTerm(item.start_time)
    if (!term) continue
    const start = new Date(item.start_time)
    const end = new Date(item.end_time || item.start_time)
    const current = groups.get(term.key) || {
      key: term.key,
      label: term.label,
      minStart: start,
      maxEnd: end,
    }
    if (start < current.minStart) current.minStart = start
    if (end > current.maxEnd) current.maxEnd = end
    groups.set(term.key, current)
  }

  if (!groups.size) return null

  const today = startOfToday()
  const currentTerm = getAcademicTerm(today)
  const currentGroup = currentTerm ? groups.get(currentTerm.key) : null
  if (currentGroup && currentGroup.maxEnd >= today) {
    return parseTermKey(currentGroup.key)
  }

  const upcomingGroups = [...groups.values()]
    .filter((group) => group.maxEnd >= today)
    .sort((a, b) => a.minStart - b.minStart || compareTermKeys(a.key, b.key))
  if (upcomingGroups.length) {
    return parseTermKey(upcomingGroups[0].key)
  }

  const latestGroup = [...groups.values()].sort((a, b) => compareTermKeys(b.key, a.key) || b.maxEnd - a.maxEnd)[0]
  return latestGroup ? parseTermKey(latestGroup.key) : null
}

function orderClassItemsForDisplay(items) {
  const now = new Date()
  const upcoming = items
    .filter((item) => new Date(item.end_time || item.start_time) >= now)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))

  if (upcoming.length) return upcoming

  return [...items].sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
}

// Accepts either a userId or an already-loaded user row. Callers that already
// have the user (e.g. the session endpoint) pass the object to avoid a
// redundant re-fetch, and the two independent counts run in parallel — turning
// the session payload from 4 sequential Supabase round-trips into 2.
async function getUserSummary(userOrId) {
  const user = userOrId && typeof userOrId === 'object' ? userOrId : await getUserById(userOrId)
  const userId = user?.id ?? userOrId

  const [{ count: linkedSourceCount }, { count: classCount }] = await Promise.all([
    supabase
      .from('linked_sources')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId),
    supabase
      .from('calendar_items')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('category', 'class'),
  ])

  const hasPurdueLinked = Boolean(user?.purdue_email)
  return {
    linkedSourceCount: linkedSourceCount || 0,
    classCount: classCount || 0,
    hasPurdueLinked,
    // When Purdue linking is off, never prompt a link and let users attach
    // calendar sources directly (no identity link required).
    needsPurdueConnection: purdueLinkingEnabled ? !hasPurdueLinked : false,
    needsScheduleSource: (purdueLinkingEnabled ? hasPurdueLinked : true) && (linkedSourceCount || 0) === 0,
  }
}

async function getCurrentUser(req) {
  return await getUserById(req.session.userId)
}

async function buildSessionPayload(user, req) {
  if (!user) return null
  // Pass the already-loaded user so getUserSummary skips re-fetching it.
  const summary = await getUserSummary(user)
  // Cookie expiry lets the client warn before the session lapses (issue #23)
  const cookieExpires = req?.session?.cookie?.expires
  return {
    expiresAt: cookieExpires ? new Date(cookieExpires).toISOString() : null,
    user: {
      id: user.id,
      email: user.email,
      name: user.display_name,
      authProvider: user.auth_provider,
      purdueEmail: user.purdue_email,
      purdueUsername: user.purdue_username,
      hasPurdueLinked: Boolean(user.purdue_email),
      analyticsOptOut: Boolean(user.analytics_opt_out),
      isAdmin: isUserAdmin(user),
    },
    onboarding: summary,
  }
}

function isUserAdmin(user) {
  if (!user?.email) return false
  if (user.is_admin) return true
  return adminEmails.has(String(user.email).trim().toLowerCase())
}

async function requireAuth(req, res, next) {
  const user = await getCurrentUser(req)
  if (!user) {
    return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
  }
  req.currentUser = user
  next()
}

function requireAdmin(req, res, next) {
  if (!isUserAdmin(req.currentUser)) {
    return res.status(403).json({ error: { message: 'Admin access required.', status: 403 } })
  }
  next()
}

function requirePurdueLinked(req, res, next) {
  // Linking off: calendar sources don't require a linked Purdue identity.
  if (!purdueLinkingEnabled) return next()
  if (!req.currentUser?.purdue_email) {
    return res.status(400).json({
      error: {
        message: 'Link your Purdue account before connecting Purdue schedule data.',
        status: 400,
      },
    })
  }
  next()
}

async function listSourcesForUser(userId) {
  const { data, error } = await supabase
    .from('linked_sources')
    .select('id, source_type, label, source_url, status, last_synced_at, last_error, created_at, updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) return []
  return data.map(row => ({
    id: row.id,
    sourceType: row.source_type,
    label: row.label,
    sourceUrl: row.source_url,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

async function getSourceForUser(sourceId, userId) {
  const { data, error } = await supabase
    .from('linked_sources')
    .select('*')
    .eq('id', sourceId)
    .eq('user_id', userId)
    .single()

  if (error || !data) return null
  return data
}

function validateSourceUrl(sourceUrl) {
  return assertSafeHttpUrl(sourceUrl)
}

// ── Schedule sync (imperative shell) ─────────────────────────────────────────
// The pure plan lives in scheduleSync.mjs; this shell owns the fetch, the
// database writes (via calendarItemStore), and item identity stamping.
const calendarItemStore = createCalendarItemStore(supabase)

async function runScheduleSync(source) {
  const syncedAt = nowIso()
  const sourceId = source.id

  let eventsByKey
  try {
    await assertSafeHttpUrl(source.source_url)
    eventsByKey = await ical.async.fromURL(source.source_url)
  } catch (fetchError) {
    const classified = classifyFetchError(fetchError)
    console.error('[runScheduleSync] Fetch failed for source=' + sourceId + ':', fetchError?.message || fetchError)
    await calendarItemStore.setStatus(sourceId, classified.status, classified.message)
    throw new Error(classified.message)
  }

  const plan = planSync(eventsByKey, source)

  // Empty feed parsed cleanly: leave any existing items untouched (prior behaviour).
  if (plan.meta.rawCount === 0) {
    await calendarItemStore.setStatus(sourceId, plan.sourceStatus, plan.statusMessage, { markSynced: true })
    return { syncedAt, itemCount: 0, warning: plan.meta.warning }
  }

  try {
    await calendarItemStore.replaceItems(sourceId, plan.itemsToInsert)
  } catch (insertError) {
    await calendarItemStore.setStatus(sourceId, 'error', 'Failed to save events: ' + insertError.message)
    throw new Error('Failed to save calendar events: ' + insertError.message)
  }

  await calendarItemStore.setStatus(sourceId, plan.sourceStatus, plan.statusMessage, { markSynced: true })

  console.log('[runScheduleSync] source=' + sourceId + ': ' + plan.meta.itemCount + ' items saved (' + plan.meta.skippedCount + ' skipped, ' + plan.meta.duplicateCount + ' duplicates removed)')

  return {
    syncedAt,
    itemCount: plan.meta.itemCount,
    skippedCount: plan.meta.skippedCount,
    timezone: plan.meta.timezone,
  }
}

async function createScheduleSource(userId, { icsUrl, label, sourceType = 'purdue_schedule_ical' }) {
  const sourceUrl = await validateSourceUrl(icsUrl)
  const timestamp = nowIso()
  const id = makeId()

  const { data, error } = await supabase
    .from('linked_sources')
    .insert({
      id,
      user_id: userId,
      source_type: sourceType,
      label: (label || 'Schedule').trim() || 'Schedule',
      source_url: sourceUrl,
      status: 'pending',
      created_at: timestamp,
      updated_at: timestamp
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

async function listCalendarItems(userId, { category, categories, limit = 100, order = 'asc', from = null } = {}) {
  let query = supabase
    .from('calendar_items')
    .select('id, source_id, title, description, start_time, end_time, location, category, external_uid, source_type')
    .eq('user_id', userId)

  if (category) {
    query = query.eq('category', category)
  } else if (categories && categories.length > 0) {
    query = query.in('category', categories)
  }

  if (from) {
    query = query.gte('start_time', from)
  }

  query = query.order('start_time', { ascending: order === 'asc' }).limit(Number(limit) || 100)

  const { data, error } = await query

  if (error) return []
  return data.map(row => ({
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    description: row.description,
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    category: row.category,
    externalUid: row.external_uid,
    sourceType: row.source_type,
    // Flag events that advertise free food (issue #46). Cheap per-row regex;
    // only meaningful for event categories but harmless elsewhere.
    freeFood: hasFreeFood(row.title, row.description),
  }))
}

async function getClassItemsForUser(userId, { limit = 20, term = 'auto', mode = 'display' } = {}) {
  const allItems = await listCalendarItems(userId, { category: 'class', limit: 5000, order: 'asc' })
  if (!allItems.length) {
    return {
      items: [],
      meta: {
        selectedTermKey: null,
        selectedTermLabel: null,
        totalInTerm: 0,
      },
    }
  }

  // Convert camelCase to snake_case for term processing
  const itemsForTermProcessing = allItems.map(item => ({
    ...item,
    start_time: item.startTime,
    end_time: item.endTime
  }))

  const preferredTerm = term === 'all' ? null : (term && term !== 'auto' ? parseTermKey(term) : getPreferredClassTerm(itemsForTermProcessing))
  const termItems = preferredTerm
    ? allItems.filter((item) => getAcademicTerm(item.startTime)?.key === preferredTerm.key)
    : allItems

  const orderedItems = mode === 'display'
    ? orderClassItemsForDisplay(termItems.map(item => ({ ...item, start_time: item.startTime, end_time: item.endTime })))
        .map(item => ({ ...item, startTime: item.start_time, endTime: item.end_time }))
    : [...termItems].sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

  return {
    items: orderedItems.slice(0, Number(limit) || 20),
    meta: {
      selectedTermKey: preferredTerm?.key || null,
      selectedTermLabel: preferredTerm?.label || null,
      totalInTerm: termItems.length,
    },
  }
}

async function authUserExists(userId) {
  if (!userId) return false
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  return Boolean(data?.user) && !error
}

async function clearPurdueLinkOnUser(userId) {
  const { error } = await supabase
    .from('users')
    .update({
      purdue_email: null,
      purdue_username: null,
      purdue_linked_at: null,
      updated_at: nowIso(),
    })
    .eq('id', userId)
  if (error) throw new Error(error.message)
}

async function linkPurdueIdentity(userId, { email }) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !normalizedEmail.endsWith('@purdue.edu')) {
    throw new Error('Please use a valid @purdue.edu account.')
  }

  const currentUser = await getUserById(userId)
  if (normalizeEmail(currentUser?.purdue_email) === normalizedEmail) {
    return currentUser
  }

  const { data: existingRows } = await supabase
    .from('users')
    .select('id, email')
    .eq('purdue_email', normalizedEmail)
    .neq('id', userId)

  const existing = existingRows?.[0]
  if (existing) {
    const holderEmail = normalizeEmail(existing.email)
    const currentEmail = normalizeEmail(currentUser?.email)

    // Account recovery: Supabase Auth was reset but public.users still holds the
    // Purdue link on an older profile row for the same login email.
    if (holderEmail && currentEmail && holderEmail === currentEmail) {
      await clearPurdueLinkOnUser(existing.id)
    } else if (!(await authUserExists(existing.id))) {
      // Orphan profile row (Auth user deleted, public.users row left behind).
      await clearPurdueLinkOnUser(existing.id)
    } else {
      throw new Error(
        'That Purdue account is already linked to another BoilerIndy profile. '
        + 'Sign in with the email you used before, or contact support to release the link.',
      )
    }
  }

  const username = normalizedEmail.split('@')[0]
  const timestamp = nowIso()

  const { data, error } = await supabase
    .from('users')
    .update({
      purdue_email: normalizedEmail,
      purdue_username: username,
      purdue_linked_at: timestamp,
      updated_at: timestamp
    })
    .eq('id', userId)
    .select()
    .single()

  if (error) {
    if (String(error.message || '').includes('users_purdue_email_key') || error.code === '23505') {
      throw new Error(
        'That Purdue email is already linked to another account. Contact support if you recently reset your profile.',
      )
    }
    throw new Error(error.message)
  }
  return data
}

async function validateCasTicket(ticket, nextPath) {
  const loginUrl = process.env.PURDUE_CAS_LOGIN_URL
  const validateUrl = process.env.PURDUE_CAS_VALIDATE_URL
  if (!loginUrl || !validateUrl) {
    throw new Error('CAS mode requires PURDUE_CAS_LOGIN_URL and PURDUE_CAS_VALIDATE_URL.')
  }

  const serviceUrl = `${publicBaseUrl}/auth/purdue/callback?next=${encodeURIComponent(nextPath)}`
  const response = await fetch(`${validateUrl}?service=${encodeURIComponent(serviceUrl)}&ticket=${encodeURIComponent(ticket)}`)
  const xml = await response.text()
  const userMatch = xml.match(/<cas:user>([^<]+)<\/cas:user>/i)
  if (!userMatch) throw new Error('CAS ticket validation failed.')
  const emailMatch = xml.match(/<cas:(?:mail|email)>([^<]+)<\/cas:(?:mail|email)>/i)
  const username = userMatch[1].trim()
  const email = emailMatch?.[1]?.trim() || `${username}@purdue.edu`
  return { email }
}

function renderMockPurdueLinkPage(nextPath, message = '', currentEmail = '') {
  const defaultEmail = currentEmail || process.env.DEV_PURDUE_EMAIL || 'student@purdue.edu'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link Purdue Account</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#f5f4f1;color:#1a1918;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
    .card{width:min(100%,420px);background:#fff;border:1px solid rgba(26,25,24,.08);border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(26,25,24,.08)}
    .badge{display:inline-block;background:#CFB991;color:#3E2200;font-size:10px;font-weight:700;padding:4px 10px;border-radius:999px;letter-spacing:.08em;text-transform:uppercase}
    h1{font-size:24px;margin:16px 0 8px}
    p{font-size:14px;line-height:1.6;color:#4A4844}
    label{display:block;font-size:12px;font-weight:600;margin:16px 0 6px}
    input{width:100%;box-sizing:border-box;border:1px solid rgba(26,25,24,.14);border-radius:10px;padding:12px 14px;font:inherit}
    button{margin-top:20px;width:100%;border:0;border-radius:10px;background:#CFB991;color:#3E2200;padding:12px 14px;font:inherit;font-weight:700;cursor:pointer}
    .msg{margin-top:12px;color:#b42318;font-size:13px}
  </style>
</head>
<body>
  <form class="card" method="post" action="/auth/purdue/dev/link">
    <span class="badge">Mock Purdue Link</span>
    <h1>Link your Purdue account</h1>
    <p>This development screen stands in for Purdue CAS account linking until official CAS service registration is available.</p>
    <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
    <label for="email">Purdue email</label>
    <input id="email" name="email" type="email" value="${escapeHtml(defaultEmail)}" required />
    <button type="submit">Link Purdue account</button>
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
  </form>
</body>
</html>`
}

app.get('/api/auth-config', (_req, res) => {
  res.json({
    authProvider: 'local',
    purdueAuthMode,
    supportsPurdueLink: purdueLinkingEnabled,
    supportedSources: ['purdue_schedule_ical'],
  })
})

app.get('/api/session', async (req, res) => {
  const user = await getCurrentUser(req)
  const sessionPayload = await buildSessionPayload(user, req)
  res.json({ authenticated: Boolean(sessionPayload), session: sessionPayload })
})

app.post('/api/auth/register-supabase', accountCreateRateLimit, async (req, res) => {
  try {
    const emailRaw = req.body.email
    const password = req.body.password
    const displayName = req.body.name ?? req.body.displayName ?? ''
    const rememberMe = req.body.rememberMe === true
    const cookieMaxAge = rememberMe ? 1000 * 60 * 60 * 24 * 30 : undefined
    const normalizedEmail = normalizeEmail(emailRaw)
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      return res.status(400).json({ error: { message: 'Please enter a valid email address.', status: 400 } })
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: { message: 'Password must be at least 8 characters.', status: 400 } })
    }

    const existingRow = await getUserByEmail(normalizedEmail)
    if (existingRow) {
      return res.status(400).json({ error: { message: 'An account with that email already exists.', status: 400 } })
    }

    const { data: created, error: authError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: String(displayName).trim() || deriveDisplayName(normalizedEmail, ''),
      },
    })

    if (authError) {
      const raw = authError.message || 'Could not create account.'
      if (
        /already\s+registered|already\s+exists|duplicate/i.test(raw) ||
        authError.code === 'email_exists'
      ) {
        return res.status(400).json({ error: { message: 'An account with that email already exists.', status: 400 } })
      }
      return res.status(400).json({ error: { message: raw, status: 400 } })
    }

    const authUser = created.user
    const timestamp = nowIso()
    const { data: row, error: insertError } = await supabase
      .from('users')
      .insert({
        id: authUser.id,
        email: normalizedEmail,
        // Supabase Auth (created above) is the only password store; the
        // password_hash column is a legacy migration artifact and stays empty.
        password_hash: '',
        display_name: deriveDisplayName(normalizedEmail, displayName),
        auth_provider: 'email',
        created_at: timestamp,
        updated_at: timestamp,
      })
      .select()
      .single()

    if (insertError) {
      console.error('register-supabase: public.users insert failed:', insertError)
      return res.status(500).json({
        error: { message: 'Could not create your profile.', status: 500 },
      })
    }

    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
      }
      req.session.cookie.maxAge = cookieMaxAge
      req.session.userId = row.id
      req.session.save(async () => {
        res.status(201).json({ session: await buildSessionPayload(row, req) })
      })
    })
  } catch (error) {
    res.status(500).json({ error: { message: error.message || 'Could not create account.', status: 500 } })
  }
})

async function verifySupabasePassword(email, password) {
  const gotrue = `${supabaseUrl}/auth/v1/token?grant_type=password`
  const anonKey = supabaseAnonKey || (isProduction ? null : supabaseServiceKey)
  if (!anonKey) {
    throw new Error('Supabase auth is not configured.')
  }
  const resp = await fetch(gotrue, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
    },
    body: JSON.stringify({ email, password }),
  })
  if (!resp.ok) return null
  const data = await resp.json()
  return data?.user ?? null
}

// Move a pre-Supabase account (scrypt hash in public.users only) into Supabase
// Auth. Returns false when the email already exists there — in that case
// Supabase's password verdict is authoritative and the caller must reject.
async function migrateLegacyUserToSupabaseAuth(userRow, password) {
  const { error } = await supabase.auth.admin.createUser({
    email: userRow.email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: userRow.display_name || deriveDisplayName(userRow.email, ''),
    },
  })
  if (!error) return true
  if (error.code === 'email_exists' || /already\s+(registered|exists)/i.test(error.message || '')) {
    return false
  }
  throw new Error(error.message || 'Could not verify your credentials.')
}

// Once Supabase Auth holds the account's password, the legacy scrypt mirror
// must go away so an old password can never be replayed against it.
async function clearLegacyPasswordHash(userRow) {
  if (!hasLegacyHash(userRow)) return
  await supabase
    .from('users')
    .update({ password_hash: '', updated_at: nowIso() })
    .eq('id', userRow.id)
}

async function ensureUserRowForSupabaseAuth(supabaseUser, fallbackEmail) {
  const normalizedEmail = normalizeEmail(supabaseUser?.email || fallbackEmail)
  if (!normalizedEmail) return null

  let user = await getUserByEmail(normalizedEmail)
  if (user) {
    const { data, error } = await supabase
      .from('users')
      .update({
        display_name:
          supabaseUser?.user_metadata?.full_name ||
          supabaseUser?.user_metadata?.name ||
          user.display_name ||
          deriveDisplayName(normalizedEmail, ''),
        auth_provider: user.auth_provider || 'email',
        updated_at: nowIso(),
      })
      .eq('id', user.id)
      .select()
      .single()

    return error ? user : data
  }

  const timestamp = nowIso()
  const { data, error } = await supabase
    .from('users')
    .insert({
      id: supabaseUser?.id || makeId(),
      email: normalizedEmail,
      password_hash: '',
      display_name:
        supabaseUser?.user_metadata?.full_name ||
        supabaseUser?.user_metadata?.name ||
        deriveDisplayName(normalizedEmail, ''),
      auth_provider: 'email',
      avatar_url: supabaseUser?.user_metadata?.avatar_url || null,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .select()
    .single()

  if (error) {
    const existing = await getUserByEmail(normalizedEmail)
    if (existing) return existing
    throw new Error(error.message || 'Could not create your profile.')
  }

  return data
}

app.post('/api/auth/sign-in', signInRateLimit, async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email)
    const password = typeof req.body.password === 'string' ? req.body.password : ''
    const rememberMe = req.body.rememberMe === true
    const cookieMaxAge = rememberMe ? 1000 * 60 * 60 * 24 * 30 : undefined

    // Supabase Auth decides; the legacy scrypt hash only matters for accounts
    // that predate it (see studentPasswordAuth.mjs for the full policy).
    const result = await resolveSignIn(
      {
        verifySupabasePassword,
        getUserByEmail,
        ensureUserRow: ensureUserRowForSupabaseAuth,
        migrateLegacyUser: migrateLegacyUserToSupabaseAuth,
      },
      normalizedEmail,
      password,
    )

    if (!result.ok) {
      return res.status(401).json({ error: { message: 'Invalid email or password.', status: 401 } })
    }

    const user = result.user
    await clearLegacyPasswordHash(user)

    req.session.regenerate(async (err) => {
      if (err) {
        return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
      }
      req.session.cookie.maxAge = cookieMaxAge
      req.session.userId = user.id
      req.session.save(async () => {
        res.json({ session: await buildSessionPayload(user, req) })
      })
    })
  } catch (error) {
    res.status(401).json({ error: { message: error.message || 'Could not sign in.', status: 401 } })
  }
})

app.post('/api/sign-out', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pih.sid')
    res.json({ ok: true })
  })
})

app.post('/api/auth/supabase-sync', sessionSyncRateLimit, async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ''
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const accessToken = bearerToken || req.body?.accessToken

    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(401).json({ error: { message: 'Missing access token.', status: 401 } })
    }

    const { data: tokenData, error: tokenError } = await supabase.auth.getUser(accessToken)
    if (tokenError || !tokenData?.user) {
      return res.status(401).json({ error: { message: 'Invalid or expired access token.', status: 401 } })
    }

    const tokenUser = tokenData.user
    const { supabaseUserId, email, name, avatarUrl, provider } = req.body

    if (!supabaseUserId || !email) {
      return res.status(400).json({ error: { message: 'Missing required fields', status: 400 } })
    }

    const normalizedEmail = normalizeEmail(email)
    const tokenEmail = normalizeEmail(tokenUser.email)

    if (tokenUser.id !== supabaseUserId || tokenEmail !== normalizedEmail) {
      return res.status(401).json({ error: { message: 'Token does not match the requested user.', status: 401 } })
    }

    let user = await getUserByEmail(normalizedEmail)

    if (!user) {
      const timestamp = nowIso()
      const { data, error } = await supabase
        .from('users')
        .insert({
          id: supabaseUserId,
          email: normalizedEmail,
          password_hash: '',
          display_name: deriveDisplayName(normalizedEmail, name),
          auth_provider: provider || 'supabase',
          avatar_url: avatarUrl || null,
          created_at: timestamp,
          updated_at: timestamp
        })
        .select()
        .single()

      if (error) {
        if (error.code === '23505') {
          user = await getUserByEmail(normalizedEmail)
        } else {
          throw new Error(error.message)
        }
      } else {
        user = data
      }
    } else {
      const { data, error } = await supabase
        .from('users')
        .update({
          display_name: name || user.display_name,
          avatar_url: avatarUrl || user.avatar_url,
          auth_provider: user.auth_provider === 'local' ? user.auth_provider : (provider || user.auth_provider),
          updated_at: nowIso()
        })
        .eq('id', user.id)
        .select()
        .single()

      if (error) {
        console.error('Failed to update user:', error)
      } else {
        user = data
      }
    }

    if (!user) {
      return res.status(500).json({ error: { message: 'Could not sync user profile.', status: 500 } })
    }

    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
      }
      req.session.userId = user.id
      req.session.save(async () => {
        const session = await buildSessionPayload(user, req)
        res.json({ session })
      })
    })
  } catch (error) {
    console.error('Supabase sync error:', error)
    res.status(500).json({ error: { message: 'Could not sync user.', status: 500 } })
  }
})

app.get('/auth/purdue/connect', requireAuth, (req, res) => {
  const nextPath = sanitizeNext(req.query.next)
  if (!purdueLinkingEnabled) {
    return res.redirect(`${clientAppUrl}/settings`)
  }
  if (purdueAuthMode === 'cas') {
    const loginUrl = process.env.PURDUE_CAS_LOGIN_URL
    const validateUrl = process.env.PURDUE_CAS_VALIDATE_URL
    if (!loginUrl || !validateUrl) {
      return res.redirect(`${clientAppUrl}/settings?error=cas-config`)
    }
    const serviceUrl = `${publicBaseUrl}/auth/purdue/callback?next=${encodeURIComponent(nextPath)}`
    return res.redirect(`${loginUrl}?service=${encodeURIComponent(serviceUrl)}`)
  }

  res.type('html').send(renderMockPurdueLinkPage(nextPath, '', req.currentUser.purdue_email))
})

app.post('/auth/purdue/dev/link', requireAuth, async (req, res) => {
  const nextPath = sanitizeNext(req.body.next)
  if (!purdueLinkingEnabled) {
    return res.status(404).send('Purdue linking is currently disabled.')
  }
  if (purdueAuthMode === 'cas') {
    return res.status(404).send('Mock Purdue linking is disabled while CAS mode is active.')
  }
  try {
    await linkPurdueIdentity(req.currentUser.id, {
      email: req.body.email,
    })
    res.redirect(`${clientAppUrl}${nextPath}`)
  } catch (error) {
    res.type('html').send(renderMockPurdueLinkPage(nextPath, error.message || 'Could not link Purdue account.', req.body.email))
  }
})

app.post('/api/purdue/mock-link', requireAuth, async (req, res) => {
  if (!purdueLinkingEnabled) {
    return res.status(400).json({ error: { message: 'Purdue linking is currently disabled.', status: 400 } })
  }
  if (purdueAuthMode === 'cas') {
    return res.status(400).json({ error: { message: 'Mock Purdue linking is disabled while CAS mode is active.', status: 400 } })
  }
  try {
    await linkPurdueIdentity(req.currentUser.id, { email: req.body.email })
    const payload = await buildSessionPayload(await getUserById(req.currentUser.id), req)
    res.json({ ok: true, session: payload })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not link Purdue account.', status: 400 } })
  }
})

app.get('/auth/purdue/callback', requireAuth, async (req, res) => {
  const nextPath = sanitizeNext(req.query.next)
  const ticket = req.query.ticket
  if (!ticket) {
    return res.redirect(`${clientAppUrl}/settings?error=missing-ticket`)
  }
  try {
    const identity = await validateCasTicket(String(ticket), nextPath)
    await linkPurdueIdentity(req.currentUser.id, identity)
    res.redirect(`${clientAppUrl}${nextPath}`)
  } catch (error) {
    console.error('[auth/purdue/callback]', error)
    const message = encodeURIComponent(error.message || 'Could not link Purdue account.')
    res.redirect(`${clientAppUrl}/setup?error=purdue-link&message=${message}`)
  }
})

app.get('/api/me/profile', requireAuth, async (req, res) => {
  const payload = await buildSessionPayload(req.currentUser, req)
  res.json({ user: payload.user })
})

app.patch('/api/me/profile', requireAuth, async (req, res) => {
  try {
    const user = await updateUserProfile(req.currentUser.id, {
      email: req.body.email,
      displayName: req.body.name,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
      analyticsOptOut: typeof req.body.analyticsOptOut === 'boolean' ? req.body.analyticsOptOut : undefined,
    })
    const payload = await buildSessionPayload(user, req)
    res.json({ user: payload.user })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not update profile.', status: 400 } })
  }
})

app.post('/api/me/delete-account', signInRateLimit, requireAuth, async (req, res) => {
  try {
    await deleteUserAccount(req.currentUser, {
      password: req.body?.password,
      confirmation: req.body?.confirmation,
    })
    req.session.destroy(() => {
      res.clearCookie('pih.sid')
      res.json({ ok: true })
    })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not delete account.', status: 400 } })
  }
})

app.get('/api/me/sources', requireAuth, async (req, res) => {
  res.json({ sources: await listSourcesForUser(req.currentUser.id) })
})

// Debug endpoint to diagnose calendar import issues (disabled in production)
app.get('/api/debug/source/:sourceId', requireAuth, async (req, res) => {
  if (isProduction) {
    return res.status(404).json({ error: { message: 'Not found.', status: 404 } })
  }

  const source = await getSourceForUser(req.params.sourceId, req.currentUser.id)
  if (!source) {
    return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
  }

  try {
    await assertSafeHttpUrl(source.source_url)
    const eventsByKey = await ical.async.fromURL(source.source_url)
    const rawEvents = Object.values(eventsByKey).filter((item) => item?.type === 'VEVENT')
    const detectedTimezone = detectTimezoneFromFeed(eventsByKey)
    
    // Get first 5 raw events with their key properties
    const sampleEvents = rawEvents.slice(0, 5).map(e => ({
      // Coerce node-ical's object-shaped text (SUMMARY;LANGUAGE=…) so the debug
      // output shows the title the sync would actually store, not "[object Object]".
      summary: icalText(e.summary),
      start: e.start,
      startType: typeof e.start,
      startTz: e.start?.tz,
      end: e.end,
      hasRrule: !!e.rrule,
      rruleStr: e.rrule?.toString?.()?.slice(0, 200),
      uid: e.uid?.slice(0, 50),
    }))
    
    // Expand and get first 10 expanded events
    const expanded = expandRecurringEvents(rawEvents.slice(0, 10), detectedTimezone)
    const sampleExpanded = expanded.slice(0, 10).map(e => ({
      summary: icalText(e.summary),
      start: e.start?.toISOString?.(),
      end: e.end?.toISOString?.(),
      uid: e.uid?.slice(0, 50),
    }))
    
    res.json({
      sourceId: source.id,
      sourceType: source.source_type,
      detectedTimezone,
      rawEventCount: rawEvents.length,
      expandedEventCount: expanded.length,
      sampleRawEvents: sampleEvents,
      sampleExpandedEvents: sampleExpanded,
    })
  } catch (error) {
    console.error('[/api/debug/source] failed:', error)
    res.status(500).json({
      error: { message: error.message || 'Debug failed', status: 500 },
    })
  }
})

app.post('/api/purdue/calendar-link/start', requireAuth, requirePurdueLinked, async (req, res) => {
  try {
    const job = await startCalendarCapture(req.currentUser.id)
    res.status(202).json({ job })
  } catch (error) {
    res.status(500).json({ error: { message: error.message || 'Could not start Purdue timetable automation.', status: 500 } })
  }
})

app.get('/api/purdue/calendar-link/status', requireAuth, requirePurdueLinked, async (req, res) => {
  res.json({ job: getCalendarCaptureJob(req.currentUser.id) })
})

app.post('/api/purdue/calendar-link/cancel', requireAuth, requirePurdueLinked, async (req, res) => {
  res.json({ job: await cancelCalendarCapture(req.currentUser.id) })
})

app.post('/api/sources/purdue/schedule', sourceSyncRateLimit, requireAuth, requirePurdueLinked, async (req, res) => {
  const userId = req.currentUser.id
  const { icsUrl, label } = req.body

  // Validate URL
  if (!icsUrl || typeof icsUrl !== 'string' || icsUrl.trim().length < 10) {
    return res.status(400).json({ error: { message: 'Please provide a valid calendar URL.', status: 400 } })
  }

  const trimmedUrl = icsUrl.trim()

  // Check for common URL issues
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    return res.status(400).json({ error: { message: 'Calendar URL must start with http:// or https://', status: 400 } })
  }

  // Warn if URL doesn't look like a typical Purdue timetable URL
  const isPurdueUrl = trimmedUrl.includes('purdue.edu') || trimmedUrl.includes('mypurdue')
  if (!isPurdueUrl) {
    console.warn(`[/api/sources/purdue/schedule] User ${userId} connecting non-Purdue URL: ${trimmedUrl.slice(0, 80)}...`)
  }

  try {
    console.log(`[/api/sources/purdue/schedule] User ${userId} creating source...`)
    const source = await createScheduleSource(userId, { icsUrl: trimmedUrl, label })
    
    console.log(`[/api/sources/purdue/schedule] User ${userId} syncing source ${source.id}...`)
    const sync = await runScheduleSync(source)
    
    console.log(`[/api/sources/purdue/schedule] User ${userId} sync complete: ${sync.itemCount} items`)
    res.status(201).json({ source: await getSourceForUser(source.id, userId), sync })
  } catch (error) {
    console.error(`[/api/sources/purdue/schedule] User ${userId} error:`, error?.message || error)
    res.status(400).json({ error: { message: error.message || 'Could not connect the Purdue schedule source.', status: 400 } })
  }
})

app.post('/api/sources/brightspace/schedule', sourceSyncRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { icsUrl, label } = req.body

  // Validate URL
  if (!icsUrl || typeof icsUrl !== 'string' || icsUrl.trim().length < 10) {
    return res.status(400).json({ error: { message: 'Please provide a calendar URL.', status: 400 } })
  }

  const trimmedUrl = icsUrl.trim()

  // Check for common URL issues
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    return res.status(400).json({ error: { message: 'Calendar URL must start with http:// or https://', status: 400 } })
  }

  // Validate Brightspace URL format (but be flexible)
  const isBrightspaceUrl = trimmedUrl.includes('brightspace.com') || trimmedUrl.includes('d2l')
  if (!isBrightspaceUrl) {
    console.warn(`[/api/sources/brightspace/schedule] User ${userId} connecting non-Brightspace URL: ${trimmedUrl.slice(0, 80)}...`)
    // Still allow it but log the warning
  }

  try {
    console.log(`[/api/sources/brightspace/schedule] User ${userId} creating source...`)
    const source = await createScheduleSource(userId, { 
      icsUrl: trimmedUrl, 
      label: label || 'Brightspace Calendar',
      sourceType: 'brightspace_ical'
    })
    
    console.log(`[/api/sources/brightspace/schedule] User ${userId} syncing source ${source.id}...`)
    const sync = await runScheduleSync(source)
    
    console.log(`[/api/sources/brightspace/schedule] User ${userId} sync complete: ${sync.itemCount} items`)
    res.status(201).json({ source: await getSourceForUser(source.id, userId), sync })
  } catch (error) {
    console.error(`[/api/sources/brightspace/schedule] User ${userId} error:`, error?.message || error)
    res.status(400).json({ error: { message: error.message || 'Could not connect the Brightspace calendar.', status: 400 } })
  }
})

app.post('/api/sync/:sourceId', sourceSyncRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const sourceId = req.params.sourceId
  
  const source = await getSourceForUser(sourceId, userId)
  if (!source) {
    return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
  }
  
  try {
    console.log(`[/api/sync] User ${userId} re-syncing source ${sourceId}...`)
    const sync = await runScheduleSync(source)
    console.log(`[/api/sync] User ${userId} sync complete: ${sync.itemCount} items`)
    
    const response = { source: await getSourceForUser(sourceId, userId), sync }
    
    // Include warning in response if some items were skipped
    if (sync.skippedCount > 0) {
      response.warning = `${sync.skippedCount} items had invalid dates and were skipped.`
    }
    
    res.json(response)
  } catch (error) {
    console.error(`[/api/sync] User ${userId} source ${sourceId} error:`, error?.message || error)
    res.status(400).json({ error: { message: error.message || 'Could not sync source.', status: 400 } })
  }
})

app.delete('/api/sources/:sourceId', requireAuth, async (req, res) => {
  const source = await getSourceForUser(req.params.sourceId, req.currentUser.id)
  if (!source) {
    return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
  }
  try {
    // Delete all calendar items for this source
    await supabase
      .from('calendar_items')
      .delete()
      .eq('source_id', source.id)
    
    // Delete the source itself
    await supabase
      .from('linked_sources')
      .delete()
      .eq('id', source.id)
    
    res.json({ ok: true, message: 'Source and all associated items deleted.' })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not delete source.', status: 400 } })
  }
})

app.get('/api/me/calendar', requireAuth, async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : null
  const categories = typeof req.query.categories === 'string' ? req.query.categories.split(',').filter(Boolean) : null
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100
  const from = typeof req.query.from === 'string' ? req.query.from : null
  res.json({ items: await listCalendarItems(req.currentUser.id, { category, categories, limit, order: 'asc', from }) })
})

app.get('/api/me/calendar/categories', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('calendar_items')
    .select('category')
    .eq('user_id', req.currentUser.id)

  if (error) {
    return res.json({ categories: [] })
  }

  const counts = {}
  for (const row of data) {
    counts[row.category] = (counts[row.category] || 0) + 1
  }

  const categoryLabels = {
    class: 'Classes',
    exam: 'Exams',
    assignment: 'Assignments',
    lab: 'Labs',
    project: 'Projects',
    quiz: 'Quizzes',
    campus_event: 'Campus Events',
    resource: 'Resources',
    deadline: 'Deadlines',
    event: 'Other Events'
  }

  const categories = Object.entries(counts)
    .map(([key, count]) => ({
      id: key,
      label: categoryLabels[key] || key,
      count
    }))
    .sort((a, b) => b.count - a.count)

  res.json({ categories })
})

// ── Tasks: mark calendar rows done + user-created dated tasks (see db/supabase-user-tasks.sql) ──

function mapManualTaskRow(row) {
  return {
    id: row.id,
    title: row.title,
    startTime: row.due_at,
    endTime: null,
    category: 'manual_task',
    sourceType: 'manual',
    description: null,
    location: null,
    externalUid: null,
    sourceId: null,
    completedAt: row.completed_at,
    isManual: true,
  }
}

app.get('/api/me/tasks/meta', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const [compRes, manualRes] = await Promise.all([
      supabase
        .from('user_task_completions')
        .select('calendar_item_id, completed_at')
        .eq('user_id', userId),
      supabase.from('user_manual_tasks').select('*').eq('user_id', userId).order('due_at', { ascending: true }),
    ])
    if (compRes.error) throw compRes.error
    if (manualRes.error) throw manualRes.error
    res.json({
      completions: compRes.data || [],
      manualTasks: (manualRes.data || []).map(mapManualTaskRow),
    })
  } catch (e) {
    console.error('GET /api/me/tasks/meta:', e?.message || e)
    res.json({ completions: [], manualTasks: [], unavailable: true })
  }
})

app.post('/api/me/tasks/calendar/complete', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { calendarItemId, completed } = req.body || {}
  if (!calendarItemId || typeof completed !== 'boolean') {
    return res.status(400).json({ error: { message: 'calendarItemId and completed (boolean) required' } })
  }
  const { data: row, error: findErr } = await supabase
    .from('calendar_items')
    .select('id')
    .eq('id', calendarItemId)
    .eq('user_id', userId)
    .maybeSingle()
  if (findErr || !row) {
    return res.status(404).json({ error: { message: 'Calendar item not found' } })
  }
  try {
    if (completed) {
      const { error: insErr } = await supabase.from('user_task_completions').insert({
        user_id: userId,
        calendar_item_id: calendarItemId,
        completed_at: nowIso(),
      })
      if (insErr) {
        if (insErr.code === '23505') {
          const { error: updErr } = await supabase
            .from('user_task_completions')
            .update({ completed_at: nowIso() })
            .eq('user_id', userId)
            .eq('calendar_item_id', calendarItemId)
          if (updErr) throw updErr
        } else {
          throw insErr
        }
      }
    } else {
      const { error } = await supabase
        .from('user_task_completions')
        .delete()
        .eq('user_id', userId)
        .eq('calendar_item_id', calendarItemId)
      if (error) throw error
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('POST /api/me/tasks/calendar/complete:', e)
    res.status(500).json({ error: { message: e.message || 'Could not update completion' } })
  }
})

app.post('/api/me/tasks/manual', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { title, dueAt } = req.body || {}
  const t = String(title || '').trim()
  if (!t || t.length > 500) {
    return res.status(400).json({ error: { message: 'Title is required (max 500 characters)' } })
  }
  if (!dueAt || typeof dueAt !== 'string') {
    return res.status(400).json({ error: { message: 'dueAt ISO timestamp is required' } })
  }
  const due = new Date(dueAt)
  if (Number.isNaN(due.getTime())) {
    return res.status(400).json({ error: { message: 'Invalid dueAt date' } })
  }
  try {
    const { data, error } = await supabase
      .from('user_manual_tasks')
      .insert({
        user_id: userId,
        title: t,
        due_at: due.toISOString(),
      })
      .select()
      .single()
    if (error) throw error
    res.json({ task: mapManualTaskRow(data) })
  } catch (e) {
    console.error('POST /api/me/tasks/manual:', e)
    res.status(500).json({ error: { message: e.message || 'Could not create task' } })
  }
})

app.patch('/api/me/tasks/manual/:id', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  const { completed, title, dueAt } = req.body || {}
  const updates = {}
  if (typeof completed === 'boolean') {
    updates.completed_at = completed ? nowIso() : null
  }
  if (typeof title === 'string' && title.trim()) {
    updates.title = title.trim().slice(0, 500)
  }
  if (typeof dueAt === 'string') {
    const due = new Date(dueAt)
    if (!Number.isNaN(due.getTime())) updates.due_at = due.toISOString()
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: { message: 'No valid fields to update' } })
  }
  try {
    const { data, error } = await supabase
      .from('user_manual_tasks')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()
    if (error) throw error
    if (!data) return res.status(404).json({ error: { message: 'Task not found' } })
    res.json({ task: mapManualTaskRow(data) })
  } catch (e) {
    console.error('PATCH /api/me/tasks/manual:', e)
    res.status(500).json({ error: { message: e.message || 'Could not update task' } })
  }
})

app.delete('/api/me/tasks/manual/:id', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  try {
    const { error } = await supabase.from('user_manual_tasks').delete().eq('id', id).eq('user_id', userId)
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/me/tasks/manual:', e)
    res.status(500).json({ error: { message: e.message || 'Could not delete task' } })
  }
})

// ---- Grade tracker (issue #10) -------------------------------------------
const LETTER_GRADE_SET = new Set(LETTER_GRADES)

function mapGradeRow(row) {
  return {
    id: row.id,
    courseName: row.course_name,
    term: row.term,
    creditHours: typeof row.credit_hours === 'string' ? Number(row.credit_hours) : row.credit_hours,
    letterGrade: row.letter_grade,
  }
}

// Validate + coerce a request body into DB columns. Returns { value } on success
// or { error } with a user-facing message. `partial` allows missing fields
// (PATCH); a full insert requires courseName + letterGrade.
function parseGradeBody(body, { partial } = {}) {
  const updates = {}
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k)

  if (has('courseName') || !partial) {
    const name = String(body?.courseName ?? '').trim()
    if (!name || name.length > MAX_COURSE_NAME) {
      return { error: `Course name is required (max ${MAX_COURSE_NAME} characters)` }
    }
    updates.course_name = name
  }
  if (has('letterGrade') || !partial) {
    const letter = String(body?.letterGrade ?? '').trim()
    if (!LETTER_GRADE_SET.has(letter)) {
      return { error: 'A valid letter grade is required' }
    }
    updates.letter_grade = letter
  }
  if (has('term') || !partial) {
    const term = String(body?.term ?? '').trim().slice(0, MAX_TERM_NAME) || DEFAULT_TERM
    updates.term = term
  }
  if (has('creditHours') || !partial) {
    const n = Number(body?.creditHours ?? DEFAULT_CREDIT_HOURS)
    if (!Number.isFinite(n) || n < 0 || n > MAX_CREDIT_HOURS) {
      return { error: `Credit hours must be between 0 and ${MAX_CREDIT_HOURS}` }
    }
    updates.credit_hours = Math.round(n * 100) / 100
  }
  return { value: updates }
}

app.get('/api/me/grades', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const { data, error } = await supabase
      .from('user_grades')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (error) throw error
    res.json({ grades: (data || []).map(mapGradeRow) })
  } catch (e) {
    console.error('GET /api/me/grades:', e?.message || e)
    res.json({ grades: [], unavailable: true })
  }
})

app.post('/api/me/grades', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { value, error: invalid } = parseGradeBody(req.body || {}, { partial: false })
  if (invalid) return res.status(400).json({ error: { message: invalid } })
  try {
    const { data, error } = await supabase
      .from('user_grades')
      .insert({ user_id: userId, ...value })
      .select()
      .single()
    if (error) throw error
    res.json({ grade: mapGradeRow(data) })
  } catch (e) {
    console.error('POST /api/me/grades:', e)
    res.status(500).json({ error: { message: e.message || 'Could not save course' } })
  }
})

app.patch('/api/me/grades/:id', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  const { value, error: invalid } = parseGradeBody(req.body || {}, { partial: true })
  if (invalid) return res.status(400).json({ error: { message: invalid } })
  if (Object.keys(value).length === 0) {
    return res.status(400).json({ error: { message: 'No valid fields to update' } })
  }
  try {
    const { data, error } = await supabase
      .from('user_grades')
      .update(value)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()
    if (error) throw error
    if (!data) return res.status(404).json({ error: { message: 'Course not found' } })
    res.json({ grade: mapGradeRow(data) })
  } catch (e) {
    console.error('PATCH /api/me/grades/:id:', e)
    res.status(500).json({ error: { message: e.message || 'Could not update course' } })
  }
})

app.delete('/api/me/grades/:id', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  try {
    const { error } = await supabase.from('user_grades').delete().eq('id', id).eq('user_id', userId)
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/me/grades/:id:', e)
    res.status(500).json({ error: { message: e.message || 'Could not delete course' } })
  }
})

// Selected major for the degree planner (issue #18). Validated against the
// degreePrograms catalogue; null clears it.
app.get('/api/me/degree', requireAuth, async (req, res) => {
  res.json({ major: req.currentUser.major ?? null })
})

app.put('/api/me/degree', requireAuth, async (req, res) => {
  const raw = req.body?.major
  const major = raw == null || raw === '' ? null : String(raw)
  if (major !== null && !getProgram(major)) {
    return res.status(400).json({ error: { message: 'Unknown major' } })
  }
  const { error } = await supabase.from('users').update({ major }).eq('id', req.currentUser.id)
  if (error) {
    console.error('PUT /api/me/degree:', error.message)
    return res.status(500).json({ error: { message: 'Could not save your major.' } })
  }
  res.json({ major })
})

app.get('/api/me/classes', requireAuth, async (req, res) => {
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20
  const term = typeof req.query.term === 'string' ? req.query.term : 'auto'
  const mode = typeof req.query.mode === 'string' ? req.query.mode : 'display'
  const data = await getClassItemsForUser(req.currentUser.id, { limit, term, mode })
  res.json(data)
})

app.get('/api/me/events', requireAuth, async (req, res) => {
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20
  res.json({ items: await listCalendarItems(req.currentUser.id, { category: 'event', limit, order: 'asc' }) })
})

// ── Calendar feed: subscribable .ics of the user's aggregated calendar (#48) ──
// The token IS the only credential on the public feed URL, so it must be a
// UUID v4, is never logged, and is regenerable (regenerating invalidates the
// old link). See db/supabase-calendar-feed.sql and docs/RATE_LIMITS.md.

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FEED_HORIZON_MONTHS = 6

function feedUrlForToken(token) {
  return `${publicBaseUrl}/feeds/calendar/${token}.ics`
}

app.get('/api/me/calendar-feed', requireAuth, (req, res) => {
  const token = req.currentUser.calendar_feed_token
  res.json({ feedUrl: token ? feedUrlForToken(token) : null })
})

app.post('/api/me/calendar-feed/token', requireAuth, async (req, res) => {
  const token = crypto.randomUUID()
  const { error } = await supabase
    .from('users')
    .update({ calendar_feed_token: token })
    .eq('id', req.currentUser.id)
  if (error) {
    console.error('POST /api/me/calendar-feed/token:', error.message)
    return res.status(500).json({ error: { message: 'Could not generate a calendar feed link. Please try again.', status: 500 } })
  }
  res.json({ feedUrl: feedUrlForToken(token) })
})

app.get('/feeds/calendar/:file', calendarFeedRateLimit, async (req, res) => {
  const file = String(req.params.file || '')
  if (!file.toLowerCase().endsWith('.ics')) {
    return res.status(404).type('text/plain').send('Not found')
  }
  const token = file.slice(0, -'.ics'.length)
  if (!UUID_V4_RE.test(token)) {
    return res.status(404).type('text/plain').send('Not found')
  }

  // Look the user up by token only — never logged, never reflected back.
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id')
    .eq('calendar_feed_token', token)
    .maybeSingle()
  if (userErr || !user) {
    return res.status(404).type('text/plain').send('Not found')
  }

  const now = new Date()
  const horizon = new Date(now)
  horizon.setMonth(horizon.getMonth() + FEED_HORIZON_MONTHS)

  const [itemsRes, tasksRes] = await Promise.all([
    supabase
      .from('calendar_items')
      .select('id, title, description, start_time, end_time, location')
      .eq('user_id', user.id)
      .gte('start_time', now.toISOString())
      .lte('start_time', horizon.toISOString())
      .order('start_time', { ascending: true }),
    supabase
      .from('user_manual_tasks')
      .select('id, title, due_at')
      .eq('user_id', user.id)
      .is('completed_at', null)
      .order('due_at', { ascending: true }),
  ])

  if (itemsRes.error || tasksRes.error) {
    console.error('GET /feeds/calendar:', itemsRes.error?.message || tasksRes.error?.message)
    return res.status(500).type('text/plain').send('Calendar feed temporarily unavailable')
  }

  const events = []
  for (const row of itemsRes.data || []) {
    events.push({
      uid: row.id,
      summary: row.title || 'Untitled',
      description: row.description || undefined,
      location: row.location || undefined,
      start: new Date(row.start_time),
      end: row.end_time ? new Date(row.end_time) : undefined,
    })
  }
  for (const task of tasksRes.data || []) {
    events.push({
      uid: `manual-${task.id}`,
      summary: task.title || 'Task',
      start: new Date(task.due_at),
      allDay: true,
    })
  }

  const ics = buildCalendarFeed({ events, now })
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Content-Disposition', 'inline; filename="boilerindy.ics"')
  res.setHeader('Cache-Control', 'private, max-age=900')
  res.send(ics)
})

// ── Lost & Found: standalone feature, independent of the board (issue #47) ────

const LOST_FOUND_TYPES = new Set(['lost', 'found'])

function mapLostFoundRow(row, userId) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    location: row.location,
    contact: row.contact,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isOwner: row.user_id === userId,
  }
}

function cleanField(value, max) {
  const trimmed = String(value ?? '').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

app.get('/api/lost-found', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const type = typeof req.query.type === 'string' && LOST_FOUND_TYPES.has(req.query.type) ? req.query.type : null
  const status = req.query.status === 'resolved' || req.query.status === 'open' ? req.query.status : null
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : ''

  let query = supabase
    .from('lost_found_items')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)

  if (type) query = query.eq('type', type)
  if (status) query = query.eq('status', status)
  if (search) query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%,location.ilike.%${search}%`)

  const { data, error } = await query
  if (error) {
    console.error('GET /api/lost-found:', error.message)
    return res.json({ items: [], unavailable: true })
  }
  res.json({ items: (data || []).map((row) => mapLostFoundRow(row, userId)) })
})

app.post('/api/lost-found', lostFoundWriteRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const type = String(req.body?.type || '').trim()
  if (!LOST_FOUND_TYPES.has(type)) {
    return res.status(400).json({ error: { message: 'Type must be "lost" or "found".', status: 400 } })
  }
  const title = cleanField(req.body?.title, 200)
  if (!title) {
    return res.status(400).json({ error: { message: 'A short title is required.', status: 400 } })
  }
  const description = cleanField(req.body?.description, 2000)
  const location = cleanField(req.body?.location, 200)
  const contact = cleanField(req.body?.contact, 200)

  // Reuse the campus board's profanity policy so all user text is moderated.
  const policy = assertBoardPostTextAllowed(title, `${description || ''}\n${location || ''}`)
  if (!policy.ok) {
    return res.status(400).json({ error: { message: policy.message, status: 400 } })
  }

  const { data, error } = await supabase
    .from('lost_found_items')
    .insert({ user_id: userId, type, title, description, location, contact, status: 'open' })
    .select()
    .single()
  if (error) {
    console.error('POST /api/lost-found:', error.message)
    return res.status(500).json({ error: { message: 'Could not save your post. Please try again.', status: 500 } })
  }
  res.status(201).json({ item: mapLostFoundRow(data, userId) })
})

app.patch('/api/lost-found/:id', lostFoundWriteRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params

  const { data: existing, error: findErr } = await supabase
    .from('lost_found_items')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })
  }
  if (existing.user_id !== userId) {
    return res.status(403).json({ error: { message: 'You can only edit your own posts.', status: 403 } })
  }

  const patch = {}
  if (req.body?.status === 'resolved' || req.body?.status === 'open') patch.status = req.body.status
  if (req.body?.title !== undefined) {
    const title = cleanField(req.body.title, 200)
    if (!title) return res.status(400).json({ error: { message: 'Title cannot be empty.', status: 400 } })
    patch.title = title
  }
  if (req.body?.description !== undefined) patch.description = cleanField(req.body.description, 2000)
  if (req.body?.location !== undefined) patch.location = cleanField(req.body.location, 200)
  if (req.body?.contact !== undefined) patch.contact = cleanField(req.body.contact, 200)

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: { message: 'Nothing to update.', status: 400 } })
  }

  const nextTitle = patch.title ?? existing.title
  const nextDesc = patch.description ?? existing.description
  const nextLoc = patch.location ?? existing.location
  const policy = assertBoardPostTextAllowed(nextTitle, `${nextDesc || ''}\n${nextLoc || ''}`)
  if (!policy.ok) {
    return res.status(400).json({ error: { message: policy.message, status: 400 } })
  }

  const { data, error } = await supabase
    .from('lost_found_items')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) {
    console.error('PATCH /api/lost-found/:id:', error.message)
    return res.status(500).json({ error: { message: 'Could not update the post.', status: 500 } })
  }
  res.json({ item: mapLostFoundRow(data, userId) })
})

app.delete('/api/lost-found/:id', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  const { data, error } = await supabase
    .from('lost_found_items')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select('id')
  if (error) {
    console.error('DELETE /api/lost-found/:id:', error.message)
    return res.status(500).json({ error: { message: 'Could not delete the post.', status: 500 } })
  }
  if (!data || data.length === 0) {
    return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })
  }
  res.json({ ok: true })
})

// ── Customizable home dashboard layout (issue #52) ───────────────────────────
// Per-user widget order/size/visibility, stored as JSONB on users. NULL means
// the user has never customized, so the client applies the default layout.

app.get('/api/me/dashboard', requireAuth, async (req, res) => {
  const stored = req.currentUser.dashboard_layout
  // Never customized → return the default so the client always has a layout.
  const layout = stored == null ? defaultLayout() : normalizeLayout(stored)
  res.json({ layout })
})

app.put('/api/me/dashboard', requireAuth, async (req, res) => {
  // Sanitize untrusted client input against the widget allowlist before storing.
  const layout = normalizeLayout(req.body?.layout)
  const { error } = await supabase
    .from('users')
    .update({ dashboard_layout: layout })
    .eq('id', req.currentUser.id)
  if (error) {
    console.error('PUT /api/me/dashboard:', error.message)
    return res.status(500).json({ error: { message: 'Could not save your dashboard layout.', status: 500 } })
  }
  res.json({ layout })
})

app.get('/', (_req, res) => {
  res.redirect(clientAppUrl)
})

// ============================================================
// Gemini campus assistant
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
const TZ = 'America/Indiana/Indianapolis'

// In-memory rate limiter: keyed by user ID (authed) or IP (anon)
const _geminiWindows = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _geminiWindows) if (now >= v.resetAt) _geminiWindows.delete(k)
}, 60 * 60 * 1000)

function geminiAllowed(key, max) {
  const now = Date.now()
  const win = _geminiWindows.get(key)
  if (!win || now >= win.resetAt) {
    _geminiWindows.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 })
    return true
  }
  if (win.count >= max) return false
  win.count++
  return true
}

const CAMPUS_SYSTEM_PROMPT = `You are BoilerIndy — a helpful campus assistant for Purdue University Indianapolis (Purdue Indy / IUPUI).
You have access to real-time data about the student's schedule, dining, and campus events — all provided in the context block below.
Use that data to answer questions directly and accurately. Do not tell the student to "check the app" or "check the tab" when the answer is already in the context.

You help students with:
- Their personal class schedule (including earlier today and what's in session), upcoming assignments, exams, and due dates (from context)
- Dining hours and today's menu at each location (from context)
- Campus / career / optional events (from context)
- Where to study and get help on campus (use the ON-CAMPUS STUDY & HELP section when relevant)
- Campus transit/buses: Crimson & Gray routes run Mon–Fri 6:30am–10pm; Yellow & Blue run Mon–Fri 5:30am–midnight; Purple runs Mon–Fri 7am–10pm; Orange runs Sat–Sun 9am–8pm
- Buildings: ET Building (engineering/tech), Campus Center (dining, student services), University Library, Science & Engineering Lab Building (SL), Cavanaugh Hall (CA), Hine Hall (HH), Madam Walker Legacy Center, IUPUI Tower
- Student services: ASC tutoring (Campus Center 2nd floor), printing (library 25 free pages/day), Health & Wellness Center, Financial Aid (Cavanaugh Hall), Registrar (Cavanaugh Hall)
- General student life at Purdue Indy

Rules:
- Be concise and friendly. For simple questions: 2–4 sentences. For "what should I do now?", "plan my afternoon", or similar planning questions: give a short prioritized plan (3–6 sentences or brief bullets), because multiple commitments may apply.
- Answer directly from the context data when available — do not hedge or defer.
- When the student asks what to do *now*, *next*, or how to balance their time: anchor on CURRENT DATE & TIME. Weigh together: (1) anything in HAPPENING NOW, (2) classes or exams starting within the next ~2 hours, (3) homework or projects due in the next 24–48 hours (especially tonight), (4) upcoming exams/quizzes that need prep time, (5) optional campus events. Do **not** push optional events over urgent coursework or tight deadlines unless they are clearly free.
- If homework is due tonight, say so and suggest when to work on it relative to class, meals, and events already on their calendar.
- For exam prep or heavy homework blocks, suggest concrete on-campus options from the STUDY & HELP section (e.g. library quiet floors, ET/SL for STEM, ASC tutoring for support — match to subject when possible).
- For "next class" questions only count regular lectures/labs/discussions, not exams or office hours (unless asked).
- If something is genuinely unknown (not in context and not general knowledge), say so briefly.
- If asked about something totally unrelated to campus life, briefly redirect.`

// ── Context formatters ────────────────────────────────────────────────────────

function fmtTime(isoStr, opts = {}) {
  return new Date(isoStr).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', ...opts })
}
function fmtDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' })
}

function buildDiningContext(dining) {
  if (!dining?.ok || !dining.locations?.length) return ''
  const lines = [`=== DINING TODAY (${dining.date}) ===`]
  for (const loc of dining.locations) {
    const status = loc.is_open ? 'OPEN' : 'CLOSED'
    const hrs = loc.hours && loc.hours !== 'Closed today' ? ` — ${loc.hours}` : ''
    lines.push(`${loc.name}: ${status}${hrs}`)
    if (loc.stations?.length) {
      for (const station of loc.stations) {
        const items = (station.items || []).slice(0, 8).map(it => {
          const tags = (it.icons || []).filter(t => ['Vegan', 'Vegetarian', 'Avoiding Gluten'].includes(t))
          return `${it.name}${it.calories ? ` ${it.calories}cal` : ''}${tags.length ? ` (${tags.join('/')})` : ''}`
        })
        if (items.length) lines.push(`  ${station.name}: ${items.join(', ')}`)
      }
    } else if (loc.meal) {
      lines.push(`  Menus: ${loc.meal}`)
    }
  }
  return lines.join('\n')
}

function summarizeClassSchedule(classes) {
  const byName = new Map()
  for (const c of classes) {
    const name = c.title || 'Untitled'
    if (!byName.has(name)) byName.set(name, new Set())
    const day = new Date(c.start_time).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' })
    byName.get(name).add(day)
  }
  if (!byName.size) return 'No upcoming classes found.'
  return [...byName.entries()]
    .map(([name, days]) => `${name} (${[...days].join(', ')})`)
    .join('; ')
}

const ASSISTANT_ASSIGNMENT_CATEGORIES = new Set([
  'assignment', 'task', 'homework', 'submission', 'deadline', 'quiz', 'project',
  'paper', 'presentation', 'lab', 'midterm',
])

function isExamLikeCalendarRow(r) {
  const t = `${r.title || ''}`
  if (/\b(midterm|final|exam|quiz|test)\b/i.test(t)) return true
  return ['exam', 'quiz', 'midterm'].includes(r.category)
}

function isSameZonedCalendarDay(isoStr, refDate, timeZone) {
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return false
  const a = d.toLocaleDateString('en-CA', { timeZone })
  const b = refDate.toLocaleDateString('en-CA', { timeZone })
  return a === b
}

/** Rich calendar context for /api/assistant: today, ongoing, exams, assignments, events, study hints. */
function buildAssistantCalendarContext(calendarData, now) {
  if (!calendarData?.length) {
    return '=== CALENDAR ===\nNo calendar items in the fetched window.'
  }

  const examTitleRe = /\b(midterm|final|exam|quiz|test)\b/i
  const nowMs = now.getTime()

  const classRows = calendarData.filter((r) => r.category === 'class' && !examTitleRe.test(r.title || ''))
  const assignmentRows = calendarData.filter((r) => ASSISTANT_ASSIGNMENT_CATEGORIES.has(r.category))
  const examRows = calendarData.filter((r) => isExamLikeCalendarRow(r))
  const eventRows = calendarData.filter((r) => ['event', 'campus_event', 'activity'].includes(r.category))

  const ongoing = calendarData.filter((r) => {
    if (!r.start_time || !r.end_time) return false
    const s = new Date(r.start_time).getTime()
    const e = new Date(r.end_time).getTime()
    return s <= nowMs && e > nowMs
  })

  const todayRows = calendarData
    .filter((r) => r.start_time && isSameZonedCalendarDay(r.start_time, now, TZ))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))

  const parts = []

  parts.push(`=== COURSES (meeting pattern from upcoming instances) ===\n${summarizeClassSchedule(classRows)}`)

  if (ongoing.length) {
    parts.push('=== HAPPENING NOW (in session) ===')
    parts.push(
      ongoing
        .map((i) => `- Until ${fmtTime(i.end_time)}: ${i.title} [${i.category}]${i.location ? ` @ ${i.location}` : ''}`)
        .join('\n'),
    )
  }

  if (todayRows.length) {
    const dayLabel = now.toLocaleDateString('en-US', {
      timeZone: TZ,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    })
    parts.push(`=== TODAY (${dayLabel}) — everything with times (Eastern) ===`)
    parts.push(
      todayRows
        .map((i) => {
          const range = i.end_time
            ? `${fmtTime(i.start_time)}–${fmtTime(i.end_time)}`
            : fmtTime(i.start_time)
          return `- ${range}: ${i.title} [${i.category}]${i.location ? ` @ ${i.location}` : ''}`
        })
        .join('\n'),
    )
  }

  if (assignmentRows.length) {
    parts.push('=== UPCOMING ASSIGNMENTS / HOMEWORK / DEADLINES ===')
    parts.push(
      assignmentRows
        .map((i) => `- Due ${fmtDate(i.start_time)} ${fmtTime(i.start_time)}: ${i.title}${i.location ? ` (${i.location})` : ''} [${i.category}]`)
        .join('\n'),
    )
  } else {
    parts.push('=== UPCOMING ASSIGNMENTS / HOMEWORK / DEADLINES ===\nNone in the fetched window.')
  }

  if (examRows.length) {
    parts.push('=== UPCOMING EXAMS, QUIZZES & HIGH-STAKES DATES ===')
    parts.push(
      examRows
        .map((i) => `- ${fmtDate(i.start_time)} ${fmtTime(i.start_time)}: ${i.title}${i.location ? ` @ ${i.location}` : ''} [${i.category}]`)
        .join('\n'),
    )
  }

  if (eventRows.length) {
    parts.push('=== CAMPUS / CAREER / OPTIONAL EVENTS ===')
    parts.push(
      eventRows
        .map((i) => `- ${fmtDate(i.start_time)} ${fmtTime(i.start_time)}${i.location ? ` @ ${i.location}` : ''}: ${i.title}`)
        .join('\n'),
    )
  }

  parts.push(`=== ON-CAMPUS STUDY & HELP (suggest when relevant) ===
- University Library: quiet floors, study rooms, printing (25 free pages/day).
- ET Building & Science/Engineering Lab (SL): strong for STEM work between classes.
- Cavanaugh Hall & Hine Hall: lounges for shorter sessions.
- ASC tutoring: Campus Center 2nd floor — math, writing, coaching (check hours).
- Campus Center: food and space to regroup before/after events.`)

  return parts.join('\n\n')
}

app.post('/api/assistant', requireAuth, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Assistant not configured.' })
  }

  const rlKey = req.session?.userId || req.ip || 'anon'
  if (!geminiAllowed(rlKey, 20)) {
    return res.status(429).json({ error: 'Rate limit reached. Try again in an hour.' })
  }

  const { messages } = req.body
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' })
  }
  if (messages.length > 30) {
    return res.status(400).json({ error: 'Too many messages in one request.' })
  }
  for (const message of messages) {
    if (typeof message?.content === 'string' && message.content.length > 4000) {
      return res.status(400).json({ error: 'A message is too long.' })
    }
  }

  const now = new Date()
  const nowISOStr = now.toISOString()
  const fourWeeksOut = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString()
  const nowLabel = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const timeLabel = now.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })

  // Fetch all context in parallel
  const [diningData, calendarData] = await Promise.all([
    getDiningSnapshot({}).catch(() => null),
    (async () => {
      try {
        const user = await getCurrentUser(req)
        if (!user) return null
        const lowerBound = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
        const sel = 'id, title, start_time, end_time, location, category'
        const [upcomingRes, ongoingRes] = await Promise.all([
          supabase
            .from('calendar_items')
            .select(sel)
            .eq('user_id', user.id)
            .gte('start_time', lowerBound)
            .lte('start_time', fourWeeksOut)
            .order('start_time', { ascending: true })
            .limit(100),
          supabase
            .from('calendar_items')
            .select(sel)
            .eq('user_id', user.id)
            .lt('start_time', nowISOStr)
            .gt('end_time', nowISOStr)
            .limit(25),
        ])
        const upcoming = upcomingRes.data || []
        const ongoingRows = ongoingRes.data || []
        const byId = new Map()
        for (const r of ongoingRows) byId.set(r.id, r)
        for (const r of upcoming) byId.set(r.id, r)
        return [...byId.values()].sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      } catch {
        return null
      }
    })(),
  ])

  const diningCtx = buildDiningContext(diningData)
  const calendarCtx = calendarData ? buildAssistantCalendarContext(calendarData, now) : ''

  const contextBlock = [
    `=== CURRENT DATE & TIME ===\n${nowLabel} at ${timeLabel} (Eastern)`,
    diningCtx,
    calendarCtx,
  ].filter(Boolean).join('\n\n')

  const systemPrompt = CAMPUS_SYSTEM_PROMPT + '\n\n' + contextBlock

  const contents = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 2800, temperature: 0.52 },
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('Gemini error:', err)
      return res.status(502).json({ error: 'AI service error' })
    }

    const data = await response.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "Sorry, I couldn't generate a response."
    res.json({ reply: text })
  } catch (err) {
    console.error('Assistant error:', err)
    res.status(500).json({ error: 'Assistant request failed' })
  }
})

// ── Tiny in-memory TTL cache for quasi-static upstream/DB reads (perf) ──────
// Repeat calls within the TTL return instantly instead of re-hitting TransLoc /
// Supabase on every page load. Failures are never cached. Process-local — fine
// for a single instance; swap for Redis if the backend is ever horizontally scaled.
const _ttlCache = new Map() // key -> { value, expiresAt }
async function getCached(key, ttlMs, producer) {
  const now = Date.now()
  const hit = _ttlCache.get(key)
  if (hit && now < hit.expiresAt) return hit.value
  const value = await producer()
  _ttlCache.set(key, { value, expiresAt: now + ttlMs })
  return value
}

// TransLoc API proxy endpoints (to avoid CORS issues)
const TRANSLOC_API = 'https://iuindianapolis.transloc.com/Services/JSONPRelay.svc'
const TRANSLOC_API_KEY = process.env.TRANSLOC_API_KEY || '8882812681'
const TRANSLOC_STATIC_TTL_MS = 10 * 60 * 1000 // routes/stops barely change
const TRANSLOC_VEHICLES_TTL_MS = 5 * 1000 // live positions: short, just dedupes bursts

app.get('/api/transit/vehicles', publicReadRateLimit, async (_req, res) => {
  try {
    const data = await getCached('transit:vehicles', TRANSLOC_VEHICLES_TTL_MS, async () => {
      const response = await fetch(`${TRANSLOC_API}/GetMapVehiclePoints?apiKey=${TRANSLOC_API_KEY}&isPublicMap=true`)
      return response.json()
    })
    res.json(data)
  } catch (error) {
    console.error('TransLoc vehicles error:', error)
    res.status(500).json({ error: 'Failed to fetch vehicle data' })
  }
})

app.get('/api/transit/stops', publicReadRateLimit, async (_req, res) => {
  try {
    const data = await getCached('transit:stops', TRANSLOC_STATIC_TTL_MS, async () => {
      const response = await fetch(`${TRANSLOC_API}/GetStops?apiKey=${TRANSLOC_API_KEY}`)
      return response.json()
    })
    res.json(data)
  } catch (error) {
    console.error('TransLoc stops error:', error)
    res.status(500).json({ error: 'Failed to fetch stops data' })
  }
})

app.get('/api/transit/routes', publicReadRateLimit, async (_req, res) => {
  try {
    const data = await getCached('transit:routes', TRANSLOC_STATIC_TTL_MS, async () => {
      const response = await fetch(`${TRANSLOC_API}/GetRoutes?apiKey=${TRANSLOC_API_KEY}`)
      return response.json()
    })
    res.json(data)
  } catch (error) {
    console.error('TransLoc routes error:', error)
    res.status(500).json({ error: 'Failed to fetch routes data' })
  }
})

app.get('/api/dining', publicReadRateLimit, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined
    const data = await getDiningSnapshot({ forceRefresh, date })
    res.json(data)
  } catch (error) {
    console.error('Nutrislice dining error:', error)
    res.status(500).json({ ok: false, error: 'dining_internal', locations: [] })
  }
})

// ---- Dining favorites (issue #49) ---------------------------------------
// Per-user favorited menu-item names. The Dining page stars items and shows a
// "your favorites on today's menu" section by cross-referencing these against
// the public /api/dining snapshot. Requires db/supabase-dining-favorites.sql.

app.get('/api/me/dining/favorites', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const { data, error } = await supabase
      .from('user_dining_favorites')
      .select('item_name')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (error) throw error
    res.json({ favorites: (data || []).map((r) => r.item_name) })
  } catch (e) {
    // Degrade gracefully so the dining page still renders without favorites.
    console.error('GET /api/me/dining/favorites:', e?.message || e)
    res.json({ favorites: [], unavailable: true })
  }
})

app.post('/api/me/dining/favorites', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const itemName = normalizeItemName(req.body?.itemName)
  if (!itemName) return res.status(400).json({ error: { message: 'An item name is required' } })
  try {
    const { error } = await supabase
      .from('user_dining_favorites')
      .upsert({ user_id: userId, item_name: itemName }, { onConflict: 'user_id,item_name' })
    if (error) throw error
    res.json({ ok: true, itemName })
  } catch (e) {
    console.error('POST /api/me/dining/favorites:', e?.message || e)
    res.status(500).json({ error: { message: e.message || 'Could not save favorite' } })
  }
})

app.delete('/api/me/dining/favorites', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const itemName = normalizeItemName(req.body?.itemName ?? req.query?.itemName)
  if (!itemName) return res.status(400).json({ error: { message: 'An item name is required' } })
  try {
    const { error } = await supabase
      .from('user_dining_favorites')
      .delete()
      .eq('user_id', userId)
      .eq('item_name', itemName)
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/me/dining/favorites:', e?.message || e)
    res.status(500).json({ error: { message: e.message || 'Could not remove favorite' } })
  }
})

// ============================================================
// Board API
// ============================================================

const BOARD_SQL_FILE = 'db/supabase-board-only.sql'

function isBoardSchemaMissingError(err) {
  const m = String(err?.message || '')
  const c = String(err?.code || '')
  return (
    m.includes('schema cache') ||
    m.includes('Could not find the table') ||
    m.includes('does not exist') && m.includes('board_posts') ||
    c === 'PGRST205' ||
    c === '42P01'
  )
}

function respondBoardDbError(res, err) {
  console.error('Board DB error:', err?.message || err, err?.code, err?.details)
  if (isBoardSchemaMissingError(err)) {
    return res.status(503).json({
      error: {
        message: `Campus board tables are missing in Supabase. In the dashboard: SQL Editor → paste and run the file ${BOARD_SQL_FILE} from this repo → Run. Wait a few seconds, then try again.`,
        code: 'board_schema_missing',
        status: 503,
      },
    })
  }
  return res.status(500).json({
    error: { message: 'Something went wrong. Please try again.', status: 500 },
  })
}

app.get('/api/board/posts', requireAuth, async (req, res) => {
  const sort = req.query.sort === 'popular' ? 'popular' : 'recent'

  // select('*') keeps the board working whether or not the optional
  // edited_at migration (db/supabase-board-only.sql) has been applied yet
  let query = supabase
    .from('board_posts')
    .select('*')
  if (sort === 'popular') {
    query = query
      .order('pinned', { ascending: false })
      .order('upvote_count', { ascending: false })
      .order('created_at', { ascending: false })
  } else {
    query = query
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
  }
  const { data: postsData, error: postsError } = await query.limit(100)
  if (postsError) return respondBoardDbError(res, postsError)

  const postIds = postsData.map(p => p.id)
  let repliesData = []
  if (postIds.length > 0) {
    const { data: rd } = await supabase
      .from('board_replies')
      .select('id, post_id, body, is_anon, created_at, user_id')
      .in('post_id', postIds)
      .order('created_at', { ascending: true })
    repliesData = rd || []
  }

  // Batch-fetch display names for all non-anonymous user IDs
  const allUserIds = new Set()
  for (const p of postsData) { if (!p.is_anon) allUserIds.add(p.user_id) }
  for (const r of repliesData) { if (!r.is_anon) allUserIds.add(r.user_id) }
  const nameMap = {}
  if (allUserIds.size > 0) {
    const { data: usersData } = await supabase
      .from('users')
      .select('id, display_name')
      .in('id', [...allUserIds])
    if (usersData) {
      for (const u of usersData) nameMap[u.id] = u.display_name
    }
  }

  let upvotedIds = new Set()
  if (postIds.length > 0) {
    const { data: uv } = await supabase
      .from('board_upvotes')
      .select('post_id')
      .eq('user_id', req.currentUser.id)
      .in('post_id', postIds)
    if (uv) uv.forEach(r => upvotedIds.add(r.post_id))
  }

  const repliesByPost = {}
  for (const reply of repliesData) {
    if (!repliesByPost[reply.post_id]) repliesByPost[reply.post_id] = []
    repliesByPost[reply.post_id].push({
      id: reply.id,
      body: reply.body,
      user: reply.is_anon ? 'Anonymous' : (nameMap[reply.user_id] || 'Student'),
      time: reply.created_at,
    })
  }

  const myId = req.currentUser.id
  const posts = postsData.map(p => ({
    id: p.id,
    title: p.title,
    body: p.body,
    anon: p.is_anon,
    user: p.is_anon ? 'Anonymous' : (nameMap[p.user_id] || 'Student'),
    upvotes: p.upvote_count,
    pinned: p.pinned,
    hot: !p.pinned && p.upvote_count >= 10,
    time: p.created_at,
    tags: Array.isArray(p.tags) ? p.tags : [],
    editedTime: p.edited_at || null,
    upvotedByMe: upvotedIds.has(p.id),
    isMine: p.user_id === myId,
    replies: repliesByPost[p.id] || [],
  }))

  res.json({ posts })
})

const BOARD_TAG_CANDIDATES = [
  'dining', 'parking', 'tutoring', 'housing', 'transit', 'library',
  'career', 'health', 'clubs', 'sports', 'tech', 'financial-aid',
  'study-spots', 'events', 'classes', 'safety',
]

app.post('/api/board/ai-suggestions', requireAuth, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      error: { message: 'AI suggestions are not configured.', status: 503 },
    })
  }

  if (!geminiAllowed(req.session.userId, 10)) {
    return res.status(429).json({
      error: { message: 'Rate limit reached. Try again in an hour.', status: 429 },
    })
  }
  const context = req.body.context === 'reply' ? 'reply' : 'compose'
  const title = String(req.body.title || '').trim().slice(0, 300)
  const body = String(req.body.body || '').trim().slice(0, 1200)
  const postTitle = String(req.body.postTitle || '').trim().slice(0, 300)
  const postBody = String(req.body.postBody || '').trim().slice(0, 800)
  const draft = String(req.body.draft || '').trim().slice(0, 1000)

  if (context === 'compose') {
    if (title.length < 6 && body.length < 20) {
      return res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
    }
  } else if (draft.length < 8) {
    return res.json({ replyTip: null })
  }

  const tagList = BOARD_TAG_CANDIDATES.join(', ')
  const userText =
    context === 'compose'
      ? `The student is composing a question for a Purdue Indianapolis campus board.\n\nTitle (draft):\n${title}\n\nBody (draft):\n${body || '(empty)'}\n\nReturn ONLY a JSON object, no markdown code fences, with this exact shape:\n{"betterTitle":string|null,"bodyAddOn":string|null,"tags":string[]}\n\n- betterTitle: a clearer full title under 120 characters, or null if the draft title is already good.\n- bodyAddOn: one short optional sentence they could add for context (location, course, deadline), or null if not needed.\n- tags: 0 to 3 items, each must be exactly one of: ${tagList}\nUse JSON null (not the string "null") where appropriate.`
      : `Campus board thread title: ${postTitle}\nOriginal post:\n${postBody || '(no body)'}\n\nStudent's reply draft:\n${draft}\n\nReturn ONLY JSON: {"replyTip":string|null} — one concise coaching sentence (tone, specificity, or missing info), or null if the draft is fine.`

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: 350, temperature: 0.35 },
      }),
    })
    if (!response.ok) {
      console.error('Board AI suggestions:', await response.text())
      return res.status(502).json({ error: { message: 'AI service error', status: 502 } })
    }
    const data = await response.json()
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      return context === 'compose'
        ? res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
        : res.json({ replyTip: null })
    }
    let parsed
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return context === 'compose'
        ? res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
        : res.json({ replyTip: null })
    }

    if (context === 'compose') {
      const betterTitle =
        typeof parsed.betterTitle === 'string' ? parsed.betterTitle.trim().slice(0, 120) : null
      const bodyAddOn =
        typeof parsed.bodyAddOn === 'string' ? parsed.bodyAddOn.trim().slice(0, 400) : null
      const tags = Array.isArray(parsed.tags)
        ? parsed.tags
            .filter((t) => typeof t === 'string' && BOARD_TAG_CANDIDATES.includes(t.toLowerCase()))
            .map((t) => t.toLowerCase())
            .slice(0, 3)
        : []
      res.json({
        betterTitle: betterTitle || null,
        bodyAddOn: bodyAddOn || null,
        tags,
      })
    } else {
      const replyTip =
        typeof parsed.replyTip === 'string' ? parsed.replyTip.trim().slice(0, 240) : null
      res.json({ replyTip: replyTip || null })
    }
  } catch (e) {
    console.error('Board AI suggestions:', e?.message || e)
    return res.status(500).json({ error: { message: 'Suggestion request failed', status: 500 } })
  }
})

async function autoTagBoardPost(postId, title, body) {
  if (!GEMINI_API_KEY) return []
  const combined = `${title}\n${body}`.slice(0, 400)
  try {
    const resp = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: `You are a campus board post auto-tagger. Given a student's post, pick 1-3 of the most relevant tags from this list: ${BOARD_TAG_CANDIDATES.join(', ')}. Return ONLY a JSON array of strings, e.g. ["dining","parking"]. If nothing fits, return [].`,
          }],
        },
        contents: [{ role: 'user', parts: [{ text: combined }] }],
        generationConfig: { maxOutputTokens: 60, temperature: 0.1 },
      }),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'
    const match = raw.match(/\[.*\]/)
    if (!match) return []
    const parsed = JSON.parse(match[0])
    const tags = parsed
      .filter((t) => typeof t === 'string' && BOARD_TAG_CANDIDATES.includes(t.toLowerCase()))
      .map((t) => t.toLowerCase())
      .slice(0, 3)
    if (tags.length) {
      await supabase.from('board_posts').update({ tags }).eq('id', postId)
    }
    return tags
  } catch (e) {
    console.error('Auto-tag error:', e?.message || e)
    return []
  }
}

app.post('/api/board/posts', boardWriteRateLimit, requireAuth, async (req, res) => {
  const title = String(req.body.title || '').trim()
  const body  = String(req.body.body  || '').trim()
  const isAnon = req.body.anon === true || req.body.anon === 'true'

  if (!title) return res.status(400).json({ error: { message: 'Title is required.', status: 400 } })
  if (title.length > 300) return res.status(400).json({ error: { message: 'Title must be 300 characters or fewer.', status: 400 } })

  const profanityCheck = assertBoardPostTextAllowed(title, body)
  if (!profanityCheck.ok) {
    return res.status(400).json({ error: { message: profanityCheck.message, status: 400 } })
  }

  const userId = req.currentUser.id
  if (!userId) {
    return res.status(401).json({ error: { message: 'Invalid session.', status: 401 } })
  }

  const { data, error } = await supabase
    .from('board_posts')
    .insert({
      user_id: userId,
      title,
      body: body || '',
      is_anon: isAnon,
    })
    .select('id, title, body, is_anon, pinned, upvote_count, reply_count, created_at')
    .single()

  if (error) {
    console.error('board_posts insert:', error.message, error.code, error.details)
    return respondBoardDbError(res, error)
  }

  // Fire-and-forget: AI assigns tags in the background
  const tagsPromise = autoTagBoardPost(data.id, title, body)

  // Respond immediately so the UI doesn't block on AI
  const postPayload = {
    id: data.id,
    title: data.title,
    body: data.body,
    anon: data.is_anon,
    user: data.is_anon ? 'Anonymous' : (req.currentUser.display_name || 'Student'),
    upvotes: 0,
    pinned: false,
    hot: false,
    time: data.created_at,
    upvotedByMe: false,
    isMine: true,
    tags: [],
    replies: [],
  }

  // Wait briefly (200ms) in case AI is fast, so the user sees tags immediately
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 200))
  const quickTags = await Promise.race([tagsPromise, timeout])
  if (Array.isArray(quickTags) && quickTags.length) {
    postPayload.tags = quickTags
  }

  res.status(201).json({ post: postPayload })
})

app.post('/api/board/posts/:id/reply', boardWriteRateLimit, requireAuth, async (req, res) => {
  const postId = req.params.id
  const body   = String(req.body.body || '').trim()
  const isAnon = req.body.anon === true || req.body.anon === 'true'

  if (!body) return res.status(400).json({ error: { message: 'Reply body is required.', status: 400 } })
  if (boardTextFailsPolicy(body)) {
    return res.status(400).json({ error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
  }

  const { data: post, error: postError } = await supabase
    .from('board_posts')
    .select('id, reply_count')
    .eq('id', postId)
    .single()
  if (postError) return respondBoardDbError(res, postError)
  if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })

  const id = makeId()
  const timestamp = nowIso()
  const { data: reply, error: replyError } = await supabase
    .from('board_replies')
    .insert({ id, post_id: postId, user_id: req.currentUser.id, body, is_anon: isAnon, created_at: timestamp })
    .select('id, body, is_anon, created_at')
    .single()

  if (replyError) return respondBoardDbError(res, replyError)

  await supabase
    .from('board_posts')
    .update({ reply_count: post.reply_count + 1, updated_at: nowIso() })
    .eq('id', postId)

  res.status(201).json({
    reply: {
      id: reply.id,
      body: reply.body,
      user: reply.is_anon ? 'Anonymous' : req.currentUser.display_name,
      time: reply.created_at,
    }
  })
})

app.post('/api/board/posts/:id/upvote', boardWriteRateLimit, requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id

  const { data: post, error: postError } = await supabase
    .from('board_posts')
    .select('id, upvote_count')
    .eq('id', postId)
    .single()
  if (postError) return respondBoardDbError(res, postError)
  if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })

  const { error: insertError } = await supabase
    .from('board_upvotes')
    .insert({ post_id: postId, user_id: userId, created_at: nowIso() })

  let newCount, upvotedByMe
  if (insertError && insertError.code === '23505') {
    await supabase.from('board_upvotes').delete().eq('post_id', postId).eq('user_id', userId)
    newCount = Math.max(0, post.upvote_count - 1)
    upvotedByMe = false
  } else if (insertError) {
    return respondBoardDbError(res, insertError)
  } else {
    newCount = post.upvote_count + 1
    upvotedByMe = true
  }

  await supabase.from('board_posts').update({ upvote_count: newCount, updated_at: nowIso() }).eq('id', postId)
  res.json({ upvotes: newCount, upvotedByMe })
})

// Owner-only edit of a post's title/body (issue #7)
app.patch('/api/board/posts/:id', boardWriteRateLimit, requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id
  const title = String(req.body.title ?? '').trim()
  const body = String(req.body.body ?? '').trim()

  if (!title) return res.status(400).json({ error: { message: 'Title is required.', status: 400 } })
  if (title.length > 300) {
    return res.status(400).json({ error: { message: 'Title must be 300 characters or fewer.', status: 400 } })
  }

  const profanityCheck = assertBoardPostTextAllowed(title, body)
  if (!profanityCheck.ok) {
    return res.status(400).json({ error: { message: profanityCheck.message, status: 400 } })
  }

  const editedAt = nowIso()
  let { data, error } = await supabase
    .from('board_posts')
    .update({ title, body, edited_at: editedAt, updated_at: editedAt })
    .eq('id', postId)
    .eq('user_id', userId)
    .select('*')

  // Retry without edited_at when the optional column migration hasn't run yet
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    ;({ data, error } = await supabase
      .from('board_posts')
      .update({ title, body, updated_at: editedAt })
      .eq('id', postId)
      .eq('user_id', userId)
      .select('*'))
  }

  if (error) return respondBoardDbError(res, error)
  if (!data?.length) {
    return res.status(404).json({
      error: { message: 'Post not found or you can only edit your own posts.', status: 404 },
    })
  }

  const post = data[0]
  res.json({
    post: {
      id: post.id,
      title: post.title,
      body: post.body,
      editedTime: post.edited_at || editedAt,
    },
  })
})

app.delete('/api/board/posts/:id', requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id
  const { data, error } = await supabase
    .from('board_posts')
    .delete()
    .eq('id', postId)
    .eq('user_id', userId)
    .select('id')
  if (error) return respondBoardDbError(res, error)
  if (!data?.length) {
    return res.status(404).json({
      error: { message: 'Post not found or you can only delete your own posts.', status: 404 },
    })
  }
  res.status(204).end()
})

// ============================================================
// Neighborhood Guide (issue #31) — student-submitted local recommendations.
// Reuses board conventions: boardWriteRateLimit, boardProfanity, upvote toggle.
// Requires db/supabase-neighborhood-guide.sql.
// ============================================================

const GUIDE_SQL_FILE = 'db/supabase-neighborhood-guide.sql'

function respondGuideDbError(res, err) {
  console.error('Guide DB error:', err?.message || err, err?.code)
  if (isBoardSchemaMissingError(err) || err?.code === 'PGRST205' || err?.code === '42P01') {
    return res.status(503).json({
      error: {
        message: `Neighborhood Guide tables are missing in Supabase. In the dashboard: SQL Editor → run ${GUIDE_SQL_FILE} from this repo → Run, wait a few seconds, then retry.`,
// Study Group Finder (issue #33) — per-course groups from synced schedules.
// Privacy is opt-in (default off); only opted-in users count as classmates.
// Requires db/supabase-study-groups.sql.
// ============================================================

const STUDY_SQL_FILE = 'db/supabase-study-groups.sql'

function respondStudyDbError(res, err) {
  console.error('Study group DB error:', err?.message || err, err?.code)
  if (isBoardSchemaMissingError(err) || err?.code === 'PGRST205' || err?.code === '42P01') {
    return res.status(503).json({
      error: {
        message: `Study Group tables are missing in Supabase. In the dashboard: SQL Editor → run ${STUDY_SQL_FILE} from this repo → Run, wait a few seconds, then retry.`,
// Campus Perks (issue #24) — admin-curated local deals for students.
// GET is for everyone (active + unexpired); create/edit/delete require admin.
// Requires db/supabase-campus-deals.sql.
// ============================================================

const DEALS_SQL_FILE = 'db/supabase-campus-deals.sql'

function respondDealsDbError(res, err) {
  console.error('Deals DB error:', err?.message || err, err?.code)
  if (isBoardSchemaMissingError(err) || err?.code === 'PGRST205' || err?.code === '42P01') {
    return res.status(503).json({
      error: {
        message: `Campus Perks tables are missing in Supabase. In the dashboard: SQL Editor → run ${DEALS_SQL_FILE} from this repo → Run, wait a few seconds, then retry.`,
        status: 503,
      },
    })
  }
  return res.status(500).json({ error: { message: 'Could not load the guide. Please try again.', status: 500 } })
}

app.get('/api/guide', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : ''
  try {
    let query = supabase
      .from('guide_recommendations')
      .select('*')
      .order('pinned', { ascending: false })
      .order('upvote_count', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    if (category) query = query.eq('category', category)
    const { data, error } = await query
    if (error) throw error

    const recs = data || []
    let upvoted = new Set()
    if (recs.length) {
      const { data: votes } = await supabase
        .from('guide_upvotes')
        .select('rec_id')
        .eq('user_id', userId)
        .in('rec_id', recs.map((r) => r.id))
      upvoted = new Set((votes || []).map((v) => v.rec_id))
    }
    res.json({ recommendations: recs.map((r) => mapGuideRow(r, userId, upvoted)) })
  } catch (e) {
    return respondGuideDbError(res, e)
  }
})

app.post('/api/guide', boardWriteRateLimit, requireAuth, async (req, res) => {
  const { value, error: invalid } = validateGuideInput(req.body || {})
  if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })

  const profanity = assertBoardPostTextAllowed(value.title, value.body)
  if (!profanity.ok) return res.status(400).json({ error: { message: profanity.message, status: 400 } })

  try {
    const { data, error } = await supabase
      .from('guide_recommendations')
      .insert({ user_id: req.currentUser.id, ...value })
      .select('*')
      .single()
    if (error) throw error
    res.status(201).json({ recommendation: mapGuideRow(data, req.currentUser.id) })
  } catch (e) {
    return respondGuideDbError(res, e)
  }
})

app.post('/api/guide/:id/upvote', boardWriteRateLimit, requireAuth, async (req, res) => {
  const recId = req.params.id
  const userId = req.currentUser.id
  try {
    const { data: rec, error: recErr } = await supabase
      .from('guide_recommendations')
      .select('id, upvote_count')
      .eq('id', recId)
      .single()
    if (recErr) throw recErr
    if (!rec) return res.status(404).json({ error: { message: 'Recommendation not found.', status: 404 } })

    const { error: insErr } = await supabase
      .from('guide_upvotes')
      .insert({ rec_id: recId, user_id: userId, created_at: nowIso() })

    let newCount
    let upvotedByMe
    if (insErr && insErr.code === '23505') {
      await supabase.from('guide_upvotes').delete().eq('rec_id', recId).eq('user_id', userId)
      newCount = Math.max(0, rec.upvote_count - 1)
      upvotedByMe = false
    } else if (insErr) {
      throw insErr
    } else {
      newCount = rec.upvote_count + 1
      upvotedByMe = true
    }
    await supabase.from('guide_recommendations').update({ upvote_count: newCount }).eq('id', recId)
    res.json({ upvotes: newCount, upvotedByMe })
  } catch (e) {
    return respondGuideDbError(res, e)
  }
})

app.patch('/api/guide/:id/pin', requireAuth, async (req, res) => {
  if (!isUserAdmin(req.currentUser)) {
    return res.status(403).json({ error: { message: 'Only admins can pin recommendations.', status: 403 } })
  }
  const pinned = req.body?.pinned === true || req.body?.pinned === 'true'
  try {
    const { data, error } = await supabase
      .from('guide_recommendations')
      .update({ pinned })
      .eq('id', req.params.id)
      .select('id')
    if (error) throw error
    if (!data?.length) return res.status(404).json({ error: { message: 'Recommendation not found.', status: 404 } })
    res.json({ ok: true, pinned })
  } catch (e) {
    return respondGuideDbError(res, e)
  }
})

app.delete('/api/guide/:id', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const { data, error } = await supabase
      .from('guide_recommendations')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select('id')
    if (error) throw error
    if (!data?.length) {
      return res.status(404).json({ error: { message: 'Recommendation not found or not yours.', status: 404 } })
    }
    res.status(204).end()
  } catch (e) {
    return respondGuideDbError(res, e)
  return res.status(500).json({ error: { message: 'Could not load study groups. Please try again.', status: 500 } })
}

function mapStudyGroupRow(row, userId, memberCounts, myGroupIds) {
  return {
    id: row.id,
    courseCode: row.course_code,
    title: row.title,
    description: row.description || '',
    meetingInfo: row.meeting_info || '',
    capacity: row.capacity ?? null,
    memberCount: memberCounts.get(row.id) || 0,
    joinedByMe: myGroupIds.has(row.id),
    isMine: row.creator_id === userId,
    createdAt: row.created_at,
  }
}

async function loadStudyMembership(groupIds, userId) {
  const memberCounts = new Map()
  const myGroupIds = new Set()
  if (groupIds.length) {
    const { data: members } = await supabase
      .from('study_group_members')
      .select('group_id, user_id')
      .in('group_id', groupIds)
    for (const m of members || []) {
      memberCounts.set(m.group_id, (memberCounts.get(m.group_id) || 0) + 1)
      if (m.user_id === userId) myGroupIds.add(m.group_id)
    }
  }
  return { memberCounts, myGroupIds }
}

// The user's detected courses + opt-in status + classmate counts (opted-in only).
app.get('/api/me/study-groups/courses', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const optIn = Boolean(req.currentUser.study_groups_opt_in)
    const { items } = await getClassItemsForUser(userId, { term: 'auto', limit: 200 })
    const courses = coursesFromClassItems(items)
    const counts = new Map()
    if (courses.length) {
      const { data } = await supabase
        .from('study_group_courses')
        .select('course_code, user_id')
        .in('course_code', courses)
      for (const row of data || []) {
        if (row.user_id === userId) continue // never count yourself
        counts.set(row.course_code, (counts.get(row.course_code) || 0) + 1)
      }
    }
    res.json({ optIn, courses: courses.map((c) => ({ code: c, classmateCount: counts.get(c) || 0 })) })
  } catch (e) {
    return respondStudyDbError(res, e)
  }
})

// Toggle opt-in; on opt-in, snapshot the user's course codes for classmate counts.
app.patch('/api/me/study-groups/opt-in', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const optIn = req.body?.optIn === true || req.body?.optIn === 'true'
  try {
    const { error } = await supabase.from('users').update({ study_groups_opt_in: optIn }).eq('id', userId)
    if (error) throw error
    await supabase.from('study_group_courses').delete().eq('user_id', userId)
    if (optIn) {
      const { items } = await getClassItemsForUser(userId, { term: 'auto', limit: 200 })
      const courses = coursesFromClassItems(items)
      if (courses.length) {
        await supabase.from('study_group_courses').insert(courses.map((c) => ({ user_id: userId, course_code: c })))
      }
    }
    res.json({ ok: true, optIn })
  } catch (e) {
    return respondStudyDbError(res, e)
  }
})

// Groups the current user belongs to.
app.get('/api/me/study-groups', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const { data: mem, error } = await supabase
      .from('study_group_members')
      .select('group_id')
      .eq('user_id', userId)
    if (error) throw error
    const ids = (mem || []).map((m) => m.group_id)
    if (!ids.length) return res.json({ groups: [] })
    const { data: groups } = await supabase.from('study_groups').select('*').in('id', ids)
    const { memberCounts, myGroupIds } = await loadStudyMembership(ids, userId)
    res.json({ groups: (groups || []).map((g) => mapStudyGroupRow(g, userId, memberCounts, myGroupIds)) })
  } catch (e) {
    return respondStudyDbError(res, e)
  }
})

// List groups for a course.
app.get('/api/study-groups', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const course = normalizeCourseCode(req.query.course)
  if (!course) return res.status(400).json({ error: { message: 'A valid course code is required.', status: 400 } })
  try {
    const { data: groups, error } = await supabase
      .from('study_groups')
      .select('*')
      .eq('course_code', course)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw error
    const ids = (groups || []).map((g) => g.id)
    const { memberCounts, myGroupIds } = await loadStudyMembership(ids, userId)
    res.json({ courseCode: course, groups: (groups || []).map((g) => mapStudyGroupRow(g, userId, memberCounts, myGroupIds)) })
  } catch (e) {
    return respondStudyDbError(res, e)
  }
})

// Create a group (creator auto-joins).
app.post('/api/study-groups', boardWriteRateLimit, requireAuth, async (req, res) => {
  const { value, error: invalid } = validateStudyGroupInput(req.body || {})
  if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
  const profanity = assertBoardPostTextAllowed(value.title, value.description)
  if (!profanity.ok) return res.status(400).json({ error: { message: profanity.message, status: 400 } })
  try {
    const { data, error } = await supabase
      .from('study_groups')
      .insert({ creator_id: req.currentUser.id, ...value })
      .select('*')
      .single()
    if (error) throw error
    await supabase.from('study_group_members').insert({ group_id: data.id, user_id: req.currentUser.id, joined_at: nowIso() })
    res.status(201).json({
      group: mapStudyGroupRow(data, req.currentUser.id, new Map([[data.id, 1]]), new Set([data.id])),
    })
  } catch (e) {
    return respondStudyDbError(res, e)
  }
})

// Join a group (respects capacity).
app.post('/api/study-groups/:id/join', boardWriteRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const groupId = req.params.id
  try {
    const { data: group, error: gErr } = await supabase
      .from('study_groups')
      .select('id, capacity')
      .eq('id', groupId)
      .single()
    if (gErr) throw gErr
    if (!group) return res.status(404).json({ error: { message: 'Group not found.', status: 404 } })

    const { data: members } = await supabase.from('study_group_members').select('user_id').eq('group_id', groupId)
    const already = (members || []).some((m) => m.user_id === userId)
    if (!already && group.capacity && (members || []).length >= group.capacity) {
      return res.status(409).json({ error: { message: 'This group is full.', status: 409 } })
    }
    const { error: insErr } = await supabase
      .from('study_group_members')
      .insert({ group_id: groupId, user_id: userId, joined_at: nowIso() })
    if (insErr && insErr.code !== '23505') throw insErr
    res.json({ ok: true, memberCount: (members || []).length + (already ? 0 : 1) })
  } catch (e) {
    return respondStudyDbError(res, e)
  }
})

// Leave a group.
app.post('/api/study-groups/:id/leave', boardWriteRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const { error } = await supabase
      .from('study_group_members')
      .delete()
      .eq('group_id', req.params.id)
      .eq('user_id', userId)
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    return respondStudyDbError(res, e)
  return res.status(500).json({ error: { message: 'Could not load deals. Please try again.', status: 500 } })
}

app.get('/api/deals', requireAuth, async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : ''
  // Admins can request everything (incl. inactive/expired) to manage from the UI.
  const includeAll = req.query.all === '1' && isUserAdmin(req.currentUser)
  try {
    let query = supabase.from('deals').select('*').order('featured', { ascending: false }).order('created_at', { ascending: false }).limit(200)
    if (category) query = query.eq('category', category)
    const { data, error } = await query
    if (error) throw error
    const rows = includeAll ? (data || []) : (data || []).filter((d) => isDealActive(d))
    res.json({ deals: rows.map(mapDealRow), isAdmin: isUserAdmin(req.currentUser) })
  } catch (e) {
    return respondDealsDbError(res, e)
  }
})

function requireAdminJson(req, res) {
  if (!isUserAdmin(req.currentUser)) {
    res.status(403).json({ error: { message: 'Admin access required.', status: 403 } })
    return false
  }
  return true
}

app.post('/api/deals', requireAuth, async (req, res) => {
  if (!requireAdminJson(req, res)) return
  const { value, error: invalid } = validateDealInput(req.body || {}, { partial: false })
  if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
  try {
    const { data, error } = await supabase
      .from('deals')
      .insert({ ...value, created_by: req.currentUser.id })
      .select('*')
      .single()
    if (error) throw error
    res.status(201).json({ deal: mapDealRow(data) })
  } catch (e) {
    return respondDealsDbError(res, e)
  }
})

app.patch('/api/deals/:id', requireAuth, async (req, res) => {
  if (!requireAdminJson(req, res)) return
  const { value, error: invalid } = validateDealInput(req.body || {}, { partial: true })
  if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
  if (Object.keys(value).length === 0) {
    return res.status(400).json({ error: { message: 'No valid fields to update.', status: 400 } })
  }
  try {
    const { data, error } = await supabase.from('deals').update(value).eq('id', req.params.id).select('*').single()
    if (error) throw error
    if (!data) return res.status(404).json({ error: { message: 'Deal not found.', status: 404 } })
    res.json({ deal: mapDealRow(data) })
  } catch (e) {
    return respondDealsDbError(res, e)
  }
})

app.delete('/api/deals/:id', requireAuth, async (req, res) => {
  if (!requireAdminJson(req, res)) return
  try {
    const { data, error } = await supabase.from('deals').delete().eq('id', req.params.id).select('id')
    if (error) throw error
    if (!data?.length) return res.status(404).json({ error: { message: 'Deal not found.', status: 404 } })
    res.status(204).end()
  } catch (e) {
    return respondDealsDbError(res, e)
  }
})

// ============================================================
// Advertiser portal (separate from student auth — see
// db/supabase-advertiser-portal.sql and docs/advertiser-portal.md).
//
// Isolation is the whole point: advertisers authenticate against the
// `advertisers` table and are tracked by req.session.advertiserId — NEVER
// req.session.userId. Sign-in regenerates the session, so a browser is either a
// student session or an advertiser session, never both. requireAdvertiserAuth
// gates advertiser routes; requireAuth (student) ignores advertiserId entirely.
// ============================================================

const ADVERTISER_SQL_FILE = 'db/supabase-advertiser-portal.sql'
const ADVERTISER_CAMPAIGNS_SQL_FILE = 'db/supabase-advertiser-campaigns.sql'
const ADVERTISER_RESETS_SQL_FILE = 'db/supabase-advertiser-password-resets.sql'
const ADVERTISER_AD_EVENTS_SQL_FILE = 'db/supabase-advertiser-ad-events.sql'

function isAdvertiserSchemaMissingError(err) {
  const m = String(err?.message || '')
  const c = String(err?.code || '')
  return (
    m.includes('schema cache') ||
    m.includes('Could not find the table') ||
    (m.includes('does not exist') && m.includes('advertiser')) ||
    c === 'PGRST205' ||
    c === '42P01'
  )
}

function respondAdvertiserDbError(res, err) {
  console.error('Advertiser DB error:', err?.message || err, err?.code, err?.details)
  if (isAdvertiserSchemaMissingError(err)) {
    return res.status(503).json({
      error: {
        message: `Advertiser tables are missing in Supabase. In the dashboard: SQL Editor → run ${ADVERTISER_SQL_FILE} and ${ADVERTISER_CAMPAIGNS_SQL_FILE} from this repo → Run, then try again.`,
        code: 'advertiser_schema_missing',
        status: 503,
      },
    })
  }
  return res.status(500).json({ error: { message: err?.message || 'Database error', status: 500 } })
}

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
  // A "no rows" result is an expected miss, not a schema error — surface other
  // errors (e.g. table missing) to the caller.
  if (error) {
    if (error.code === 'PGRST116') return { advertiser: null, error: null }
    return { advertiser: null, error }
  }
  return { advertiser: data || null, error: null }
}

function buildAdvertiserSessionPayload(advertiser, req) {
  if (!advertiser) return null
  const cookieExpires = req?.session?.cookie?.expires
  return {
    expiresAt: cookieExpires ? new Date(cookieExpires).toISOString() : null,
    advertiser: toAdvertiserProfile(advertiser),
  }
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

app.post('/api/advertiser/sign-in', signInRateLimit, async (req, res) => {
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

app.post('/api/advertiser/sign-out', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pih.sid')
    res.json({ ok: true })
  })
})

app.get('/api/advertiser/me', requireAdvertiserAuth, (req, res) => {
  res.json({ session: buildAdvertiserSessionPayload(req.currentAdvertiser, req) })
})

// Public (no auth): "Request advertiser access" from /advertise. Stores a lead
// row reviewed manually for invite-only onboarding. Reuses the account-create
// IP rate limiter to blunt spam.
app.post('/api/advertiser/request-access', accountCreateRateLimit, async (req, res) => {
  let lead
  try {
    lead = normalizeLeadInput(req.body)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  const { error } = await supabase.from('advertiser_leads').insert({
    id: makeId(),
    email: lead.email,
    company_name: lead.companyName,
    message: lead.message,
    created_at: nowIso(),
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
    id: makeId(),
    advertiser_id: advertiserId,
    token_hash: tokenHash,
    expires_at: resetTokenExpiry(),
    created_at: nowIso(),
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

app.post('/api/advertiser/forgot-password', passwordResetRateLimit, async (req, res) => {
  let input
  try {
    input = normalizeForgotPasswordInput(req.body)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  const { advertiser, error } = await getAdvertiserByEmail(input.email)
  if (error) return respondAdvertiserDbError(res, error)

  // Only mint + email a token for an existing, active account — but never tell
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
      if (result?.skipped) {
        console.warn(`[advertiser reset] email disabled — reset link for ${advertiser.email}: ${resetUrl}`)
      }
    } catch (sendErr) {
      if (isAdvertiserSchemaMissingError(sendErr)) {
        return res.status(503).json({
          error: {
            message: `Advertiser reset table is missing. In Supabase: SQL Editor → run ${ADVERTISER_RESETS_SQL_FILE} → Run, then try again.`,
            code: 'advertiser_schema_missing',
            status: 503,
          },
        })
      }
      console.error('Advertiser forgot-password failed:', sendErr?.message || sendErr)
      return res.status(500).json({ error: { message: 'Could not send the reset email. Please try again.', status: 500 } })
    }
  }

  res.json({ ok: true })
})

app.post('/api/advertiser/reset-password', passwordResetRateLimit, async (req, res) => {
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
    .update({ password_hash: hashPassword(input.password), updated_at: nowIso() })
    .eq('id', reset.advertiser_id)
  if (updateErr) return respondAdvertiserDbError(res, updateErr)

  // Burn this token AND any other outstanding tokens for the advertiser, so a
  // reset link can't be replayed and stale links stop working.
  await supabase
    .from('advertiser_password_resets')
    .update({ used_at: nowIso() })
    .eq('advertiser_id', reset.advertiser_id)
    .is('used_at', null)

  res.json({ ok: true })
})

// ── Campaigns (M2) ───────────────────────────────────────────────────────────
// All campaign routes are gated by requireAdvertiserAuth and scoped to the
// signed-in advertiser. Validation/approval-flow rules live in
// advertiserCampaign.mjs. New campaigns start 'draft'; advertisers submit for
// review but cannot self-activate (owner approves via scripts/review-campaign.mjs).

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

app.get('/api/advertiser/campaigns', requireAdvertiserAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('advertiser_id', req.currentAdvertiser.id)
    .order('created_at', { ascending: false })
  if (error) return respondAdvertiserDbError(res, error)
  res.json({ campaigns: (data || []).map(mapCampaignRow) })
})

app.post('/api/advertiser/campaigns', requireAdvertiserAuth, async (req, res) => {
  let fields
  try {
    fields = normalizeCampaignInput(req.body)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  const timestamp = nowIso()
  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      id: makeId(),
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

app.patch('/api/advertiser/campaigns/:id', requireAdvertiserAuth, async (req, res) => {
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
    .update({ ...campaignFieldsToColumns(patch), updated_at: nowIso() })
    .eq('id', campaign.id)
    .eq('advertiser_id', req.currentAdvertiser.id)
    .select()
    .single()
  if (error) return respondAdvertiserDbError(res, error)

  res.json({ campaign: mapCampaignRow(data) })
})

// Aggregate impression/tap stats for one of the advertiser's own campaigns (M3).
app.get('/api/advertiser/campaigns/:id/stats', requireAdvertiserAuth, async (req, res) => {
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

// ── Ad serving + tracking (M3) ───────────────────────────────────────────────
// Student-session routes (requireAuth), NOT advertiser-gated. They serve a single
// approved, in-window campaign into the student home dashboard and log aggregate
// impression/tap events (no student PII — see db/supabase-advertiser-ad-events.sql).
// Routed as /api/spotlight/* (not /api/ads/*) because ad-blocker filter lists
// match the ads keyword and silently block the requests for students running
// blockers. Client counterpart: boilerindy-react/src/lib/spotlightApi.js.

app.get('/api/spotlight/active', requireAuth, async (req, res) => {
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
  const today = nowIso().slice(0, 10)
  if (limit > 1) {
    const ads = listServableCampaigns(data, today, limit).map(toServedAd).filter(Boolean)
    return res.json({ ads, ad: ads[0] || null })
  }
  const selected = selectServableCampaign(data, today)
  const ad = toServedAd(selected)
  res.json({ ad, ads: ad ? [ad] : [] })
})

app.post('/api/spotlight/:campaignId/event', adEventRateLimit, requireAuth, async (req, res) => {
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

  const today = nowIso().slice(0, 10)
  if (!isCampaignServable(campaign, today)) {
    return res.status(400).json({ error: { message: 'Campaign is not active.', status: 400 } })
  }

  const { error } = await supabase.from('ad_events').insert({
    id: makeId(),
    campaign_id: req.params.campaignId,
    kind,
    occurred_at: nowIso(),
  })
  // Best-effort logging: an invalid campaign id or missing table shouldn't surface
  // to the student. Log and accept.
  if (error) {
    console.error('[/api/spotlight/event] insert failed:', error?.message || error)
    return res.status(202).json({ ok: false })
  }
  res.status(204).end()
})

// ============================================================
// Platform admin (student session + isAdmin / ADMIN_EMAILS)
// ============================================================

async function countTableRows(table, filters = []) {
  let query = supabase.from(table).select('*', { count: 'exact', head: true })
  for (const [column, value] of filters) {
    query = query.eq(column, value)
  }
  const { count, error } = await query
  if (error) throw error
  return count || 0
}

app.get('/api/admin/overview', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [newLeads, pendingCampaigns, activeCampaigns, advertisers] = await Promise.all([
      countTableRows('advertiser_leads', [['status', 'new']]),
      countTableRows('campaigns', [['status', 'pending_review']]),
      countTableRows('campaigns', [['status', 'active']]),
      countTableRows('advertisers'),
    ])
    res.json({
      overview: {
        newLeads,
        pendingCampaigns,
        activeCampaigns,
        advertisers,
      },
    })
  } catch (error) {
    return respondAdvertiserDbError(res, error)
  }
})

app.get('/api/admin/leads', requireAuth, requireAdmin, async (req, res) => {
  let statusFilter
  try {
    statusFilter = parseAdminListFilter(req.query.status, LEAD_STATUSES)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  let query = supabase
    .from('advertiser_leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  if (statusFilter) query = query.eq('status', statusFilter)

  const { data, error } = await query
  if (error) return respondAdvertiserDbError(res, error)
  res.json({ leads: (data || []).map(mapLeadRow) })
})

app.patch('/api/admin/leads/:id', adminWriteRateLimit, requireAuth, requireAdmin, async (req, res) => {
  let status
  try {
    status = normalizeLeadStatusInput(req.body?.status)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  const { data, error } = await supabase
    .from('advertiser_leads')
    .update({ status })
    .eq('id', req.params.id)
    .select('*')
    .maybeSingle()
  if (error) return respondAdvertiserDbError(res, error)
  if (!data) {
    return res.status(404).json({ error: { message: 'Lead not found.', status: 404 } })
  }
  res.json({ lead: mapLeadRow(data) })
})

app.get('/api/admin/campaigns', requireAuth, requireAdmin, async (req, res) => {
  let statusFilter
  try {
    statusFilter = parseAdminListFilter(req.query.status, CAMPAIGN_STATUSES)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  let query = supabase
    .from('campaigns')
    .select('*, advertisers ( email, company_name )')
    .order('created_at', { ascending: false })
    .limit(200)
  if (statusFilter) query = query.eq('status', statusFilter)

  const { data, error } = await query
  if (error) return respondAdvertiserDbError(res, error)
  res.json({ campaigns: (data || []).map(mapAdminCampaignRow) })
})

app.patch('/api/admin/campaigns/:id', adminWriteRateLimit, requireAuth, requireAdmin, async (req, res) => {
  const { data: current, error: lookupError } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle()
  if (lookupError) return respondAdvertiserDbError(res, lookupError)
  if (!current) {
    return res.status(404).json({ error: { message: 'Campaign not found.', status: 404 } })
  }

  let status
  try {
    status = normalizeAdminCampaignStatusInput(current.status, req.body?.status)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update({ status, updated_at: nowIso() })
    .eq('id', current.id)
    .select('*, advertisers ( email, company_name )')
    .single()
  if (error) return respondAdvertiserDbError(res, error)
  res.json({ campaign: mapAdminCampaignRow(data) })
})

app.get('/api/admin/advertisers', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from('advertisers')
    .select('id, email, company_name, contact_name, status, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return respondAdvertiserDbError(res, error)
  res.json({ advertisers: (data || []).map(mapAdminAdvertiserRow) })
})

app.post('/api/admin/advertisers', adminWriteRateLimit, requireAuth, requireAdmin, async (req, res) => {
  let account
  try {
    account = normalizeAdvertiserAccountInput(req.body)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId.trim() : ''
  const passwordHash = hashPassword(account.password)
  const timestamp = nowIso()

  const { data: existing } = await supabase
    .from('advertisers')
    .select('id')
    .eq('email', account.email)
    .maybeSingle()

  let row
  if (existing?.id) {
    const { data, error } = await supabase
      .from('advertisers')
      .update({
        password_hash: passwordHash,
        company_name: account.companyName,
        contact_name: account.contactName,
        status: 'active',
        updated_at: timestamp,
      })
      .eq('id', existing.id)
      .select('id, email, company_name, contact_name, status, created_at')
      .single()
    if (error) return respondAdvertiserDbError(res, error)
    row = data
  } else {
    const { data, error } = await supabase
      .from('advertisers')
      .insert({
        id: makeId(),
        email: account.email,
        password_hash: passwordHash,
        company_name: account.companyName,
        contact_name: account.contactName,
        status: 'active',
        created_at: timestamp,
        updated_at: timestamp,
      })
      .select('id, email, company_name, contact_name, status, created_at')
      .single()
    if (error) return respondAdvertiserDbError(res, error)
    row = data
  }

  if (leadId) {
    await supabase
      .from('advertiser_leads')
      .update({ status: 'closed' })
      .eq('id', leadId)
      .eq('email', account.email)
  }

  res.status(existing?.id ? 200 : 201).json({ advertiser: mapAdminAdvertiserRow(row) })
})

// Release a stale Purdue link (e.g. after account reset). Body: { purdueEmail } or { userId }.
app.post('/api/admin/purdue-links/clear', adminWriteRateLimit, requireAuth, requireAdmin, async (req, res) => {
  const purdueEmail = normalizeEmail(req.body?.purdueEmail || '')
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''

  if (!purdueEmail && !userId) {
    return res.status(400).json({
      error: { message: 'Provide purdueEmail or userId to clear a Purdue link.', status: 400 },
    })
  }

  let query = supabase.from('users').select('id, email, purdue_email')
  if (userId) query = query.eq('id', userId)
  else query = query.eq('purdue_email', purdueEmail)

  const { data: rows, error: lookupError } = await query
  if (lookupError) {
    return res.status(500).json({ error: { message: lookupError.message, status: 500 } })
  }
  if (!rows?.length) {
    return res.status(404).json({ error: { message: 'No matching user profile found.', status: 404 } })
  }

  const cleared = []
  for (const row of rows) {
    if (!row.purdue_email) continue
    await clearPurdueLinkOnUser(row.id)
    cleared.push({ id: row.id, email: row.email, purdueEmail: row.purdue_email })
  }

  if (!cleared.length) {
    return res.status(404).json({ error: { message: 'Profile has no Purdue link to clear.', status: 404 } })
  }

  res.json({ ok: true, cleared })
})

// ── First-party product analytics (issue #51) ───────────────────────────────
// Signed-in students only; events live in our own Supabase (analytics_events,
// service-role only — see db/supabase-analytics.sql). The server re-checks the
// opt-out so a stale or misbehaving client can never record an opted-out user.
// Accepts navigator.sendBeacon flushes too (text/plain body), hence the manual
// JSON parse fallback.

app.post('/api/usage/events', analyticsRateLimit, requireAuth, express.text({ type: 'text/plain' }), async (req, res) => {
  if (req.currentUser.analytics_opt_out) {
    return res.status(204).end()
  }

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return res.status(400).json({ error: { message: 'Invalid analytics payload.', status: 400 } })
    }
  }

  let rows
  try {
    rows = normalizeAnalyticsBatch(body)
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, status: 400 } })
  }

  const timestamp = nowIso()
  const { error } = await supabase.from('analytics_events').insert(
    rows.map((row) => ({
      id: makeId(),
      user_id: req.currentUser.id,
      ...row,
      created_at: timestamp,
    })),
  )

  // Best-effort: analytics must never surface errors to students (e.g. table
  // not created yet). Log and accept.
  if (error) {
    console.error('[/api/usage/events] insert failed:', error?.message || error)
    return res.status(202).json({ ok: false })
  }
  res.status(204).end()
})

// Capture anything that escapes a route handler. Registered after all routes
// (Express error-middleware ordering); no-op without a DSN.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app)
}

app.listen(port, host, async () => {
  console.log(`BoilerIndy backend listening on ${publicBaseUrl}`)
  console.log(`Purdue link mode: ${purdueAuthMode}`)
  console.log(`Database: Supabase`)
  const probe = await supabase.from('board_posts').select('id').limit(1)
  if (probe.error && isBoardSchemaMissingError(probe.error)) {
    console.warn(
      `\n[BoilerIndy] Campus board: table board_posts not found. Run ${BOARD_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
  const advProbe = await supabase.from('advertisers').select('id').limit(1)
  if (advProbe.error && isAdvertiserSchemaMissingError(advProbe.error)) {
    console.warn(
      `\n[BoilerIndy] Advertiser portal: table advertisers not found. Run ${ADVERTISER_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
  const campaignProbe = await supabase.from('campaigns').select('id').limit(1)
  if (campaignProbe.error && isAdvertiserSchemaMissingError(campaignProbe.error)) {
    console.warn(
      `\n[BoilerIndy] Advertiser portal: table campaigns not found. Run ${ADVERTISER_CAMPAIGNS_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
  const adEventProbe = await supabase.from('ad_events').select('id').limit(1)
  if (adEventProbe.error && isAdvertiserSchemaMissingError(adEventProbe.error)) {
    console.warn(
      `\n[BoilerIndy] Advertiser portal: table ad_events not found. Run ${ADVERTISER_AD_EVENTS_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
  const analyticsProbe = await supabase.from('analytics_events').select('id').limit(1)
  if (analyticsProbe.error && isAdvertiserSchemaMissingError(analyticsProbe.error)) {
    console.warn(
      '\n[BoilerIndy] Analytics: table analytics_events not found. Run db/supabase-analytics.sql in Supabase SQL Editor, then restart the server.\n',
    )
  }
})
