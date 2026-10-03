import 'dotenv/config'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as Sentry from '@sentry/node'
import { SENTRY_DATA_COLLECTION, scrubSentryEvent } from './src/sentryScrub.mjs'

// Error tracking (issue #50). Plain error capture only (no auto-tracing, which
// would need a pre-import hook). A missing DSN means Sentry is fully disabled -
// zero events in local dev; the human step is setting SENTRY_DSN on the host.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    dataCollection: SENTRY_DATA_COLLECTION,
    tracesSampleRate: 0, // errors only - keeps the free tier roomy
    // ponytail: route every console.error (the ~80 catch-and-log swallow points)
    // to Sentry, instead of editing each catch block. Adds to the default
    // integrations (uncaught + unhandledRejection stay on). Too noisy? Narrow to
    // captureException() at the sites that matter, or drop levels to taste.
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    beforeSend: scrubSentryEvent,
  })
}

// A rejected promise nobody awaited must not take the process down (Node's
// default) or vanish: log it and keep serving. Sentry, when configured, also
// records it through its own handler (issue #197).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.stack || reason?.message || reason)
})

import express from 'express'
import session from 'express-session'
import ical from 'node-ical'
import { createClient } from '@supabase/supabase-js'
import { cancelCalendarCapture, getCalendarCaptureJob, isCalendarAutomationEnabled, startCalendarCapture } from './src/purdueCalendarAutomation.mjs'
import { createClubDirectoryCache } from './src/boilerlinkClubs.mjs'
import { loadVapidKeys } from './src/webPush.mjs'
import { runSourceResync } from './src/sourceResync.mjs'
import { describeFailure, isTransientFailure, retryOnceIfTransient, runCronTick } from './src/cronTick.mjs'
import { getDiningSnapshot, todayYmdInZone } from './src/nutrisliceDining.mjs'
import { mapManualTaskRow, parseManualTaskCreate, parseManualTaskUpdate } from './src/manualTasks.mjs'
import { createGroqClient, GroqUpstreamError } from './src/groqClient.mjs'
import { estimateTokens, tidyAssistantReply } from './src/assistantReply.mjs'
import {
  STUDY_HELP_DEADLINE_HOURS,
  buildDiningContext,
  calendarContextFor,
  startsWithin,
  wantsStudyHelp,
} from './src/assistantContext.mjs'
import {
  assertBoardPostTextAllowed,
  boardTextFailsPolicy,
  BOARD_PROFANITY_USER_MESSAGE,
} from './src/boardProfanity.mjs'
import { createRateLimiter, createRateWindow } from './src/rateLimiter.mjs'
import { SESSION_COOKIE_NAME, publicReadBucketKey } from './src/publicReadKey.mjs'
import { toggleUpvote } from './src/upvoteToggle.mjs'
import {
  DRAFT_CAMPAIGNS_CAP_MESSAGE,
  GRADES_CAP_MESSAGE,
  MANUAL_TASKS_CAP_MESSAGE,
  MAX_DRAFT_CAMPAIGNS,
  MAX_GRADES,
  MAX_MANUAL_TASKS,
  advertiserWriteBucketKey,
  capCheck,
} from './src/userWriteCaps.mjs'
import { sessionSyncBucketKey } from './src/sessionSyncKey.mjs'
import { UpstreamError, createStaleCache, fetchUpstream, isAbortLike } from './src/upstreamFetch.mjs'
import { createSessionStore } from './src/sessionStore.mjs'
import { planSync, classifyFetchError, detectTimezoneFromFeed, expandRecurringEvents, icalText } from './src/scheduleSync.mjs'
import { createCalendarItemStore } from './src/calendarItemStore.mjs'
import { createOnboardingSummaryCache } from './src/onboardingSummaryCache.mjs'
import { onboardingFlags } from './src/onboardingFlags.mjs'
import { createCommunityCounters } from './src/communityCounters.mjs'
import { classScanFrom, getAcademicTerm, getPreferredClassTerm, parseTermKey } from './src/academicTerms.mjs'
import { DEFAULT_MAX_ROWS, selectUpTo } from './src/pagedSelect.mjs'
import { categoryListFromCounts, loadCalendarCategoryCounts } from './src/calendarCategoryCounts.mjs'
import { buildCalendarFeed } from './src/icsFeed.mjs'
import { hasFreeFood } from './src/freeFood.mjs'
import { createLayoutsRouter } from './src/routes/layouts.mjs'
import { createLostFoundRouter } from './src/routes/lostFound.mjs'
import { createDealsRouter } from './src/routes/deals.mjs'
import { createGuideRouter } from './src/routes/guide.mjs'
import { createStudyGroupsRouter } from './src/routes/studyGroups.mjs'
import { createMarketplaceRouter } from './src/routes/marketplace.mjs'
import { createFriendsRouter } from './src/routes/friends.mjs'
import { createDiningPublicRouter, createDiningRouter } from './src/routes/dining.mjs'
import { createCampusPublicRouter } from './src/routes/campus.mjs'
import { createPushPublicRouter, createPushRouter } from './src/routes/push.mjs'
import { createReportsRouter } from './src/routes/reports.mjs'
import { createAdminReportsRouter } from './src/routes/adminReports.mjs'
import { createBlocksRouter } from './src/routes/blocks.mjs'
import { createPurdueEmailRouter } from './src/routes/purdueEmail.mjs'
import { LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE } from './src/purdueEmailVerification.mjs'
import { excludeBlocked, loadBlockedIds } from './src/blocks.mjs'
import {
  LETTER_GRADES,
  MAX_COURSE_NAME,
  MAX_TERM_NAME,
  MAX_CREDIT_HOURS,
  DEFAULT_CREDIT_HOURS,
  DEFAULT_TERM,
} from './src/gradeTracker.mjs'
import { getProgram } from './src/degreePrograms.mjs'
import {
  BOARD_PAGE_SIZE,
  INLINE_REPLIES,
  INLINE_REPLY_FETCH_LIMIT,
  REPLY_PAGE_SIZE,
  validateBoardPost,
  validateBoardReply,
} from './src/boardLimits.mjs'
import { groupRepliesByPost, mapBoardReply } from './src/boardReplies.mjs'
import { STUDY_SOFT_DELETE_SQL_FILE } from './src/studyGroups.mjs'
import { isMissingColumnError, isUuid, ownerOrAdminScope } from './src/moderation.mjs'
import { requireIdParam } from './src/httpGuards.mjs'
import {
  badRequest,
  DB_FEATURES,
  isSchemaMissingError,
  logRouteError,
  respondDbError,
  respondRouteError,
  respondSchemaMissing,
  respondSoftDeleteFeatureDbError,
  SOFT_DELETE_SQL_FILE,
} from './src/dbErrors.mjs'
import { createMarketplacePhotos } from './src/marketplacePhotos.mjs'
import { countMarketplaceReports, respondMarketplaceDbError } from './src/marketplaceDb.mjs'
import { createPurdueLinkHandoff, HandoffError } from './src/purdueLinkHandoff.mjs'
import { buildCasServiceUrl, createCasState, spendCasState } from './src/casLinkState.mjs'
import { createPurdueLinkFlowRateLimit, linkHandoffToken } from './src/purdueLinkThrottle.mjs'
import {
  matchIntent,
  formatNextClass,
  formatClassesToday,
  formatDiningOpen,
  formatAssignments,
  intentFocusHint,
  ASSISTANT_OFFLINE_MESSAGE,
} from './src/assistantRouter.mjs'
import {
  normalizeScheduleOverrides,
  applyScheduleOverridesToRows,
  manualClassesAsRows,
} from './src/scheduleOverrides.mjs'
import { normalizeAnalyticsBatch } from './src/analytics.mjs'
import { verifyPassword, hashPassword } from './src/passwordHash.mjs'
import { hasLegacyHash, resolveSignIn, applyPasswordChange, verifyCurrentPassword } from './src/studentPasswordAuth.mjs'
import {
  deriveDisplayName,
  normalizeAvatarUrl,
  normalizeDisplayName,
  normalizeProfileName,
  normalizeProvider,
} from './src/userFields.mjs'
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
import { assertSafeHttpUrl, safeFetchIcsText, assertHostAllowed } from './src/urlSafety.mjs'
import { isSessionStale } from './src/sessionFreshness.mjs'
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
import { sendAdvertiserPasswordResetEmail, sendEmail } from './src/email.mjs'
import { apiNotFound } from './src/apiNotFound.mjs'
import { createFinalErrorHandler } from './src/finalErrorHandler.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Fail-closed on a mistyped NODE_ENV: a value that is set but unrecognized
// (e.g. 'prod', 'Production', a trailing space) must not silently fall through to
// non-production mode and drop the Secure-cookie / trust-proxy / debug-gate /
// mock-auth safeguards. Unset stays development (local dev runs `node server.mjs`).
const nodeEnv = process.env.NODE_ENV
if (nodeEnv !== undefined && !['production', 'development', 'test'].includes(nodeEnv)) {
  console.error(`ERROR: NODE_ENV is set to an unrecognized value: ${JSON.stringify(nodeEnv)}. Use production, development, or test.`)
  process.exit(1)
}
const isProduction = nodeEnv === 'production'

const app = express()
// Drop the "X-Powered-By: Express" fingerprint header (#157).
app.disable('x-powered-by')
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
  if (!sessionSecret || sessionSecret.length < 32) {
    console.error('ERROR: SESSION_SECRET is required in production and must be at least 32 characters')
    process.exit(1)
  }
  if (!supabaseAnonKey) {
    console.error('ERROR: SUPABASE_ANON_KEY is required in production')
    process.exit(1)
  }
  if (!['cas', 'off'].includes(purdueAuthMode)) {
    console.error(`ERROR: PURDUE_AUTH_MODE must be 'cas' or 'off' in production (got ${JSON.stringify(purdueAuthMode)})`)
    process.exit(1)
  }
}

// Native app Purdue link handoff (#214): short-lived signed tokens let the
// system browser complete the link without holding the app's session cookie.
// See docs/purdue-link.md. NATIVE_APP_SCHEME defaults to boilerindyapp.
const purdueLinkHandoff = createPurdueLinkHandoff({
  secret: sessionSecret,
  scheme: process.env.NATIVE_APP_SCHEME,
})

console.log(`[startup] mode=${isProduction ? 'production' : (nodeEnv || 'development')} secureCookies=${isProduction} trustProxy=${isProduction || process.env.TRUST_PROXY === '1'}`)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Express 5 leaves req.body undefined when a request carries no body or a
// content-type no parser claims, where Express 4 handed over {}. server.mjs
// reads req.body in ~90 places, nearly all by destructuring, so without this a
// bodyless or mistyped POST would throw before the route could return its own
// 400 and the client would see a generic 500 instead (issue #291).
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {}
  next()
})

// Lightweight liveness probe for uptime pings (issue #111). Defined before the
// session middleware so warm-up pings don't allocate a session on every hit -
// an external pinger hitting this every ~10 min keeps the Render service warm
// and avoids the ~50s cold-start on the next real login.
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// Sessions live in Postgres rather than in this process (issue #111). Render's
// free tier spins down after ~15 min idle, and the express-session default
// MemoryStore died with it, signing out every user on every spin-down even
// though their 14-day cookie was still valid. Null when db/supabase-sessions.sql
// has not been run yet: express-session then keeps its in-memory default, which
// is the old behaviour, and createSessionStore has already logged why.
const sessionStore = await createSessionStore(supabase)

// Caches the two onboarding count queries per user so session reads (every app
// hydrate, every refreshSession) skip them on the hot path (issue #111 item 6).
// Invalidated wherever those counts change; see getUserSummary and the source
// mutation choke points below.
const onboardingSummaryCache = createOnboardingSummaryCache()

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
// Session sync runs on every app launch and token refresh. Keyed by the Supabase
// user in the request's token so a lecture hall behind one campus NAT does not
// share a bucket (#217); the wider per-IP cap behind it bounds forged ids.
const sessionSyncRateLimit = createRateLimiter({
  name: 'session-sync',
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyBy: sessionSyncBucketKey,
  message: 'Too many session requests. Please slow down and try again shortly.',
})
const sessionSyncIpRateLimit = createRateLimiter({
  name: 'session-sync-ip',
  windowMs: 15 * 60 * 1000,
  max: 600,
  keyBy: 'ip',
  message: 'Too many session requests from this network. Please try again shortly.',
})
// Purdue email-code verification (#181): the code requests and the code
// checks share ten an hour per student, which bounds both the mail sent to
// any one address and the guesses at a six-digit code.
const purdueVerifyRateLimit = createRateLimiter({
  name: 'purdue-verify',
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many verification attempts. Please try again in an hour.',
})
// One handoff token per native Purdue link attempt (#214); tokens live 10 min.
const purdueLinkTokenRateLimit = createRateLimiter({
  name: 'purdue-link-token',
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many Purdue link attempts. Please wait a few minutes and try again.',
})
// The steps that spend a link attempt (connect, the mock form, the CAS
// callback) share one budget of 30 per 15 min, mounted ahead of the actor
// lookup so a throttled request costs no Supabase read (#293). Keyed by a live
// handoff token, then the session user, then the IP; a blocked caller is
// redirected back to the app or to Settings. See src/purdueLinkThrottle.mjs.
const purdueLinkFlowRateLimit = createPurdueLinkFlowRateLimit({ handoff: purdueLinkHandoff, clientAppUrl })
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
// keyed by IP. Calendar clients poll every 15-60 min; this budget tolerates
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
// Sponsored ad impression/tap logging (advertiser-portal M3). Per-user budget -
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
// Session-free upstream proxies (dining, parking, stops, routes, push config).
// These routes are registered before the session middleware (issue #250, see
// the public reads block below), so req.session is never set on them. To keep
// #215's fairness for app users behind one campus NAT, the bucket key is a
// hash of the session cookie when the request carries one and the IP
// otherwise; the *-ip limiters cap what one address can spend across every
// cookie value it presents, the way session-sync-ip bounds session-sync.
const publicReadRateLimit = createRateLimiter({
  name: 'public-read',
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyBy: publicReadBucketKey,
  message: 'Too many requests. Please try again shortly.',
})
const publicReadIpRateLimit = createRateLimiter({
  name: 'public-read-ip',
  windowMs: 15 * 60 * 1000,
  max: 1200,
  keyBy: 'ip',
  message: 'Too many requests. Please try again shortly.',
})
// Live vehicle positions poll every 10 to 20 s per open Transit screen and are
// cached 5 s server-side, so they get their own bucket sized for polling
// instead of eating the shared public-read budget (#215). Same keying and the
// same kind of outer per-address cap as public-read.
const transitVehiclesRateLimit = createRateLimiter({
  name: 'transit-vehicles',
  windowMs: 15 * 60 * 1000,
  max: 240,
  keyBy: publicReadBucketKey,
  message: 'Too many transit requests. Please slow down.',
})
const transitVehiclesIpRateLimit = createRateLimiter({
  name: 'transit-vehicles-ip',
  windowMs: 15 * 60 * 1000,
  max: 2400,
  keyBy: 'ip',
  message: 'Too many transit requests. Please slow down.',
})
const pushWriteRateLimit = createRateLimiter({
  name: 'push-write',
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many notification changes. Please try again shortly.',
})
const pushTestRateLimit = createRateLimiter({
  name: 'push-test',
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many test notifications. Try again in an hour.',
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
// Marketplace listing detail reveals the seller's contact email (issue #114).
// Per-user budget: generous for a buyer opening listings, but caps the bulk
// id-enumeration that would otherwise harvest every seller's email.
const marketplaceReadRateLimit = createRateLimiter({
  name: 'marketplace-read',
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many marketplace requests. Please slow down.',
})
const marketplacePhotoRateLimit = createRateLimiter({
  name: 'marketplace-photo', windowMs: 60 * 60 * 1000, max: 20,
  message: 'Too many photo uploads. Please try again in an hour.',
})
// Club directory searches never reach BoilerLink per request (the directory is
// cached for hours), so they get their own bucket instead of eating into the
// live transit / dining budget shared by `public-read`. Search-as-you-type
// sends a few requests per query, hence the roomier limit.
const clubsReadRateLimit = createRateLimiter({
  name: 'clubs-read',
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyBy: 'ip',
  message: 'Too many requests. Please try again shortly.',
})
// Authenticated writes that had no limiter (issue #202): the non-GET /api/me/*
// routes not covered above, the owner-or-admin deletes, the guide pin,
// connection replies, the mock Purdue link and the admin deal writes. One
// shared per-user budget, roomy for a student ticking off a to-do list, tight
// enough to stop a script filling tables. Row caps on the create routes live
// in src/userWriteCaps.mjs; full list in docs/RATE_LIMITS.md.
const userWriteRateLimit = createRateLimiter({
  name: 'user-write',
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: 'You are making changes too quickly. Please wait a moment and try again.',
})
// Reports on student content (issue #192): generous for someone flagging a
// run of spam, low enough that the queue cannot be flooded from one account.
const reportRateLimit = createRateLimiter({
  name: 'report',
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many reports. Please try again in an hour.',
})
// Advertiser campaign creates and edits (issue #202). Portal sessions carry
// req.session.advertiserId rather than a student userId, so the default key
// would bucket every advertiser by IP; advertiserWriteBucketKey keys them by
// the advertiser instead.
const advertiserWriteRateLimit = createRateLimiter({
  name: 'advertiser-write',
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyBy: advertiserWriteBucketKey,
  message: 'Too many campaign changes. Please wait a few minutes and try again.',
})

// Club directory (issue #16): BoilerLink's public organizations API, about
// 1,200 orgs and 1.9 MB upstream. The whole list is fetched in pages, held in
// memory for hours (src/boilerlinkClubs.mjs owns the cache) and searched here,
// so a phone downloads one page of results and BoilerLink sees a handful of
// requests per TTL. The cache serves the last good directory while a refresh
// runs and never throws; an outage answers `ok: false` with an empty list.
// See docs/clubs.md. Built here, ahead of the public reads block that hands it
// to the campus router (src/routes/campus.mjs, issue #191); the startup
// refresh after listen uses it too.
const clubDirectoryCache = createClubDirectoryCache({
  ttlMs: Number(process.env.BOILERLINK_CLUBS_CACHE_MS) || undefined,
})

// Web Push keys (issue #9). See docs/push-notifications.md. Keys come from
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (node scripts/generate-vapid-keys.mjs);
// without them every push route reports enabled:false and nothing is ever
// sent. Loaded here, ahead of the public reads block that hands them to the
// push routers (src/routes/push.mjs, issue #191).
let vapidKeys = null
try {
  vapidKeys = loadVapidKeys()
  if (!vapidKeys) {
    console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set: push notifications are disabled (issue #9).')
  }
} catch (err) {
  console.error(`[push] VAPID keys rejected (${err.message}): push notifications are disabled.`)
}

// ── Public reads (issue #250) ────────────────────────────────────────────────
// The session-free upstream proxies are registered here, before the session
// middleware, so their responses never carry Set-Cookie: with `rolling: true`
// express-session refreshes the cookie on every response that has a session,
// and Vercel will not store a response that sets a cookie, which kept the edge
// cache empty for every signed-in poll. Same precedent as /api/health. The
// campus, push and dining reads are routers from src/routes/ (issue #191),
// and what they are handed is built above this block: a const or let
// declared further down would not be initialized yet when these lines run.
app.use(createCampusPublicRouter({ transitVehiclesIpRateLimit, transitVehiclesRateLimit, publicReadIpRateLimit, publicReadRateLimit, clubsReadRateLimit, getCached, clubDirectoryCache }))
app.use(createPushPublicRouter({ publicReadIpRateLimit, publicReadRateLimit, vapidKeys }))
app.use(createDiningPublicRouter({ publicReadIpRateLimit, publicReadRateLimit, getDiningSnapshot }))

// Everything below runs behind the cookie session.
app.use(
  session({
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret || 'dev-session-secret',
    ...(sessionStore ? { store: sessionStore } : {}),
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

function nowIso() {
  return new Date().toISOString()
}

function makeId() {
  return crypto.randomUUID()
}

function sanitizeNext(next) {
  // Must be a site-relative path. Reject protocol-relative (//host) and backslash
  // variants so this can never be turned into an open redirect.
  if (!next || typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return defaultNextPath
  }
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

  const wantsEmailChange = normalizedEmail !== normalizeEmail(user.email)
  const wantsPasswordChange = Boolean(newPassword && newPassword.trim())

  // Changing the login email is as account-takeover-sensitive as changing the
  // password: require the current password either way, so a stolen session alone
  // can't silently repoint the account's identity (#124).
  if ((wantsPasswordChange || wantsEmailChange) && !(currentPassword && currentPassword.trim())) {
    throw new Error('Please enter your current password to change your email or password.')
  }

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
  } else if (wantsEmailChange) {
    // Email-only change: verify the current password without altering it.
    await verifyCurrentPassword({ verifySupabasePassword }, user, currentPassword)
  }

  // Keep the Supabase Auth email in sync so password sign-in keeps working.
  // user_not_found = legacy row that has not been migrated into Auth yet.
  if (wantsEmailChange) {
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

  if (wantsPasswordChange) {
    // Stamp the credential-change time so sessions established earlier are rejected
    // by getCurrentUser (#132). Guarded: if the column isn't migrated yet the
    // password change still succeeds and invalidation just stays inert.
    const { error: stampError } = await supabase
      .from('users')
      .update({ password_changed_at: nowIso() })
      .eq('id', userId)
    if (stampError) {
      console.warn('[updateUserProfile] password_changed_at not set (run db/supabase-session-invalidation.sql):', stampError.message)
    }
  }

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

  onboardingSummaryCache.invalidate(userId)
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
// redundant re-fetch, and the two independent counts run in parallel - turning
// the session payload from 4 sequential Supabase round-trips into 2.
async function getUserSummary(userOrId) {
  const user = userOrId && typeof userOrId === 'object' ? userOrId : await getUserById(userOrId)
  const userId = user?.id ?? userOrId

  // The two counts are the only DB work here; cache them so session reads skip
  // both queries on the hot path (issue #111). Capture the generation before the
  // query so a mutation that invalidates mid-flight discards this stale result.
  let counts = onboardingSummaryCache.get(userId)
  if (!counts) {
    const gen = onboardingSummaryCache.generation(userId)
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
    counts = { linkedSourceCount: linkedSourceCount || 0, classCount: classCount || 0 }
    onboardingSummaryCache.set(userId, counts, gen)
  }

  return onboardingFlags({ counts, hasPurdueLinked: Boolean(user?.purdue_email), purdueLinkingEnabled })
}

async function getCurrentUser(req) {
  const user = await getUserById(req.session.userId)
  if (!user) return null
  // Reject a session established before the account's last password change (#132),
  // so changing the password from Settings evicts other (e.g. stolen) sessions.
  if (isSessionStale(user.password_changed_at, req.session.authAt)) return null
  return user
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

// board_posts.reply_count / upvote_count and guide_recommendations.upvote_count
// are denormalized counters recomputed atomically from their source rows here,
// instead of the read-modify-write that lost updates under concurrent votes.
const communityCounters = createCommunityCounters(supabase)

// A feed that timed out, dropped the connection or answered a gateway status
// is the feed host's outage, not a bug here, and the source row already shows
// the student the failure. console.warn keeps it in the Render log, and
// captureMessage files one warning-level Sentry issue per failure kind (the
// console integration forwards console.error only), whose event count shows
// how often feeds are down. Never the feed URL: it carries the student's token.
function warnFeedTransient(sourceId, error) {
  const what = describeFailure(error)
  console.warn(`[runScheduleSync] Transient feed failure for source=${sourceId}: ${what} (${error?.message || error})`)
  Sentry.captureMessage(`runScheduleSync: transient calendar feed failure (${what})`, {
    level: 'warning',
    fingerprint: ['schedule-feed-transient', what],
    extra: { message: String(error?.message || error), status: error?.status ?? null, code: error?.code ?? error?.cause?.code ?? null },
  })
}

// retryTransient: the background re-sync gives a transient feed failure one
// more try before marking the source `error` (Sentry BOILERINDY-API-8). The
// Sync buttons leave it off so a student is not kept waiting on a dead host.
async function runScheduleSync(source, { retryTransient = false } = {}) {
  const syncedAt = nowIso()
  const sourceId = source.id

  let eventsByKey
  try {
    const fetchFeed = () => safeFetchIcsText(source.source_url)
    const icsText = retryTransient
      ? await retryOnceIfTransient('[runScheduleSync] source=' + sourceId, fetchFeed)
      : await fetchFeed()
    eventsByKey = await ical.async.parseICS(icsText)
  } catch (fetchError) {
    const classified = classifyFetchError(fetchError)
    if (isTransientFailure(fetchError)) warnFeedTransient(sourceId, fetchError)
    else console.error('[runScheduleSync] Fetch failed for source=' + sourceId + ':', fetchError?.message || fetchError)
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

  // The class count may have changed; drop the cached onboarding summary so the
  // post-sync session re-read reflects it (issue #111).
  onboardingSummaryCache.invalidate(source.user_id)

  await calendarItemStore.setStatus(sourceId, plan.sourceStatus, plan.statusMessage, { markSynced: true })

  console.log('[runScheduleSync] source=' + sourceId + ': ' + plan.meta.itemCount + ' items saved (' + plan.meta.skippedCount + ' skipped, ' + plan.meta.duplicateCount + ' duplicates removed)')

  return {
    syncedAt,
    itemCount: plan.meta.itemCount,
    skippedCount: plan.meta.skippedCount,
    timezone: plan.meta.timezone,
  }
}

// Hard host allowlist per schedule provider: the ONLY line of defense left once a
// URL passes assertSafeHttpUrl, and what stops an attacker supplying a rebindable
// hostname. A source type absent from this map is rejected (fail closed).
const SCHEDULE_SOURCE_HOSTS = {
  purdue_schedule_ical: ['purdue.edu'],
  brightspace_ical: ['brightspace.com', 'd2l.com', 'desire2learn.com'],
}

async function createScheduleSource(userId, { icsUrl, label, sourceType = 'purdue_schedule_ical' }) {
  const allowedHosts = SCHEDULE_SOURCE_HOSTS[sourceType]
  if (!allowedHosts) {
    throw new Error('That calendar provider is not allowed.')
  }
  assertHostAllowed(icsUrl, allowedHosts)
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
  onboardingSummaryCache.invalidate(userId)
  return data
}

async function listCalendarItems(userId, { category, categories, limit = 100, order = 'asc', from = null } = {}) {
  const ascending = order === 'asc'
  const rowLimit = Number(limit) || 100

  const buildQuery = () => {
    let query = supabase
      .from('calendar_items')
      .select('id, source_id, title, description, start_time, end_time, location, category, external_uid, source_type, all_day')
      .eq('user_id', userId)

    if (category) {
      query = query.eq('category', category)
    } else if (categories && categories.length > 0) {
      query = query.in('category', categories)
    }

    if (from) {
      query = query.gte('start_time', from)
    }

    return query.order('start_time', { ascending })
  }

  // PostgREST truncates every response to max-rows (1000) whatever .limit()
  // asks for, so selectUpTo pages a larger read with .range() up to
  // DEFAULT_MAX_ROWS (issue #198). The id tiebreak keeps rows that share a
  // start_time from repeating or vanishing across page boundaries.
  const { data, error } = await selectUpTo(() => buildQuery().order('id', { ascending }), rowLimit)

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
    // DATE-only feed items (no clock time). The client hides the time for these
    // instead of rendering a meaningless midnight (issue #121).
    allDay: Boolean(row.all_day),
    // Flag events that advertise free food (issue #46). Cheap per-row regex;
    // only meaningful for event categories but harmless elsewhere.
    freeFood: hasFreeFood(row.title, row.description),
  }))
}

async function getClassItemsForUser(userId, { limit = 20, term = 'auto', mode = 'display' } = {}) {
  // Windowed to the last CLASS_SCAN_LOOKBACK_MONTHS and paged past max-rows: an
  // unbounded ascending read returned only the oldest 1000 meetings, so students
  // with a few synced semesters lost the current term entirely (issue #198).
  const allItems = await listCalendarItems(userId, {
    category: 'class',
    limit: DEFAULT_MAX_ROWS,
    order: 'asc',
    from: classScanFrom(term),
  })
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
  const currentPurdueEmail = normalizeEmail(currentUser?.purdue_email)
  if (currentPurdueEmail === normalizedEmail) {
    return currentUser
  }
  // Never swap one Purdue identity for another silently (#293). Only an admin
  // can release a link today (POST /api/admin/purdue-links/clear), so the
  // message sends the student to support. The address stays out of the text:
  // the website carries this message in a redirect URL.
  if (currentPurdueEmail) {
    throw new Error(LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE)
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

// The CAS service URL must match byte for byte between the login redirect and
// ticket validation. The website variant carries the post-link path and the
// single-use state nonce, so the nonce is part of the service string CAS signs
// (#293); the native variant carries only the handoff token so the callback
// can identify the student without a session cookie (#214).
function casServiceUrl({ nextPath, token, state }) {
  return buildCasServiceUrl(publicBaseUrl, { nextPath, token, state })
}

async function validateCasTicket(ticket, serviceUrl) {
  const loginUrl = process.env.PURDUE_CAS_LOGIN_URL
  const validateUrl = process.env.PURDUE_CAS_VALIDATE_URL
  if (!loginUrl || !validateUrl) {
    throw new Error('CAS mode requires PURDUE_CAS_LOGIN_URL and PURDUE_CAS_VALIDATE_URL.')
  }

  // fetchUpstream gives this call the 8 second deadline and the ok check every
  // other upstream call has (#293); a stalled CAS used to hold the request and
  // its socket open. The deadline also covers reading the body.
  const response = await fetchUpstream(
    'Purdue CAS',
    `${validateUrl}?service=${encodeURIComponent(serviceUrl)}&ticket=${encodeURIComponent(ticket)}`,
  )
  let xml
  try {
    xml = await response.text()
  } catch (err) {
    throw new UpstreamError('Purdue CAS', isAbortLike(err) ? 'timeout' : 'network', { cause: err })
  }
  const userMatch = xml.match(/<cas:user>([^<]+)<\/cas:user>/i)
  if (!userMatch) throw new Error('CAS ticket validation failed.')
  const emailMatch = xml.match(/<cas:(?:mail|email)>([^<]+)<\/cas:(?:mail|email)>/i)
  const username = userMatch[1].trim()
  const email = emailMatch?.[1]?.trim() || `${username}@purdue.edu`
  return { email }
}

function renderMockPurdueLinkPage(nextPath, message = '', currentEmail = '', token = '') {
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
    .badge{display:inline-block;background:#D4A84B;color:#3E2200;font-size:10px;font-weight:700;padding:4px 10px;border-radius:999px;letter-spacing:.08em;text-transform:uppercase}
    h1{font-size:24px;margin:16px 0 8px}
    p{font-size:14px;line-height:1.6;color:#4A4844}
    label{display:block;font-size:12px;font-weight:600;margin:16px 0 6px}
    input{width:100%;box-sizing:border-box;border:1px solid rgba(26,25,24,.14);border-radius:10px;padding:12px 14px;font:inherit}
    button{margin-top:20px;width:100%;border:0;border-radius:10px;background:#D4A84B;color:#3E2200;padding:12px 14px;font:inherit;font-weight:700;cursor:pointer}
    .msg{margin-top:12px;color:#b42318;font-size:13px}
  </style>
</head>
<body>
  <form class="card" method="post" action="/auth/purdue/dev/link">
    <span class="badge">Mock Purdue Link</span>
    <h1>Link your Purdue account</h1>
    <p>This development screen stands in for Purdue CAS account linking until official CAS service registration is available.</p>
    <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
    ${token ? `<input type="hidden" name="t" value="${escapeHtml(token)}" />` : ''}
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
    supportedSources: ['purdue_schedule_ical', 'brightspace_ical'],
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
    const nameResult = normalizeDisplayName(req.body.name ?? req.body.displayName)
    const rememberMe = req.body.rememberMe === true
    const cookieMaxAge = rememberMe ? 1000 * 60 * 60 * 24 * 30 : undefined
    const normalizedEmail = normalizeEmail(emailRaw)
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      return res.status(400).json({ error: { message: 'Please enter a valid email address.', status: 400 } })
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: { message: 'Password must be at least 8 characters.', status: 400 } })
    }
    if (password.length > 128) {
      return res.status(400).json({ error: { message: 'Password must be at most 128 characters.', status: 400 } })
    }
    if (!nameResult.ok) {
      return res.status(400).json({ error: { message: nameResult.message, status: 400 } })
    }
    const displayName = nameResult.value

    const existingRow = await getUserByEmail(normalizedEmail)
    if (existingRow) {
      return res.status(400).json({ error: { message: 'An account with that email already exists.', status: 400 } })
    }

    const { data: created, error: authError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: displayName || deriveDisplayName(normalizedEmail, ''),
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
      // GoTrue's own text can name the column it rejected and echo the value
      // back; the client gets one generic line and the reason stays in the log.
      console.warn('[register] GoTrue rejected sign-up:', authError.code, raw)
      return badRequest(res, 'Could not create your account. Check the email and password and try again.')
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
      logRouteError('register-supabase: public.users insert failed', insertError)
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
      req.session.authAt = nowIso()
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
    throw new UpstreamError('Supabase Auth', 'config')
  }
  // 400/401/403/422 are GoTrue's "wrong credentials" answers and mean null;
  // anything else (5xx, a stall, a network error) is an outage and throws an
  // UpstreamError so sign-in answers 503 instead of "invalid password" (#205).
  const resp = await fetchUpstream('Supabase Auth', gotrue, {
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
      },
      body: JSON.stringify({ email, password }),
    },
    timeoutMs: 8000,
    acceptStatus: (status) => status === 400 || status === 401 || status === 403 || status === 422,
  })
  if (!resp.ok) return null
  const data = await resp.json().catch(() => null)
  return data?.user ?? null
}

// Move a pre-Supabase account (scrypt hash in public.users only) into Supabase
// Auth. Returns false when the email already exists there - in that case
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

  // Password sign-in must not fail on Auth metadata, so an over-long name is cut
  // and a non-string name or non-https avatar is ignored here (#199).
  const metadata = supabaseUser?.user_metadata || {}
  const metadataName =
    normalizeDisplayName(metadata.full_name, { truncate: true }).value ||
    normalizeDisplayName(metadata.name, { truncate: true }).value
  const metadataAvatarUrl = normalizeAvatarUrl(metadata.avatar_url).value

  let user = await getUserByEmail(normalizedEmail)
  if (user) {
    const { data, error } = await supabase
      .from('users')
      .update({
        display_name: metadataName || deriveDisplayName(normalizedEmail, user.display_name),
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
      display_name: metadataName || deriveDisplayName(normalizedEmail, ''),
      auth_provider: 'email',
      avatar_url: metadataAvatarUrl || null,
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
      req.session.authAt = nowIso()
      req.session.save(async () => {
        res.json({ session: await buildSessionPayload(user, req) })
      })
    })
  } catch (error) {
    if (error instanceof UpstreamError) {
      console.error('[sign-in] upstream failure:', error.message)
      return res.status(503).json({
        error: { message: 'Sign-in is temporarily unavailable. Please try again in a moment.', status: 503 },
      })
    }
    console.error('[sign-in] failed:', error?.message || error)
    res.status(401).json({ error: { message: 'Could not sign in.', status: 401 } })
  }
})

app.post('/api/sign-out', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME)
    res.json({ ok: true })
  })
})

app.post('/api/auth/supabase-sync', sessionSyncIpRateLimit, sessionSyncRateLimit, async (req, res) => {
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

    // The name comes from the OAuth provider and the user cannot shorten it, so
    // an over-long one is cut rather than failing sign-in; a non-string name or
    // a non-https avatar is still a 400 (#199).
    const nameResult = normalizeDisplayName(name, { truncate: true })
    if (!nameResult.ok) {
      return res.status(400).json({ error: { message: nameResult.message, status: 400 } })
    }
    const avatarResult = normalizeAvatarUrl(avatarUrl)
    if (!avatarResult.ok) {
      return res.status(400).json({ error: { message: avatarResult.message, status: 400 } })
    }
    const syncName = nameResult.value
    const syncAvatarUrl = avatarResult.value

    let user = await getUserByEmail(normalizedEmail)

    if (!user) {
      const timestamp = nowIso()
      const { data, error } = await supabase
        .from('users')
        .insert({
          id: supabaseUserId,
          email: normalizedEmail,
          password_hash: '',
          display_name: deriveDisplayName(normalizedEmail, syncName),
          auth_provider: normalizeProvider(provider, 'supabase'),
          avatar_url: syncAvatarUrl,
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
          // Only columns whose input was sent; the rest keep their stored value.
          ...(syncName ? { display_name: syncName } : {}),
          ...(syncAvatarUrl ? { avatar_url: syncAvatarUrl } : {}),
          auth_provider: user.auth_provider === 'local' ? user.auth_provider : normalizeProvider(provider, user.auth_provider),
          updated_at: nowIso()
        })
        .eq('id', user.id)
        .select()
        .single()

      if (error) {
        logRouteError('Failed to update user', error)
      } else {
        user = data
      }
    }

    if (!user) {
      return res.status(500).json({ error: { message: 'Could not sync user profile.', status: 500 } })
    }

    // The same user re-syncing (token refresh, app relaunch) already holds a
    // valid cookie session: answer from it instead of regenerating and saving a
    // new one on every call (#217). The profile update above still ran.
    if (req.session?.userId === user.id) {
      const session = await buildSessionPayload(user, req)
      return res.json({ session, reused: true })
    }

    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
      }
      req.session.userId = user.id
      req.session.authAt = nowIso()
      req.session.save(async () => {
        const session = await buildSessionPayload(user, req)
        res.json({ session })
      })
    })
  } catch (error) {
    logRouteError('Supabase sync error', error)
    res.status(500).json({ error: { message: 'Could not sync user.', status: 500 } })
  }
})

// Purdue link routes accept either the signed-in cookie session (website) or a
// handoff token minted by POST /api/purdue/link-token (native app, #214). The
// token path never reads or writes req.session, so the system browser that
// completes the link is not signed in to the website afterwards.
function nativeLinkRedirect(res, error) {
  const reason = error instanceof HandoffError ? error.reason : 'link-failed'
  const message = error instanceof HandoffError ? error.message : (error?.message || 'Could not link Purdue account.')
  return res.redirect(purdueLinkHandoff.returnUrl('error', { reason, message }))
}

async function resolvePurdueLinkActor(req, res, next) {
  // The same rule purdueLinkFlowRateLimit uses to pick the redirect shape.
  const token = linkHandoffToken(req)
  if (!token) return requireAuth(req, res, next)
  try {
    const { userId } = purdueLinkHandoff.verify(token)
    const user = await getUserById(userId)
    if (!user) {
      throw new HandoffError('This link no longer matches a student account. Start again from the app.', 410, 'unauthorized')
    }
    req.currentUser = user
    req.linkHandoff = { token }
    next()
  } catch (error) {
    nativeLinkRedirect(res, error)
  }
}

app.get('/auth/purdue/connect', purdueLinkFlowRateLimit, resolvePurdueLinkActor, (req, res) => {
  const native = req.linkHandoff
  const nextPath = sanitizeNext(req.query.next)
  if (!purdueLinkingEnabled) {
    if (native) return nativeLinkRedirect(res, new HandoffError('Purdue linking is currently disabled.', 400, 'disabled'))
    return res.redirect(`${clientAppUrl}/settings`)
  }
  if (purdueAuthMode === 'cas') {
    const loginUrl = process.env.PURDUE_CAS_LOGIN_URL
    const validateUrl = process.env.PURDUE_CAS_VALIDATE_URL
    if (!loginUrl || !validateUrl) {
      if (native) return nativeLinkRedirect(res, new HandoffError('Purdue login is not configured on the server.', 503, 'cas-config'))
      return res.redirect(`${clientAppUrl}/settings?error=cas-config`)
    }
    let serviceUrl
    if (native) {
      serviceUrl = casServiceUrl({ token: native.token })
    } else {
      // A fresh single-use nonce per website attempt, spent by the callback
      // (#293). requireAuth already ran, so the session exists and is saved
      // before the redirect goes out.
      const state = createCasState()
      req.session.casState = state
      serviceUrl = casServiceUrl({ nextPath, state })
    }
    return res.redirect(`${loginUrl}?service=${encodeURIComponent(serviceUrl)}`)
  }

  res.type('html').send(renderMockPurdueLinkPage(nextPath, '', req.currentUser.purdue_email, native?.token))
})

app.post('/auth/purdue/dev/link', purdueLinkFlowRateLimit, resolvePurdueLinkActor, async (req, res) => {
  const native = req.linkHandoff
  const nextPath = sanitizeNext(req.body.next)
  if (!purdueLinkingEnabled) {
    if (native) return nativeLinkRedirect(res, new HandoffError('Purdue linking is currently disabled.', 400, 'disabled'))
    return res.status(404).send('Purdue linking is currently disabled.')
  }
  if (purdueAuthMode === 'cas') {
    if (native) return nativeLinkRedirect(res, new HandoffError('Mock Purdue linking is disabled while CAS mode is active.', 404, 'cas-mode'))
    return res.status(404).send('Mock Purdue linking is disabled while CAS mode is active.')
  }
  try {
    await linkPurdueIdentity(req.currentUser.id, {
      email: req.body.email,
    })
    if (native) {
      // Consumed only after a successful link so the mock form can be retried
      // with a corrected email inside the token's window.
      purdueLinkHandoff.consume(native.token)
      return res.redirect(purdueLinkHandoff.returnUrl('ok'))
    }
    res.redirect(`${clientAppUrl}${nextPath}`)
  } catch (error) {
    if (error instanceof HandoffError) return nativeLinkRedirect(res, error)
    res.type('html').send(renderMockPurdueLinkPage(nextPath, error.message || 'Could not link Purdue account.', req.body.email, native?.token))
  }
})

app.post('/api/purdue/mock-link', userWriteRateLimit, requireAuth, async (req, res) => {
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

// Native app handoff (#214): the app calls this with its session cookie, opens
// connectUrl in an auth session (ASWebAuthenticationSession / Custom Tab) and
// waits for returnUrl, which carries ?status=ok or ?status=error&reason=...
app.post('/api/purdue/link-token', purdueLinkTokenRateLimit, requireAuth, (req, res) => {
  if (!purdueLinkingEnabled) {
    return res.status(400).json({ error: { message: 'Purdue linking is currently disabled.', status: 400, code: 'purdue_linking_disabled' } })
  }
  try {
    const { token, expiresAt } = purdueLinkHandoff.issue(req.currentUser.id)
    res.json({
      token,
      expiresAt,
      connectUrl: `${publicBaseUrl}/auth/purdue/connect?t=${encodeURIComponent(token)}`,
      returnUrl: purdueLinkHandoff.returnUrlBase,
    })
  } catch (error) {
    const status = error instanceof HandoffError ? error.status : 500
    const code = error instanceof HandoffError ? `purdue_link_${error.reason}` : undefined
    res.status(status).json({ error: { message: error.message || 'Could not start Purdue linking.', status, code } })
  }
})

app.get('/auth/purdue/callback', purdueLinkFlowRateLimit, resolvePurdueLinkActor, async (req, res) => {
  const native = req.linkHandoff
  const nextPath = sanitizeNext(req.query.next)
  // Website flow only: the callback has to come back to the session that
  // started it (#293). The nonce connect stored is spent first, whatever
  // happens next, and a missing or wrong ?state= ends the request before any
  // call to Purdue and before any write. The native flow is bound by its
  // signed handoff token instead and never reads the session.
  let state = ''
  if (!native) {
    state = spendCasState(req.session, req.query.state)
    if (state === null) return res.redirect(`${clientAppUrl}/settings?error=purdue-link-state`)
  }
  const ticket = req.query.ticket
  if (!ticket) {
    if (native) return nativeLinkRedirect(res, new HandoffError('Purdue login did not return a ticket. Start again from the app.', 400, 'missing-ticket'))
    return res.redirect(`${clientAppUrl}/settings?error=missing-ticket`)
  }
  try {
    const serviceUrl = casServiceUrl(native ? { token: native.token } : { nextPath, state })
    const identity = await validateCasTicket(String(ticket), serviceUrl)
    // The token is spent once Purdue has vouched for the ticket, before the
    // account write, so a replayed callback URL cannot link twice.
    if (native) purdueLinkHandoff.consume(native.token)
    await linkPurdueIdentity(req.currentUser.id, identity)
    if (native) return res.redirect(purdueLinkHandoff.returnUrl('ok'))
    res.redirect(`${clientAppUrl}${nextPath}`)
  } catch (error) {
    console.error('[auth/purdue/callback]', error)
    // A CAS timeout or outage gets a plain message; the upstream detail stays
    // in the log line above, as with the other upstream calls (#205).
    const failure = error instanceof UpstreamError
      ? new Error('Purdue login is not responding right now. Please try again in a few minutes.')
      : error
    if (native) return nativeLinkRedirect(res, failure)
    const message = encodeURIComponent(failure.message || 'Could not link Purdue account.')
    res.redirect(`${clientAppUrl}/setup?error=purdue-link&message=${message}`)
  }
})

app.get('/api/me/profile', requireAuth, async (req, res) => {
  const payload = await buildSessionPayload(req.currentUser, req)
  res.json({ user: payload.user })
})

app.patch('/api/me/profile', signInRateLimit, requireAuth, async (req, res) => {
  // A missing or blank name keeps the stored one. Settings resends the stored
  // name on every save, so an unchanged name from before the cap is cut rather
  // than blocking an email or password change (#199).
  const nameResult = normalizeProfileName(req.body.name, req.currentUser.display_name)
  if (!nameResult.ok) {
    return res.status(400).json({ error: { message: nameResult.message, status: 400 } })
  }
  try {
    const user = await updateUserProfile(req.currentUser.id, {
      email: req.body.email,
      displayName: nameResult.value,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
      analyticsOptOut: typeof req.body.analyticsOptOut === 'boolean' ? req.body.analyticsOptOut : undefined,
    })
    // The user just changed their own password: refresh this session's
    // establishment time so it survives its own change (#132).
    if (req.body.newPassword) {
      req.session.authAt = nowIso()
    }
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
      res.clearCookie(SESSION_COOKIE_NAME)
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
app.get('/api/debug/source/:sourceId', requireIdParam('sourceId'), requireAuth, async (req, res) => {
  if (isProduction) {
    return res.status(404).json({ error: { message: 'Not found.', status: 404 } })
  }

  const source = await getSourceForUser(req.params.sourceId, req.currentUser.id)
  if (!source) {
    return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
  }

  try {
    const icsText = await safeFetchIcsText(source.source_url)
    const eventsByKey = await ical.async.parseICS(icsText)
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
      error: { message: 'Debug failed.', status: 500 },
    })
  }
})

// Purdue schedule auto-capture (issue #120). The capture opens a visible
// Chromium on the machine running the server, so it is a local-dev convenience
// only: hidden in production (like /api/debug/source) and refused unless
// PURDUE_CALENDAR_AUTOMATION is explicitly on, so /start never reaches
// chromium.launch on a headless host such as Render.
function requireCalendarAutomation(req, res, next) {
  if (isProduction) {
    return res.status(404).json({ error: { message: 'Not found.', status: 404 } })
  }
  if (!isCalendarAutomationEnabled()) {
    return res.status(409).json({
      error: {
        message: 'Purdue schedule auto-capture is disabled on this server. Paste your UniTime iCalendar URL instead.',
        status: 409,
      },
    })
  }
  next()
}

app.post('/api/purdue/calendar-link/start', requireAuth, requireCalendarAutomation, requirePurdueLinked, async (req, res) => {
  try {
    const job = await startCalendarCapture(req.currentUser.id)
    res.status(202).json({ job })
  } catch (error) {
    res.status(500).json({ error: { message: error.message || 'Could not start Purdue timetable automation.', status: 500 } })
  }
})

app.get('/api/purdue/calendar-link/status', requireAuth, requireCalendarAutomation, requirePurdueLinked, async (req, res) => {
  res.json({ job: getCalendarCaptureJob(req.currentUser.id) })
})

app.post('/api/purdue/calendar-link/cancel', requireAuth, requireCalendarAutomation, requirePurdueLinked, async (req, res) => {
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

app.post('/api/sync/:sourceId', sourceSyncRateLimit, requireIdParam('sourceId'), requireAuth, async (req, res) => {
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

app.delete('/api/sources/:sourceId', userWriteRateLimit, requireIdParam('sourceId'), requireAuth, async (req, res) => {
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

    onboardingSummaryCache.invalidate(req.currentUser.id)
    
    res.json({ ok: true, message: 'Source and all associated items deleted.' })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not delete source.', status: 400 } })
  }
})

// Ascending order plus a row limit means an unbounded read returns the OLDEST
// rows, so once a user accumulates more than `limit` historical items the
// upcoming ones fall off the end and the page renders empty. Both of these
// routes serve forward-looking views, so they default to a recent window; a
// client that wants deeper history passes an explicit ?from=.
const CALENDAR_DEFAULT_LOOKBACK_DAYS = 14
function defaultCalendarFrom() {
  return new Date(Date.now() - CALENDAR_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

app.get('/api/me/calendar', requireAuth, async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : null
  const categories = typeof req.query.categories === 'string' ? req.query.categories.split(',').filter(Boolean) : null
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100
  const from = typeof req.query.from === 'string' ? req.query.from : defaultCalendarFrom()
  res.json({ items: await listCalendarItems(req.currentUser.id, { category, categories, limit, order: 'asc', from }) })
})

// Counted in Postgres by calendar_category_counts (db/supabase-calendar-category-counts.sql)
// instead of streaming every row to count in JS (issue #198); until that
// migration runs, loadCalendarCategoryCounts falls back to the JS count.
app.get('/api/me/calendar/categories', requireAuth, async (req, res) => {
  const { counts, error } = await loadCalendarCategoryCounts(supabase, req.currentUser.id)

  if (error) {
    return res.json({ categories: [] })
  }

  res.json({ categories: categoryListFromCounts(counts) })
})

// ── Tasks: mark calendar rows done + user-created dated tasks (see db/supabase-user-tasks.sql) ──
// Manual task rows are parsed and mapped by src/manualTasks.mjs (issue #216).

// Runs on every Assignments and dashboard load, so both reads are bounded
// (issue #198) instead of returning every row the user ever wrote:
// - completions from the last TASK_COMPLETIONS_LOOKBACK_DAYS only. Older ones
//   belong to calendar items that are no longer shown (Assignments lists items
//   from 14 days back), so dropping them changes nothing on screen.
// - manual tasks that are still open, or were completed in the last
//   MANUAL_TASKS_DONE_LOOKBACK_DAYS.
// Each read also caps at TASK_META_ROW_LIMIT, the PostgREST max-rows, so the
// bound is explicit rather than a silent truncation.
const TASK_COMPLETIONS_LOOKBACK_DAYS = 120
const MANUAL_TASKS_DONE_LOOKBACK_DAYS = 60
const TASK_META_ROW_LIMIT = 1000

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

app.get('/api/me/tasks/meta', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const [compRes, manualRes] = await Promise.all([
      supabase
        .from('user_task_completions')
        .select('calendar_item_id, completed_at')
        .eq('user_id', userId)
        .gte('completed_at', daysAgoIso(TASK_COMPLETIONS_LOOKBACK_DAYS))
        .order('completed_at', { ascending: false })
        .limit(TASK_META_ROW_LIMIT),
      supabase
        .from('user_manual_tasks')
        .select('*')
        .eq('user_id', userId)
        .or(`completed_at.is.null,completed_at.gte.${daysAgoIso(MANUAL_TASKS_DONE_LOOKBACK_DAYS)}`)
        .order('due_at', { ascending: true })
        .limit(TASK_META_ROW_LIMIT),
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

app.post('/api/me/tasks/calendar/complete', userWriteRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { calendarItemId, completed } = req.body || {}
  if (!calendarItemId || typeof completed !== 'boolean') {
    return badRequest(res, 'calendarItemId and completed (boolean) required')
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
    respondRouteError(res, e, { label: 'POST /api/me/tasks/calendar/complete', fallback: 'Could not update completion' })
  }
})

app.post('/api/me/tasks/manual', userWriteRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  // dueAt is optional (db/supabase-manual-task-due-optional.sql drops the NOT NULL). The mobile
  // client creates undated to-dos from a title alone, which this used to reject outright. A
  // dueAt that IS supplied still has to be a parseable timestamp, so a malformed date is a 400
  // rather than being silently stored as no deadline at all.
  const parsed = parseManualTaskCreate(req.body)
  if (!parsed.ok) return badRequest(res, parsed.message)
  try {
    const countResult = await supabase
      .from('user_manual_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
    const cap = capCheck(countResult, MAX_MANUAL_TASKS)
    if (cap.failure) console.error('POST /api/me/tasks/manual:', cap.failure, countResult.error)
    if (cap.blocked) {
      return res.status(409).json({ error: { message: MANUAL_TASKS_CAP_MESSAGE, status: 409 } })
    }
    const { data, error } = await supabase
      .from('user_manual_tasks')
      .insert({
        user_id: userId,
        title: parsed.row.title,
        due_at: parsed.row.due_at,
      })
      .select()
      .single()
    if (error) throw error
    res.json({ task: mapManualTaskRow(data) })
  } catch (e) {
    respondRouteError(res, e, { label: 'POST /api/me/tasks/manual', fallback: 'Could not create task' })
  }
})

app.patch('/api/me/tasks/manual/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  // An absent dueAt leaves the deadline alone; null or '' clears it (issue #216). A malformed
  // value is a 400 like POST instead of being dropped while the other fields save.
  const parsed = parseManualTaskUpdate(req.body, { now: nowIso() })
  if (!parsed.ok) return badRequest(res, parsed.message)
  try {
    const { data, error } = await supabase
      .from('user_manual_tasks')
      .update(parsed.updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      // maybeSingle: .single() answers PGRST116 for zero rows, which made the
      // 404 below unreachable and sent someone else's id down the 500 path (#196).
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: { message: 'Task not found.', status: 404 } })
    res.json({ task: mapManualTaskRow(data) })
  } catch (e) {
    respondRouteError(res, e, { label: 'PATCH /api/me/tasks/manual', fallback: 'Could not update task' })
  }
})

app.delete('/api/me/tasks/manual/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  try {
    const { error } = await supabase.from('user_manual_tasks').delete().eq('id', id).eq('user_id', userId)
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    respondRouteError(res, e, { label: 'DELETE /api/me/tasks/manual', fallback: 'Could not delete task' })
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

app.post('/api/me/grades', userWriteRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { value, error: invalid } = parseGradeBody(req.body || {}, { partial: false })
  if (invalid) return badRequest(res, invalid)
  try {
    const countResult = await supabase
      .from('user_grades')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
    const cap = capCheck(countResult, MAX_GRADES)
    if (cap.failure) console.error('POST /api/me/grades:', cap.failure, countResult.error)
    if (cap.blocked) {
      return res.status(409).json({ error: { message: GRADES_CAP_MESSAGE, status: 409 } })
    }
    const { data, error } = await supabase
      .from('user_grades')
      .insert({ user_id: userId, ...value })
      .select()
      .single()
    if (error) throw error
    res.json({ grade: mapGradeRow(data) })
  } catch (e) {
    respondRouteError(res, e, { label: 'POST /api/me/grades', fallback: 'Could not save course' })
  }
})

app.patch('/api/me/grades/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  const { value, error: invalid } = parseGradeBody(req.body || {}, { partial: true })
  if (invalid) return badRequest(res, invalid)
  if (Object.keys(value).length === 0) {
    return badRequest(res, 'No valid fields to update')
  }
  try {
    const { data, error } = await supabase
      .from('user_grades')
      .update(value)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: { message: 'Course not found.', status: 404 } })
    res.json({ grade: mapGradeRow(data) })
  } catch (e) {
    respondRouteError(res, e, { label: 'PATCH /api/me/grades/:id', fallback: 'Could not update course' })
  }
})

app.delete('/api/me/grades/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  try {
    const { error } = await supabase.from('user_grades').delete().eq('id', id).eq('user_id', userId)
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    respondRouteError(res, e, { label: 'DELETE /api/me/grades/:id', fallback: 'Could not delete course' })
  }
})

// Selected major for the degree planner (issue #18). Validated against the
// degreePrograms catalogue; null clears it.
app.get('/api/me/degree', requireAuth, async (req, res) => {
  res.json({ major: req.currentUser.major ?? null })
})

app.put('/api/me/degree', userWriteRateLimit, requireAuth, async (req, res) => {
  const raw = req.body?.major
  const major = raw == null || raw === '' ? null : String(raw)
  if (major !== null && !getProgram(major)) {
    return badRequest(res, 'Unknown major')
  }
  const { error } = await supabase.from('users').update({ major }).eq('id', req.currentUser.id)
  if (error) {
    console.error('PUT /api/me/degree:', error.message)
    return res.status(500).json({ error: { message: 'Could not save your major.' } })
  }
  res.json({ major })
})

// ---- Schedule overrides --------------------------------------------------
// Hidden / edited / manually added class meetings. Previously localStorage only,
// so they were lost on a new device and invisible to the campus assistant.
// Stored as one JSONB document because the client always reads and writes the
// whole state at once.
async function readScheduleOverrides(userId) {
  const { data, error } = await supabase
    .from('user_schedule_overrides')
    .select('series, manual')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return { series: {}, manual: [] }
  return normalizeScheduleOverrides(data)
}

app.get('/api/me/schedule-overrides', requireAuth, async (req, res) => {
  try {
    res.json({ overrides: await readScheduleOverrides(req.currentUser.id) })
  } catch (e) {
    console.error('GET /api/me/schedule-overrides:', e?.message || e)
    // The client keeps a local copy, so an unavailable table degrades to
    // "no server state yet" rather than wiping the student's edits.
    res.json({ overrides: { series: {}, manual: [] }, unavailable: true })
  }
})

app.put('/api/me/schedule-overrides', userWriteRateLimit, requireAuth, async (req, res) => {
  const overrides = normalizeScheduleOverrides(req.body?.overrides)
  try {
    const { error } = await supabase
      .from('user_schedule_overrides')
      .upsert(
        {
          user_id: req.currentUser.id,
          series: overrides.series,
          manual: overrides.manual,
          updated_at: nowIso(),
        },
        { onConflict: 'user_id' },
      )
    if (error) throw error
    res.json({ overrides })
  } catch (e) {
    console.error('PUT /api/me/schedule-overrides:', e?.message || e)
    res.status(500).json({ error: { message: 'Could not save schedule changes.' } })
  }
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
  const from = typeof req.query.from === 'string' ? req.query.from : defaultCalendarFrom()
  res.json({ items: await listCalendarItems(req.currentUser.id, { category: 'event', limit, order: 'asc', from }) })
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

app.post('/api/me/calendar-feed/token', userWriteRateLimit, requireAuth, async (req, res) => {
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

  // Look the user up by token only - never logged, never reflected back.
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
// The standalone Lost & Found routes live in src/routes/lostFound.mjs (issue
// #191), mounted where they were, above the layouts router.
app.use(createLostFoundRouter({ supabase, requireAuth, isUserAdmin, lostFoundWriteRateLimit, userWriteRateLimit }))

// ── Customizable board layouts (issue #52) ───────────────────────────────────
// The home dashboard and Student Services board layouts live in
// src/routes/layouts.mjs, the first feature router out of this file (issue
// #191). Mounted where the routes were, so ordering-sensitive middleware (the
// session above, apiNotFound and the error handler below) is unaffected.
app.use(createLayoutsRouter({ supabase, requireAuth, userWriteRateLimit }))

// ── Reporting content and blocking users (issue #192) ───────────────────────
// POST /api/reports lives in src/routes/reports.mjs: one report route for every
// surface students post to, feeding the admin queue below. The block routes
// (/api/me/blocks*) live in src/routes/blocks.mjs; every list of other
// students' content leaves blocked users out through src/blocks.mjs.
app.use(createReportsRouter({ supabase, requireAuth, reportRateLimit }))
app.use(createBlocksRouter({ supabase, requireAuth, userWriteRateLimit }))

// ── Purdue email-code verification (issue #181) ─────────────────────────────
// /api/me/purdue-email/* in src/routes/purdueEmail.mjs: a code mailed to a
// @purdue.edu address links it through linkPurdueIdentity, in every
// PURDUE_AUTH_MODE, since it proves only that the student reads that mailbox.
app.use(createPurdueEmailRouter({ supabase, requireAuth, purdueVerifyRateLimit, linkPurdueIdentity, sendEmail, isProduction }))

app.get('/', (_req, res) => {
  res.redirect(clientAppUrl)
})

// ============================================================
// Groq campus assistant (Gemini -> xAI Grok -> Groq, 2026-09-14)
// ============================================================
const GROQ_API_KEY = process.env.GROQ_API_KEY
// Model, 429 fallback model and (gpt-oss only) reasoning effort come from the
// env so a model swap needs no deploy; src/groqClient.mjs holds the defaults
// and the wire format.
const ai = createGroqClient({
  apiKey: GROQ_API_KEY,
  model: process.env.GROQ_MODEL,
  fallbackModel: process.env.GROQ_FALLBACK_MODEL,
  reasoningEffort: process.env.GROQ_REASONING_EFFORT,
  onFallback: warnGroqFallback,
})
if (!GROQ_API_KEY && process.env.XAI_API_KEY) {
  // The previous provider's key is still configured: say so once at boot instead
  // of silently answering "offline" (see .env.example, "Groq AI").
  console.warn('[ai] XAI_API_KEY is set but the assistant now uses Groq. Set GROQ_API_KEY (keys start with gsk_) and remove XAI_*.')
}
const TZ = 'America/Indiana/Indianapolis'

// AI inference metering (issue #191): the assistant and the board helpers used
// a hand-rolled hourly window; they are now buckets of the shared limiter, with
// the same RATE_LIMIT_* overrides and headers as everything else. Separate
// buckets, so a long conversation cannot use up a student's compose
// suggestions and vice versa. The assistant keeps its pre-envelope 429 body (a
// string `error`), which is what CampusAssistant.tsx renders.
const assistantRateLimit = createRateLimiter({
  name: 'ai-assistant',
  windowMs: 60 * 60 * 1000,
  max: 40,
  onLimit: (_req, res) =>
    res.status(429).json({ error: 'You have hit the hourly assistant limit. Try again in a little while.' }),
  // Only real inference is metered: without a Groq key the route answers from
  // the offline router, which costs nothing. A skip rather than a wrapper, so
  // the limiter sits on the route line where the RATE_LIMITS doc guard reads it.
  skip: () => !GROQ_API_KEY,
})
const boardAiRateLimit = createRateLimiter({
  name: 'ai-board',
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'Rate limit reached. Try again in an hour.',
})
// The auto-tagger runs inside POST /api/board/posts rather than as a route of
// its own, so it meters its inference calls through a window, not a middleware.
const boardTagWindow = createRateWindow({ name: 'ai-board-tags', windowMs: 60 * 60 * 1000, max: 30 })

const CAMPUS_SYSTEM_PROMPT = `You are BoilerIndy - a helpful campus assistant for Purdue University Indianapolis (Purdue Indy / IUPUI).
You have access to real-time data about the student's schedule, dining, and campus events - all provided in the context block below.
Use that data to answer questions directly and accurately. Do not tell the student to "check the app" or "check the tab" when the answer is already in the context.

You help students with:
- Their personal class schedule (including earlier today and what's in session), upcoming assignments, exams, and due dates (from context)
- Dining hours and today's menu at each location (from context)
- Campus / career / optional events (from context)
- Where to study and get help on campus (use the ON-CAMPUS STUDY & HELP section when it is present)
- Campus transit/buses: Crimson & Gray routes run Mon-Fri 6:30am-10pm; Yellow & Blue run Mon-Fri 5:30am-midnight; Purple runs Mon-Fri 7am-10pm; Orange runs Sat-Sun 9am-8pm
- Buildings: ET Building (engineering/tech), Campus Center (dining, student services), University Library, Science & Engineering Lab Building (SL), Cavanaugh Hall (CA), Hine Hall (HH), Madam Walker Legacy Center, IUPUI Tower
- Student services: ASC tutoring (Campus Center 2nd floor), printing (library 25 free pages/day), Health & Wellness Center, Financial Aid (Cavanaugh Hall), Registrar (Cavanaugh Hall)
- General student life at Purdue Indy

How to read the context block:
- COURSES, TODAY and HAPPENING NOW already reflect the student's own edits: classes they deleted are gone, times and rooms they corrected are applied, and classes they added by hand are included and marked [added by you]. Treat it as the truth. Never mention a class that is not listed.
- Anything marked [DONE] is already finished. Never tell the student to do it, and never count it as pending work.
- YOUR TASK LIST is the to-dos the student typed in themselves. It is just as real as synced coursework - weave both together rather than treating the synced list as the only one.
- Items marked [OVERDUE] are late. Call those out first when the student asks what to work on.

Formatting (the app renders your reply as markdown):
- Use "-" bullets for lists of classes, deadlines, menu items or steps. Never write a numbered plan as one long paragraph.
- Bold the thing that matters most in a line - a course code, a time, a deadline - with **double asterisks**. Do not bold whole sentences.
- No headings for short answers. Only use "###" when the reply genuinely has two or more distinct sections.
- Write times the way a person says them: "2:30pm", not "14:30" or "2:30 PM Eastern".
- Never output raw JSON, tables, code fences or a dump of the context block.

Rules:
- Be concise and friendly. For simple questions: 2-4 sentences, no bullets. For "what should I do now?", "plan my afternoon", or similar planning questions: a short prioritized list of 3-5 bullets, each one concrete and tied to a real time.
- Open with the answer. No "Sure!", no "Great question", no restating what they asked.
- Answer directly from the context data when available - do not hedge or defer.
- Refer to the student's own data specifically: name the course code, time and room exactly as the context lists them, rather than "you have a class this afternoon". Never name a course, time or room the context does not list.
- When the student asks what to do *now*, *next*, or how to balance their time: anchor on CURRENT DATE & TIME. Weigh together: (1) anything in HAPPENING NOW, (2) classes or exams starting within the next ~2 hours, (3) homework or projects due in the next 24-48 hours (especially tonight), (4) upcoming exams/quizzes that need prep time, (5) optional campus events. Do **not** push optional events over urgent coursework or tight deadlines unless they are clearly free.
- If homework is due tonight, say so and suggest when to work on it relative to class, meals, and events already on their calendar.
- For exam prep or heavy homework blocks, suggest concrete on-campus options from the STUDY & HELP section when it is present (e.g. library quiet floors, ET/SL for STEM, ASC tutoring for support - match to subject when possible).
- For "next class" questions only count regular lectures/labs/discussions, not exams or office hours (unless asked).
- If something is genuinely unknown (not in context and not general knowledge), say so briefly.
- If asked about something totally unrelated to campus life, briefly redirect.

Reply format (strict, overrides anything above):
- Plain text only. No markdown: no **bold**, no # headings, no tables. A short list with "- " lines is fine for 2 to 5 items.
- Keep it short. Simple question: one to three sentences, under 60 words. Planning question ("what should I do", "what's the play", "plan my afternoon"): at most 4 lines or 4 sentences, under 90 words, covering only the next few hours, most important thing first.
- Never use em dashes or en dashes. Use a comma, a period, or a plain hyphen.
- Lead with the answer. No greeting, no restating the question, no closing offer like "let me know if you need anything else".
- Use clock times like 12:15 PM and the real names from the context.`

// Shown in the chat when Groq answers 429: the free tier is capped per minute
// and per day for the whole organisation (issue #252), and a friendly line in
// the bubble beats a red error for something the student cannot fix.
const ASSISTANT_BUSY_MESSAGE =
  'The assistant is busy right now. Give it a minute and ask again, or check the Schedule, Dining and Transit tabs directly.'

// ── Context formatters ────────────────────────────────────────────────────────

function fmtTime(isoStr, opts = {}) {
  return new Date(isoStr).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', ...opts })
}
function fmtDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' })
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

/**
 * Rich calendar context for /api/assistant: today, ongoing, exams, assignments,
 * events, and the study hints when `includeStudyHelp` (issue #253: questions
 * about studying, see wantsStudyHelp) or when homework or an exam falls in the
 * next 48 hours, since the prompt has the model plan study time around those.
 *
 * `completedIds` marks finished work instead of hiding it: the student may ask
 * "did I finish X?", but the model must stop recommending what is already done.
 */
function buildAssistantCalendarContext(calendarData, now, { includeStudyHelp = false, completedIds = new Set() } = {}) {
  if (!calendarData?.length) {
    return '=== CALENDAR ===\nNo calendar items in the fetched window.'
  }
  // Completed work still has to appear (the student may ask "did I finish X?"),
  // but it is labelled so the model stops recommending things already done.
  const doneMark = (row) => (completedIds.has(row.id) ? ' [DONE]' : '')
  const addedMark = (row) => (row.manual ? ' [added by you]' : '')

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
        .map((i) => `- Until ${fmtTime(i.end_time)}: ${i.title} [${i.category}]${i.location ? ` @ ${i.location}` : ''}${addedMark(i)}`)
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
    parts.push(`=== TODAY (${dayLabel}) - everything with times (Eastern) ===`)
    parts.push(
      todayRows
        .map((i) => {
          const range = i.end_time
            ? `${fmtTime(i.start_time)}-${fmtTime(i.end_time)}`
            : fmtTime(i.start_time)
          return `- ${range}: ${i.title} [${i.category}]${i.location ? ` @ ${i.location}` : ''}${addedMark(i)}${doneMark(i)}`
        })
        .join('\n'),
    )
  }

  if (assignmentRows.length) {
    parts.push('=== UPCOMING ASSIGNMENTS / HOMEWORK / DEADLINES (from synced courses) ===')
    parts.push(
      assignmentRows
        .map((i) => `- Due ${fmtDate(i.start_time)} ${fmtTime(i.start_time)}: ${i.title}${i.location ? ` (${i.location})` : ''} [${i.category}]${doneMark(i)}`)
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

  if (includeStudyHelp || startsWithin([...assignmentRows, ...examRows], now, STUDY_HELP_DEADLINE_HOURS)) {
    parts.push(`=== ON-CAMPUS STUDY & HELP (suggest when relevant) ===
- University Library: quiet floors, study rooms, printing (25 free pages/day).
- ET Building & Science/Engineering Lab (SL): strong for STEM work between classes.
- Cavanaugh Hall & Hine Hall: lounges for shorter sessions.
- ASC tutoring: Campus Center 2nd floor - math, writing, coaching (check hours).
- Campus Center: food and space to regroup before/after events.`)
  }

  return parts.join('\n\n')
}

// Model calls per user per hour. The intent router used to absorb the most
// common asks for free; now every question reaches the model, so the ceiling has
// to be high enough for a real conversation.

/** Tells the model which screen the student is looking at, when the client says. */
function describeAssistantPage(page) {
  if (typeof page !== 'string') return ''
  const label = ASSISTANT_PAGE_LABELS[page]
  if (!label) return ''
  return `=== WHERE THEY ARE ===\nThe student is on the ${label}. Prefer answers that are useful from this screen, and do not tell them to open the page they are already on.`
}

const ASSISTANT_PAGE_LABELS = {
  '/dashboard': 'dashboard',
  '/schedule': 'class schedule page',
  '/assignments': 'assignments and tasks page',
  '/dining': 'dining page',
  '/events': 'campus events page',
  '/board': 'campus board',
  '/transit': 'transit page',
  '/map': 'campus map',
  '/more': 'more / tools page',
  '/settings': 'settings page',
}

/**
 * Last-resort answers for when GROQ_API_KEY is missing. This is the templated
 * path that used to run for every matching question; it now only runs when
 * there is no model available at all.
 */
async function buildOfflineAssistantReply(intent, userId, now) {
  if (intent === 'next_class' || intent === 'classes_today') {
    const { items } = await getClassItemsForUser(userId, { term: 'auto', limit: 50 })
    return intent === 'next_class' ? formatNextClass(items, now, TZ) : formatClassesToday(items, now, TZ)
  }
  if (intent === 'dining_open') {
    return formatDiningOpen(await getDiningSnapshot({}).catch(() => null))
  }
  if (intent === 'assignments') {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const items = await listCalendarItems(userId, {
      categories: [...ASSISTANT_ASSIGNMENT_CATEGORIES],
      limit: 50,
      order: 'asc',
      from: since,
    })
    return formatAssignments(items, now, TZ)
  }
  return null
}

/**
 * The student's own to-do list (user_manual_tasks). These never lived in
 * calendar_items, which is why the assistant used to be blind to anything the
 * student added by hand.
 */
function buildManualTaskContext(tasks, now) {
  if (!tasks?.length) {
    return '=== YOUR TASK LIST (to-dos the student added by hand) ===\nEmpty - the student has not added any of their own tasks.'
  }
  const lines = tasks.map((t) => {
    const done = t.completed_at ? '[DONE] ' : ''
    if (!t.due_at) return `- ${done}${t.title} (no due date)`
    const overdue = !t.completed_at && new Date(t.due_at) < now ? ' [OVERDUE]' : ''
    return `- ${done}Due ${fmtDate(t.due_at)} ${fmtTime(t.due_at)}: ${t.title}${overdue}`
  })
  return `=== YOUR TASK LIST (to-dos the student added by hand) ===\n${lines.join('\n')}`
}

/**
 * Everything the assistant knows about this student, assembled in parallel.
 *
 * Deliberately mirrors what the student sees in the UI: schedule overrides are
 * replayed and manually added classes injected, so the assistant cannot talk
 * about a class the student deleted or miss one they created.
 */
async function gatherAssistantContext(userId, now) {
  const nowISOStr = now.toISOString()
  const lowerBound = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const sel = 'id, title, description, start_time, end_time, location, category'

  const [dining, calendar, taskMeta, overrides] = await Promise.all([
    getDiningSnapshot({}).catch(() => null),
    (async () => {
      const [upcomingRes, ongoingRes] = await Promise.all([
        supabase
          .from('calendar_items')
          .select(sel)
          .eq('user_id', userId)
          .gte('start_time', lowerBound)
          .lte('start_time', horizon)
          .order('start_time', { ascending: true })
          .limit(60),
        supabase
          .from('calendar_items')
          .select(sel)
          .eq('user_id', userId)
          .lt('start_time', nowISOStr)
          .gt('end_time', nowISOStr)
          .limit(25),
      ])
      const byId = new Map()
      for (const r of ongoingRes.data || []) byId.set(r.id, r)
      for (const r of upcomingRes.data || []) byId.set(r.id, r)
      return [...byId.values()]
    })().catch(() => []),
    (async () => {
      const [compRes, manualRes] = await Promise.all([
        supabase.from('user_task_completions').select('calendar_item_id').eq('user_id', userId),
        supabase
          .from('user_manual_tasks')
          .select('title, due_at, completed_at')
          .eq('user_id', userId)
          .order('due_at', { ascending: true })
          .limit(60),
      ])
      return {
        completedIds: new Set((compRes.data || []).map((r) => r.calendar_item_id)),
        manualTasks: manualRes.data || [],
      }
    })().catch(() => ({ completedIds: new Set(), manualTasks: [] })),
    readScheduleOverrides(userId).catch(() => ({ series: {}, manual: [] })),
  ])

  const corrected = applyScheduleOverridesToRows(calendar, overrides, TZ)
  const manualClasses = manualClassesAsRows(overrides.manual, new Date(lowerBound), new Date(horizon), TZ)
  const calendarRows = [...corrected, ...manualClasses].sort(
    (a, b) => new Date(a.start_time) - new Date(b.start_time),
  )

  return { dining, calendarRows, ...taskMeta }
}

app.post('/api/assistant', requireAuth, assistantRateLimit, async (req, res) => {
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

  const lastUserMessage = [...messages].reverse().find((m) => m?.role === 'user')?.content || ''

  if (!GROQ_API_KEY) {
    // Without a key the formatters are the only thing that can answer, so this
    // is the one path where their templated output is still shown verbatim.
    const now = new Date()
    try {
      const routed = await buildOfflineAssistantReply(matchIntent(lastUserMessage), req.currentUser.id, now)
      if (routed) return res.json({ reply: routed, source: 'offline-router' })
    } catch {
      /* fall through to the generic offline notice */
    }
    return res.json({ reply: ASSISTANT_OFFLINE_MESSAGE, source: 'offline' })
  }

  const now = new Date()
  const nowLabel = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const timeLabel = now.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })

  const { dining, calendarRows, completedIds, manualTasks } = await gatherAssistantContext(
    req.currentUser.id,
    now,
  )

  // Prompt trim (issue #253): the study and help hints only for study questions
  // or a deadline in the next 48 hours. The dining trim is applied where the
  // context block is assembled, so it sees the question too.
  const includeStudyHelp = wantsStudyHelp(lastUserMessage)
  // A matched intent no longer answers for the model, it just tells it which
  // section to lead with.
  const focusHint = intentFocusHint(matchIntent(lastUserMessage))
  const pageHint = describeAssistantPage(req.body?.page)

  const contextBlock = [
    `=== CURRENT DATE & TIME ===\n${nowLabel} at ${timeLabel} (Eastern)`,
    pageHint,
    buildDiningContext(dining, { now, question: lastUserMessage }),
    calendarContextFor(calendarRows, (rows) => buildAssistantCalendarContext(rows, now, { includeStudyHelp, completedIds })),
    buildManualTaskContext(manualTasks, now),
    focusHint ? `=== WHAT THEY ARE ASKING ABOUT ===\n${focusHint}` : '',
  ].filter(Boolean).join('\n\n')

  const systemPrompt = CAMPUS_SYSTEM_PROMPT + '\n\n' + contextBlock
  const promptText = [systemPrompt, ...messages.map((m) => (typeof m?.content === 'string' ? m.content : ''))].join('\n')
  console.debug(`[assistant] prompt ~${estimateTokens(promptText)} tokens`)

  const history = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }))

  try {
    // 2800 completion tokens rather than the 600 the router-era prompt needed:
    // the model now writes every reply, including the 3-5 bullet planning lists
    // the format rules allow, and low-effort reasoning tokens count against it.
    const text = await ai.reply({
      system: systemPrompt,
      messages: history,
      maxOutputTokens: 2800,
      temperature: 0.52,
    })
    // Plain text for the bubble whatever the model did (issue #252).
    res.json({ reply: tidyAssistantReply(text) ?? "Sorry, I couldn't generate a response." })
  } catch (err) {
    if (err instanceof GroqUpstreamError && err.status === 429) {
      // Both the primary and the fallback model answered 429 (the client retries once).
      warnAssistantBusy(err)
      return res.json({ reply: ASSISTANT_BUSY_MESSAGE, source: 'busy' })
    }
    if (err instanceof GroqUpstreamError) {
      console.error('Groq error:', err.body)
      return res.status(502).json({ error: 'AI service error' })
    }
    console.error('Assistant error:', err)
    res.status(500).json({ error: 'Assistant request failed' })
  }
})

/**
 * Opening state for the chat panel: what is actually going on right now, plus
 * suggested questions that match it.
 *
 * Deliberately NOT a model call. The panel used to greet everyone with the same
 * hardcoded sentence and the same five fixed chips, which is what made it read
 * as a generic chat box. This is real data, rendered deterministically, so it is
 * instant and free - the model still writes every actual answer.
 */
app.get('/api/assistant/briefing', requireAuth, async (req, res) => {
  const now = new Date()
  try {
    const { dining, calendarRows, completedIds, manualTasks } = await gatherAssistantContext(
      req.currentUser.id,
      now,
    )

    const isDone = (row) => completedIds.has(row.id)
    const classesLeftToday = calendarRows.filter(
      (r) => r.category === 'class' && isSameZonedCalendarDay(r.start_time, now, TZ) && new Date(r.start_time) > now,
    )
    const inSession = calendarRows.find(
      (r) => r.start_time && r.end_time && new Date(r.start_time) <= now && new Date(r.end_time) > now,
    )

    const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const dueThisWeek = calendarRows.filter(
      (r) =>
        ASSISTANT_ASSIGNMENT_CATEGORIES.has(r.category) &&
        !isDone(r) &&
        new Date(r.start_time) >= now &&
        new Date(r.start_time) <= weekOut,
    )
    const openTasks = manualTasks.filter((t) => !t.completed_at)
    const overdue = openTasks.filter((t) => t.due_at && new Date(t.due_at) < now)
    const openDining = (dining?.locations || []).filter((l) => l.is_open)

    const facts = []
    if (inSession) facts.push(`${inSession.title} until ${fmtTime(inSession.end_time)}`)
    else if (classesLeftToday.length) {
      const next = classesLeftToday[0]
      facts.push(`${next.title} at ${fmtTime(next.start_time)}`)
    }
    const pending = dueThisWeek.length + openTasks.length
    if (pending) facts.push(`${pending} thing${pending === 1 ? '' : 's'} on your plate`)
    if (overdue.length) facts.push(`${overdue.length} overdue`)

    const chips = []
    if (classesLeftToday.length || inSession) chips.push("What's my next class?")
    if (overdue.length) chips.push("What am I behind on?")
    if (dueThisWeek.length || openTasks.length) chips.push('What should I work on tonight?')
    chips.push('What should I do right now?')
    if (openDining.length) chips.push("What's good at dining right now?")
    chips.push('Plan my week')

    res.json({
      headline: facts.length ? facts.join(' · ') : 'Nothing scheduled right now',
      chips: chips.slice(0, 5),
    })
  } catch (e) {
    console.error('GET /api/assistant/briefing:', e?.message || e)
    // The panel falls back to a plain greeting; never block opening the chat.
    res.json({ headline: '', chips: [] })
  }
})

// ── Tiny in-memory TTL cache for quasi-static upstream/DB reads (perf) ──────
// Repeat calls within the TTL return instantly instead of re-hitting TransLoc /
// Supabase on every page load. Concurrent misses share one fill, a failed
// refresh serves the last good value (#205), and failures are never cached.
// Process-local - fine for a single instance; swap for Redis if the backend is
// ever horizontally scaled. See src/upstreamFetch.mjs.
const upstreamCache = createStaleCache()
async function getCached(key, ttlMs, producer) {
  return upstreamCache.get(key, ttlMs, producer)
}

// ============================================================
// Push notifications (issue #9) - subscriptions, settings, test sends and the
// reminder cron route, in src/routes/push.mjs (issue #191). GET
// /api/push/config is mounted in the public reads block above, which is also
// where the VAPID keys are loaded. The cron bearer token, its check and
// warnCronTransient stay here because the source re-sync route below uses
// them too.
// ============================================================
const PUSH_CRON_SECRET = String(process.env.PUSH_CRON_SECRET || '').trim()

function pushCronSecretMatches(header) {
  if (!PUSH_CRON_SECRET) return false
  const token = String(header || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return false
  const given = crypto.createHash('sha256').update(token).digest()
  const expected = crypto.createHash('sha256').update(PUSH_CRON_SECRET).digest()
  return crypto.timingSafeEqual(given, expected)
}

app.use(createPushRouter({ supabase, requireAuth, pushWriteRateLimit, pushTestRateLimit, vapidKeys, PUSH_CRON_SECRET, pushCronSecretMatches, warnCronTransient }))

// A Supabase 5xx or timeout that survived a tick's one retry (issue #242) is
// a warning, not a bug per tick: console.warn keeps it in the Render log, and
// captureMessage files one warning-level Sentry issue per route and failure
// kind (the console integration forwards console.error only), whose event
// count is the trend to watch. Without a DSN captureMessage is a no-op.
function warnCronTransient(route, error) {
  const what = describeFailure(error)
  console.warn(`${route}: ${what} on both attempts (${error?.message || error}); the next tick will retry`)
  Sentry.captureMessage(`${route}: transient upstream failure (${what})`, {
    level: 'warning',
    fingerprint: ['cron-transient', route, what],
    extra: { message: String(error?.message || error), status: error?.status ?? null, code: error?.code ?? null },
  })
}

// Groq's free tier caps the whole organisation per minute and per day (issue
// #253), so a 429 on /api/assistant is a capacity signal, not a bug per hit:
// console.warn keeps each one in the Render log, and captureMessage files one
// warning-level Sentry issue per Indianapolis calendar day whose event count
// shows how often students met the cap that day.
function warnAssistantBusy(error) {
  const retryAfter = error?.retryAfter ?? null
  const remainingTokens = error?.remainingTokens ?? null
  console.warn(
    `Groq rate limit (retry-after ${retryAfter ?? '?'}s, remaining tokens ${remainingTokens ?? '?'}):`,
    String(error?.body || '').slice(0, 200),
  )
  const dayKey = todayYmdInZone(new Date(), TZ)
  Sentry.captureMessage('assistant: Groq rate limited', {
    level: 'warning',
    fingerprint: ['assistant-busy', dayKey],
    extra: { retryAfter, remainingTokens },
  })
}

// The primary model answered 429 and the client is retrying on the fallback
// model (issue #253). Students still get a reply, so without this a primary
// model at its daily cap would leave no trace; one warning-level Sentry issue
// per Indianapolis day counts how often it happened, for the Dev tier decision.
// Covers the assistant and the board AI, which share the client.
function warnGroqFallback(error, { model, fallbackModel } = {}) {
  const retryAfter = error?.retryAfter ?? null
  const remainingTokens = error?.remainingTokens ?? null
  console.warn(
    `Groq rate limit on ${model} (retry-after ${retryAfter ?? '?'}s, remaining tokens ${remainingTokens ?? '?'}); retrying on ${fallbackModel}`,
  )
  const dayKey = todayYmdInZone(new Date(), TZ)
  Sentry.captureMessage('ai: Groq primary model rate limited, used the fallback model', {
    level: 'warning',
    fingerprint: ['groq-fallback', dayKey],
    extra: { model, fallbackModel, retryAfter, remainingTokens },
  })
}

// Background re-sync of linked calendar sources (issue #12): keeps imported
// due dates fresh without the student pressing "Sync all". Called hourly by
// the pg_cron job in db/supabase-source-resync.sql with the same bearer token
// as the reminder runner. Sequential per run (one upstream fetch at a time),
// 15 sources per tick, oldest first; a tick already in flight answers 409.
// The candidate listing gets one retry on a transient Supabase failure, and
// each feed fetch one retry on a transient failure of the feed host.
let sourceResyncInFlight = false
app.post('/api/internal/sources/resync', async (req, res, next) => {
  if (!PUSH_CRON_SECRET) return next()
  if (!pushCronSecretMatches(req.get('authorization'))) {
    return res.status(401).json({ error: { message: 'Invalid cron secret.', status: 401 } })
  }
  if (sourceResyncInFlight) {
    return res.status(409).json({ ok: false, error: 'resync_in_progress' })
  }
  sourceResyncInFlight = true
  try {
    const sync = (source) => runScheduleSync(source, { retryTransient: true })
    const outcome = await runCronTick('resync', () => runSourceResync({ client: supabase, sync }))
    if (outcome.ok) {
      const summary = outcome.summary
      if (summary.due) console.log(`[resync] ${JSON.stringify(summary)}`)
      return res.json(summary)
    }
    if (outcome.transient) {
      warnCronTransient('POST /api/internal/sources/resync', outcome.error)
      return res.status(503).json({ ok: false, error: 'Resync run skipped: upstream unavailable, the next tick will retry.' })
    }
    console.error('POST /api/internal/sources/resync:', outcome.error?.message || outcome.error)
    res.status(500).json({ ok: false, error: 'Resync run failed.' })
  } finally {
    sourceResyncInFlight = false
  }
})

// ============================================================
// Dining favorites (issue #49) - per-user starred menu items, in
// src/routes/dining.mjs (issue #191) with the public /api/dining snapshot,
// which is mounted in the public reads block above.
// ============================================================
app.use(createDiningRouter({ supabase, requireAuth, userWriteRateLimit }))

// ============================================================
// Board API
// ============================================================

const BOARD_SQL_FILE = DB_FEATURES.board.sqlFile

// 503 board_schema_missing until the board tables exist, 500 otherwise. Each
// feature's responder below is the same wrapper over src/dbErrors.mjs (#218).
function respondBoardDbError(res, err) {
  return respondSoftDeleteFeatureDbError(res, err, DB_FEATURES.board)
}

// Display names for the non-anonymous authors of a batch of posts or replies.
// Anonymous rows never reach the lookup, so an author who only ever posts
// anonymously is never read.
async function boardDisplayNames(...rowSets) {
  const userIds = new Set()
  for (const rows of rowSets) {
    for (const row of rows) { if (!row.is_anon) userIds.add(row.user_id) }
  }
  const nameMap = {}
  if (userIds.size === 0) return nameMap
  const { data } = await supabase.from('users').select('id, display_name').in('id', [...userIds])
  for (const u of data || []) nameMap[u.id] = u.display_name
  return nameMap
}

app.get('/api/board/posts', requireAuth, async (req, res) => {
  const sort = req.query.sort === 'popular' ? 'popular' : 'recent'
  const page = Math.max(0, parseInt(req.query.page, 10) || 0)

  // Users on either side of a block with the caller are left out in the
  // queries, so paging stays exact (issue #192). Anonymous posts keep their
  // user_id, so the filter covers them too.
  let blocked
  try {
    blocked = await loadBlockedIds(supabase, req.currentUser.id)
  } catch (err) {
    return respondBoardDbError(res, err)
  }

  // select('*') keeps the board working whether or not the optional
  // edited_at migration (db/supabase-board-only.sql) has been applied yet
  let query = supabase
    .from('board_posts')
    .select('*')
    .is('deleted_at', null)
  query = excludeBlocked(query, 'user_id', blocked)
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
  const { data: postsData, error: postsError } = await query
    .range(page * BOARD_PAGE_SIZE, page * BOARD_PAGE_SIZE + BOARD_PAGE_SIZE - 1)
  if (postsError) return respondBoardDbError(res, postsError)

  const postIds = postsData.map(p => p.id)
  let repliesData = []
  if (postIds.length > 0) {
    // Newest first with a hard cap (issue #200): only the newest INLINE_REPLIES
    // per post are previewed, and the rest of a thread comes from
    // GET /api/board/posts/:id/replies.
    const replyQuery = supabase
      .from('board_replies')
      .select('id, post_id, body, is_anon, created_at, user_id')
      .in('post_id', postIds)
    const { data: rd } = await excludeBlocked(replyQuery, 'user_id', blocked)
      .order('created_at', { ascending: false })
      .limit(INLINE_REPLY_FETCH_LIMIT)
    repliesData = rd || []
  }
  const { byPost: inlineReplies, truncatedPostIds } = groupRepliesByPost(repliesData, { perPost: INLINE_REPLIES })
  const truncated = new Set(truncatedPostIds)
  // The reply budget is global. When it binds, a post that came back with fewer
  // than INLINE_REPLIES may have been starved by a busier thread rather than be
  // short, so it keeps its marker and loads the thread from the replies route.
  const replyFetchCapped = repliesData.length >= INLINE_REPLY_FETCH_LIMIT
  const previewedReplies = Object.values(inlineReplies).flat()

  const nameMap = await boardDisplayNames(postsData, previewedReplies)

  let upvotedIds = new Set()
  if (postIds.length > 0) {
    const { data: uv } = await supabase
      .from('board_upvotes')
      .select('post_id')
      .eq('user_id', req.currentUser.id)
      .in('post_id', postIds)
    if (uv) uv.forEach(r => upvotedIds.add(r.post_id))
  }

  const myId = req.currentUser.id
  const posts = postsData.map(p => {
    const replies = (inlineReplies[p.id] || []).map(r => mapBoardReply(r, nameMap, myId))
    // reply_count is maintained by sync_board_post_reply_count; fall back to what
    // is on screen so a post still counts its replies on an unmigrated database.
    const replyCount = Number.isFinite(p.reply_count) ? p.reply_count : replies.length
    return {
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
      replies,
      replyCount,
      hasMoreReplies: truncated.has(p.id)
        || replyCount > replies.length
        || (replyFetchCapped && replies.length < INLINE_REPLIES),
    }
  })

  res.json({ posts, page, hasMore: postsData.length === BOARD_PAGE_SIZE })
})

// The rest of a thread the list route only previewed (issue #200). A read, so no
// write limiter; requireIdParam answers 404 for a non-uuid before the handler.
app.get('/api/board/posts/:id/replies', requireIdParam('id'), requireAuth, async (req, res) => {
  const postId = req.params.id
  const page = Math.max(0, parseInt(req.query.page, 10) || 0)

  const { data: post, error: postError } = await supabase
    .from('board_posts')
    .select('id')
    .eq('id', postId)
    .is('deleted_at', null)
    .maybeSingle()
  if (postError) return respondBoardDbError(res, postError)
  if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })

  // Replies by users on either side of a block are left out (issue #192).
  let blocked
  try {
    blocked = await loadBlockedIds(supabase, req.currentUser.id)
  } catch (err) {
    return respondBoardDbError(res, err)
  }
  const replyQuery = supabase
    .from('board_replies')
    .select('id, post_id, body, is_anon, created_at, user_id')
    .eq('post_id', postId)
  const { data, error } = await excludeBlocked(replyQuery, 'user_id', blocked)
    .order('created_at', { ascending: true })
    .range(page * REPLY_PAGE_SIZE, page * REPLY_PAGE_SIZE + REPLY_PAGE_SIZE - 1)
  if (error) return respondBoardDbError(res, error)

  const rows = data || []
  const nameMap = await boardDisplayNames(rows)
  res.json({
    replies: rows.map(r => mapBoardReply(r, nameMap, req.currentUser.id)),
    page,
    hasMore: rows.length === REPLY_PAGE_SIZE,
  })
})

const BOARD_TAG_CANDIDATES = [
  'dining', 'parking', 'tutoring', 'housing', 'transit', 'library',
  'career', 'health', 'clubs', 'sports', 'tech', 'financial-aid',
  'study-spots', 'events', 'classes', 'safety',
]

app.post('/api/board/ai-suggestions', requireAuth, boardAiRateLimit, async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({
      error: { message: 'AI suggestions are not configured.', status: 503 },
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
      : `Campus board thread title: ${postTitle}\nOriginal post:\n${postBody || '(no body)'}\n\nStudent's reply draft:\n${draft}\n\nReturn ONLY JSON: {"replyTip":string|null} - one concise coaching sentence (tone, specificity, or missing info), or null if the draft is fine.`

  try {
    const raw = (await ai.reply({
      messages: [{ role: 'user', content: userText }],
      maxOutputTokens: 350,
      temperature: 0.35,
    })) ?? '{}'
    // Models still wrap JSON in prose or fences now and then, so pull out the
    // object rather than parsing the whole reply.
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
    if (e instanceof GroqUpstreamError) {
      console.error('Board AI suggestions:', e.body)
      return res.status(502).json({ error: { message: 'AI service error', status: 502 } })
    }
    console.error('Board AI suggestions:', e?.message || e)
    return res.status(500).json({ error: { message: 'Suggestion request failed', status: 500 } })
  }
})

async function autoTagBoardPost(postId, title, body, userId) {
  if (!GROQ_API_KEY) return []
  // Fire-and-forget calls used to skip the quota entirely, so a posting loop
  // could run up the inference bill unmetered. Tagging is a nicety; dropping it
  // over the limit costs the student nothing.
  if (userId && !boardTagWindow.hit(userId).allowed) return []
  const combined = `${title}\n${body}`.slice(0, 400)
  try {
    // 200 rather than 60 completion tokens: the tag array is tiny, but gpt-oss
    // spends reasoning tokens against the same ceiling and a truncated reply
    // parses as no tags at all.
    const raw = (await ai.reply({
      system: `You are a campus board post auto-tagger. Given a student's post, pick 1-3 of the most relevant tags from this list: ${BOARD_TAG_CANDIDATES.join(', ')}. Return ONLY a JSON array of strings, e.g. ["dining","parking"]. If nothing fits, return [].`,
      messages: [{ role: 'user', content: combined }],
      maxOutputTokens: 200,
      temperature: 0.1,
    })) ?? '[]'
    const match = raw.match(/\[.*\]/s)
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

  const limits = validateBoardPost({ title, body })
  if (!limits.ok) return badRequest(res, limits.message)

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

  if (error) return respondBoardDbError(res, error)

  // Fire-and-forget: AI assigns tags in the background
  const tagsPromise = autoTagBoardPost(data.id, title, body, req.session?.userId)

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

app.post('/api/board/posts/:id/reply', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
  const postId = req.params.id
  const body   = String(req.body.body || '').trim()
  const isAnon = req.body.anon === true || req.body.anon === 'true'

  const limits = validateBoardReply({ body })
  if (!limits.ok) return badRequest(res, limits.message)
  if (boardTextFailsPolicy(body)) {
    return res.status(400).json({ error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
  }

  const { data: post, error: postError } = await supabase
    .from('board_posts')
    .select('id')
    .eq('id', postId)
    .is('deleted_at', null)
    .maybeSingle()
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

  // Recompute reply_count from the reply rows atomically (was read-modify-write,
  // which lost updates under concurrent replies). Best-effort: the reply is
  // already saved, and the next reply - or the backfill - self-heals a miss.
  const { error: countError } = await communityCounters.syncBoardPostReplies(postId)
  if (countError) console.error('board reply_count sync failed:', countError?.message || countError)

  res.status(201).json({
    reply: {
      id: reply.id,
      body: reply.body,
      user: reply.is_anon ? 'Anonymous' : req.currentUser.display_name,
      anon: reply.is_anon,
      isMine: true,
      time: reply.created_at,
    }
  })
})

app.post('/api/board/posts/:id/upvote', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id
  try {
    const { data: post, error: postError } = await supabase
      .from('board_posts')
      .select('id')
      .eq('id', postId)
      .is('deleted_at', null)
      .maybeSingle()
    if (postError) throw postError
    if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })
    res.json(
      await toggleUpvote({
        supabase,
        table: 'board_upvotes',
        refColumn: 'post_id',
        refId: postId,
        userId,
        now: nowIso(),
        syncCount: () => communityCounters.syncBoardPostUpvotes(postId),
      }),
    )
  } catch (error) {
    return respondBoardDbError(res, error)
  }
})

// Owner-only edit of a post's title/body (issue #7)
app.patch('/api/board/posts/:id', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id
  const title = String(req.body.title ?? '').trim()
  const body = String(req.body.body ?? '').trim()

  const limits = validateBoardPost({ title, body })
  if (!limits.ok) return badRequest(res, limits.message)

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
    // A taken-down post is not editable; DELETE and reply already scope this way,
    // and without it the admin restore view showed content edited after removal (#196).
    .is('deleted_at', null)
    .select('*')

  // Retry without edited_at when the optional column migration hasn't run yet
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    ;({ data, error } = await supabase
      .from('board_posts')
      .update({ title, body, updated_at: editedAt })
      .eq('id', postId)
      .eq('user_id', userId)
      .is('deleted_at', null)
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

app.delete('/api/board/posts/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id
  // Soft delete: hide the post (set deleted_at). Its replies stay attached and
  // reappear if an admin restores it; a hard delete (admin) cascades them.
  // Owner or admin: admins take down live posts from reports (issue #195).
  const query = supabase
    .from('board_posts')
    .update({ deleted_at: nowIso() })
    .eq('id', postId)
    .is('deleted_at', null)
  const { data, error } = await ownerOrAdminScope(query, { userId, isAdmin: isUserAdmin(req.currentUser) }).select('id')
  if (error) return respondBoardDbError(res, error)
  if (!data?.length) {
    return res.status(404).json({
      error: { message: 'Post not found or you can only delete your own posts.', status: 404 },
    })
  }
  res.status(204).end()
})

// ============================================================
// Neighborhood Guide (issue #31) - student recommendations, in
// src/routes/guide.mjs (issue #191).
// ============================================================
app.use(createGuideRouter({ supabase, requireAuth, requireAdmin, isUserAdmin, communityCounters, boardWriteRateLimit, userWriteRateLimit }))

// ============================================================
// Study Group Finder (issue #33) - per-course groups, in
// src/routes/studyGroups.mjs (issue #191).
// ============================================================
app.use(createStudyGroupsRouter({ supabase, requireAuth, isUserAdmin, getClassItemsForUser, boardWriteRateLimit, userWriteRateLimit }))

// ============================================================
// Campus Perks (issue #24) - admin-curated local deals, in
// src/routes/deals.mjs (issue #191).
// ============================================================
app.use(createDealsRouter({ supabase, requireAuth, requireAdmin, isUserAdmin, userWriteRateLimit }))

// ============================================================
// Student Marketplace (issue #32, Phase 1) - listings and reports, in
// src/routes/marketplace.mjs (issue #191). The photo helper is built here so
// the router never sees the session secret.
// ============================================================
const marketplacePhotos = createMarketplacePhotos({ supabase, secret: sessionSecret })
app.use(createMarketplaceRouter({ supabase, requireAuth, isUserAdmin, marketplacePhotos, marketplacePhotoRateLimit, marketplaceReadRateLimit, boardWriteRateLimit, userWriteRateLimit }))

// ============================================================
// Friend Matching (issue #17) - students who share courses, in
// src/routes/friends.mjs (issue #191).
// ============================================================
app.use(createFriendsRouter({ supabase, requireAuth, getClassItemsForUser, boardWriteRateLimit, userWriteRateLimit }))

// ============================================================
// Advertiser portal (separate from student auth - see
// db/supabase-advertiser-portal.sql and docs/advertiser-portal.md).
//
// Isolation is the whole point: advertisers authenticate against the
// `advertisers` table and are tracked by req.session.advertiserId - NEVER
// req.session.userId. Sign-in regenerates the session, so a browser is either a
// student session or an advertiser session, never both. requireAdvertiserAuth
// gates advertiser routes; requireAuth (student) ignores advertiserId entirely.
// ============================================================

const [ADVERTISER_SQL_FILE, ADVERTISER_CAMPAIGNS_SQL_FILE] = DB_FEATURES.advertiser.sqlFile
const ADVERTISER_RESETS_SQL_FILE = 'db/supabase-advertiser-password-resets.sql'
const ADVERTISER_AD_EVENTS_SQL_FILE = 'db/supabase-advertiser-ad-events.sql'

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
    res.clearCookie(SESSION_COOKIE_NAME)
    res.json({ ok: true })
  })
})

// Session probe for the advertiser portal. Like /api/session, this answers 200
// whether or not an advertiser is signed in - a signed-out visit to /advertise
// used to log a 401 in the browser console on every load (#157).
// Signed out (or suspended): { authenticated: false, advertiser: null }.
// Signed in: { authenticated: true, session: { expiresAt, advertiser } }.
app.get('/api/advertiser/me', async (req, res) => {
  const advertiser = await getAdvertiserById(req.session.advertiserId)
  if (!advertiser || advertiser.status !== 'active') {
    return res.json({ authenticated: false, advertiser: null })
  }
  res.json({ authenticated: true, session: buildAdvertiserSessionPayload(advertiser, req) })
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

app.post('/api/advertiser/campaigns', advertiserWriteRateLimit, requireAdvertiserAuth, async (req, res) => {
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

app.patch('/api/advertiser/campaigns/:id', advertiserWriteRateLimit, requireIdParam('id'), requireAdvertiserAuth, async (req, res) => {
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
app.get('/api/advertiser/campaigns/:id/stats', requireIdParam('id'), requireAdvertiserAuth, async (req, res) => {
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
// impression/tap events (no student PII - see db/supabase-advertiser-ad-events.sql).
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

app.post('/api/spotlight/:campaignId/event', adEventRateLimit, requireIdParam('campaignId'), requireAuth, async (req, res) => {
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

app.patch('/api/admin/leads/:id', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
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

app.patch('/api/admin/campaigns/:id', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
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
    console.error('[admin/purdue-links/clear] lookup failed:', lookupError.message)
    return res.status(500).json({ error: { message: 'Could not look up the user.', status: 500 } })
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

// ── Content reports queue (admin, issue #192) ───────────────────────────────
// GET /api/admin/reports and PATCH /api/admin/reports/:id live in
// src/routes/adminReports.mjs; taking reported content down stays with each
// type's own DELETE route and the hidden-listing takedown below.
app.use(createAdminReportsRouter({ supabase, requireAuth, requireAdmin, adminWriteRateLimit }))

// ── Soft-delete moderation (admin) ───────────────────────────────────────────
// User/owner delete endpoints only soft-delete (set deleted_at). Admins review
// hidden content here and either restore it or permanently (hard) delete it -
// this is the only hard-delete path. `type` is whitelisted so the param can
// never reach an arbitrary table.
// Study groups joined in issue #195; their public DELETE is creator-or-admin.
const SOFT_DELETE_TABLES = {
  board: { table: 'board_posts', label: 'Board post', sqlFile: SOFT_DELETE_SQL_FILE },
  marketplace: { table: 'marketplace_listings', label: 'Marketplace listing', sqlFile: SOFT_DELETE_SQL_FILE },
  'lost-found': { table: 'lost_found_items', label: 'Lost & Found item', sqlFile: SOFT_DELETE_SQL_FILE },
  guide: { table: 'guide_recommendations', label: 'Guide recommendation', sqlFile: SOFT_DELETE_SQL_FILE },
  deals: { table: 'deals', label: 'Deal', sqlFile: SOFT_DELETE_SQL_FILE },
  'study-groups': { table: 'study_groups', label: 'Study group', sqlFile: STUDY_SOFT_DELETE_SQL_FILE },
}

function softDeleteConfig(type) {
  return Object.prototype.hasOwnProperty.call(SOFT_DELETE_TABLES, type) ? SOFT_DELETE_TABLES[type] : null
}

// A table without deleted_at yet (study groups before their migration) fails
// every moderation query on the missing column: answer 503
// moderation_schema_missing (the log names the file to run) instead of a 500.
function respondModerationDbError(res, error, cfg, logLabel, message) {
  if (isMissingColumnError(error, 'deleted_at')) {
    return respondSchemaMissing(
      res,
      { ...DB_FEATURES.moderation, label: `${cfg.label} moderation`, sqlFile: cfg.sqlFile },
      error,
    )
  }
  // logLabel carries req.params.type, so it must not sit in console.error's
  // format-string slot: a `%s` in the value would consume error.message
  // (CodeQL js/tainted-format-string). A literal format keeps the same output.
  console.error('%s:', logLabel, error.message)
  return res.status(500).json({ error: { message, status: 500 } })
}

app.get('/api/admin/deleted/:type', requireAuth, requireAdmin, async (req, res) => {
  const cfg = softDeleteConfig(req.params.type)
  if (!cfg) return res.status(404).json({ error: { message: 'Unknown content type.', status: 404 } })
  const { data, error } = await supabase
    .from(cfg.table)
    .select('*')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
    .limit(200)
  if (error) {
    return respondModerationDbError(res, error, cfg, `GET /api/admin/deleted/${req.params.type}`, 'Could not load deleted items.')
  }
  res.json({ items: data || [], label: cfg.label })
})

// Live-content lookup for the takedown panel (issue #195): an admin pastes an
// id from a report and previews the row here, then removes it through the
// type's own DELETE route, which lets admins past the owner filter. The row
// then shows up in the deleted list above, where it can be restored.
app.get('/api/admin/content/:type/:id', requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
  const cfg = softDeleteConfig(req.params.type)
  if (!cfg) return res.status(404).json({ error: { message: 'Unknown content type.', status: 404 } })
  if (!isUuid(req.params.id)) return res.status(404).json({ error: { message: 'Item not found.', status: 404 } })
  const { data, error } = await supabase
    .from(cfg.table)
    .select('*')
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) {
    return respondModerationDbError(res, error, cfg, `GET /api/admin/content/${req.params.type}`, 'Could not load the item.')
  }
  if (!data) return res.status(404).json({ error: { message: 'Item not found.', status: 404 } })
  res.json({ item: data, label: cfg.label })
})

app.post('/api/admin/deleted/:type/:id/restore', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
  const cfg = softDeleteConfig(req.params.type)
  if (!cfg) return res.status(404).json({ error: { message: 'Unknown content type.', status: 404 } })
  const { data, error } = await supabase
    .from(cfg.table)
    .update({ deleted_at: null })
    .eq('id', req.params.id)
    .not('deleted_at', 'is', null)
    .select('id')
  if (error) {
    return respondModerationDbError(res, error, cfg, `restore ${req.params.type}`, 'Could not restore the item.')
  }
  if (!data?.length) return res.status(404).json({ error: { message: 'Item not found.', status: 404 } })
  res.json({ ok: true })
})

app.delete('/api/admin/deleted/:type/:id', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
  const cfg = softDeleteConfig(req.params.type)
  if (!cfg) return res.status(404).json({ error: { message: 'Unknown content type.', status: 404 } })
  // Hard delete - permanent. Only already-soft-deleted rows can be purged, so a
  // mistyped call can never wipe live content. (Board posts cascade to replies.)
  const { data, error } = await supabase
    .from(cfg.table)
    .delete()
    .eq('id', req.params.id)
    .not('deleted_at', 'is', null)
    .select('id')
  if (error) {
    return respondModerationDbError(res, error, cfg, `hard delete ${req.params.type}`, 'Could not permanently delete the item.')
  }
  if (!data?.length) return res.status(404).json({ error: { message: 'Item not found.', status: 404 } })
  res.status(204).end()
})

// Hidden-listing moderation (admin, issue #204). REPORTS_TO_HIDE distinct
// reports hide a marketplace listing on their own, and nothing could clear the
// flag again: the owner never saw it and no admin route touched `hidden`, so
// three accounts could bury any listing permanently. Admins work the queue
// here. Marketplace is the only surface with an auto-hide, so these routes name
// it rather than taking a :type; #192 generalises reports later.
app.get('/api/admin/hidden/marketplace', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('marketplace_listings')
      .select('*')
      .eq('hidden', true)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    const listings = data || []
    const reports = await countMarketplaceReports(supabase, listings.map((r) => r.id))
    res.json({
      items: listings.map((row) => ({
        ...row,
        reportCount: reports.get(row.id)?.count || 0,
        reasons: reports.get(row.id)?.reasons || [],
      })),
      label: 'Marketplace listing',
    })
  } catch (e) {
    return respondMarketplaceDbError(res, e)
  }
})

app.post('/api/admin/hidden/marketplace/:id/unhide', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('marketplace_listings')
      .update({ hidden: false })
      .eq('id', req.params.id)
      .eq('hidden', true)
      .select('id')
    if (error) throw error
    if (!data?.length) return res.status(404).json({ error: { message: 'Listing not found.', status: 404 } })
    // The reports go with it. Left in place the listing sits on the threshold
    // and the next single report hides it again, which undoes the decision
    // without any new account having to agree with the first three.
    const { error: clearErr } = await supabase.from('marketplace_reports').delete().eq('listing_id', req.params.id)
    if (clearErr) throw clearErr
    res.json({ ok: true })
  } catch (e) {
    return respondMarketplaceDbError(res, e)
  }
})

// Soft delete, so the listing lands in the deleted list above and an admin can
// still restore it. Any live listing is fair game, not just a hidden one: the
// button is in the hidden queue, but refusing a listing another admin un-hid a
// second earlier would be a worse answer than doing the obvious thing.
app.post('/api/admin/hidden/marketplace/:id/takedown', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('marketplace_listings')
      .update({ deleted_at: nowIso() })
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .select('id')
    if (error) throw error
    if (!data?.length) return res.status(404).json({ error: { message: 'Listing not found.', status: 404 } })
    res.json({ ok: true })
  } catch (e) {
    return respondMarketplaceDbError(res, e)
  }
})

// Sentry smoke test (issue #50). Proves the backend error path end to end
// without editing code: passing the error to next() runs it through
// Sentry.setupExpressErrorHandler and the final safety net below, exactly the
// route a real escaped exception takes, and the client gets the generic 500.
// Admin-only, and only with ?confirm=1 so an idle browser tab cannot raise it.
// With no SENTRY_DSN it just demonstrates the 500 shape. See docs/error-tracking.md.
app.get('/api/admin/sentry-test', requireAuth, requireAdmin, (req, res, next) => {
  if (req.query.confirm !== '1') {
    return res.status(400).json({ error: { message: 'Add ?confirm=1 to raise a test error.', status: 400 } })
  }
  next(new Error(`Sentry smoke test raised via GET /api/admin/sentry-test at ${new Date().toISOString()}`))
})

// ── First-party product analytics (issue #51) ───────────────────────────────
// Signed-in students only; events live in our own Supabase (analytics_events,
// service-role only - see db/supabase-analytics.sql). The server re-checks the
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

// Unknown /api/* paths: JSON 404 in the standard error shape instead of
// Express's HTML "Cannot GET" page (#157). Mounted after every API route (so it
// only runs when nothing matched) and before the error handlers. Non-/api
// routes (/, /auth/purdue/*, /feeds/calendar/*) are untouched.
// Express 5 forwards a rejected promise from an async handler to the error
// middleware itself, so the hand-rolled wrapper that did this under Express 4
// (src/asyncRoutes.mjs, issue #197) is gone (issue #291).

app.use('/api', apiNotFound)

// Capture anything that escapes a route handler. Registered after all routes
// (Express error-middleware ordering); no-op without a DSN.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app)
}

// Final safety net: anything that escapes a route handler (e.g. a malformed JSON
// body throwing in express.json()) returns a generic message - never a stack
// trace - regardless of NODE_ENV, and is logged without filing a second Sentry
// event (src/finalErrorHandler.mjs). Must be the last middleware registered.
app.use(createFinalErrorHandler())

// The callback takes the bind error in Express 5. Without it a port already in
// use, or a host the container cannot bind, still printed the success banner in
// the Render log and left the process alive but unreachable (issue #291).
app.listen(port, host, async (err) => {
  if (err) {
    console.error(`[boot] cannot listen on ${host}:${port}:`, err?.message || err)
    process.exit(1)
  }
  console.log(`BoilerIndy backend listening on ${publicBaseUrl}`)
  console.log(`Purdue link mode: ${purdueAuthMode}`)
  console.log(`Database: Supabase`)
  const probe = await supabase.from('board_posts').select('id').limit(1)
  if (probe.error && isSchemaMissingError(probe.error)) {
    console.warn(
      `\n[BoilerIndy] Campus board: table board_posts not found. Run ${BOARD_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
  const advProbe = await supabase.from('advertisers').select('id').limit(1)
  if (advProbe.error && isSchemaMissingError(advProbe.error)) {
    console.warn(
      `\n[BoilerIndy] Advertiser portal: table advertisers not found. Run ${ADVERTISER_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
  const campaignProbe = await supabase.from('campaigns').select('id').limit(1)
  if (campaignProbe.error && isSchemaMissingError(campaignProbe.error)) {
    console.warn(
      `\n[BoilerIndy] Advertiser portal: table campaigns not found. Run ${ADVERTISER_CAMPAIGNS_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
  const adEventProbe = await supabase.from('ad_events').select('id').limit(1)
  if (adEventProbe.error && isSchemaMissingError(adEventProbe.error)) {
    console.warn(
      `\n[BoilerIndy] Advertiser portal: table ad_events not found. Run ${ADVERTISER_AD_EVENTS_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
  const analyticsProbe = await supabase.from('analytics_events').select('id').limit(1)
  if (analyticsProbe.error && isSchemaMissingError(analyticsProbe.error)) {
    console.warn(
      '\n[BoilerIndy] Analytics: table analytics_events not found. Run db/supabase-analytics.sql in Supabase SQL Editor, then restart the server.\n',
    )
  }
  // Club directory (#16): fill the cache now so the first /clubs visit after a
  // deploy does not wait on BoilerLink's paged fetch. The keep-warm pinger
  // keeps the process (and so this cache) alive between visits.
  setTimeout(() => void clubDirectoryCache.refresh(), 5_000).unref()
})
