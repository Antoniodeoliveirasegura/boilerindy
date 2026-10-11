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
import { createClient } from '@supabase/supabase-js'
import { createClubDirectoryCache } from './src/boilerlinkClubs.mjs'
import { loadVapidKeys } from './src/webPush.mjs'
import { describeFailure } from './src/cronTick.mjs'
import { getDiningSnapshot, todayYmdInZone } from './src/nutrisliceDining.mjs'
import { createGroqClient } from './src/groqClient.mjs'
import { createRateLimiter, createRateWindow } from './src/rateLimiter.mjs'
import { SESSION_COOKIE_NAME, publicReadBucketKey } from './src/publicReadKey.mjs'
import { advertiserWriteBucketKey } from './src/userWriteCaps.mjs'
import { sessionSyncBucketKey } from './src/sessionSyncKey.mjs'
import { UpstreamError, createStaleCache, fetchUpstream } from './src/upstreamFetch.mjs'
import { createSessionStore } from './src/sessionStore.mjs'
import { createOnboardingSummaryCache } from './src/onboardingSummaryCache.mjs'
import { createCommunityCounters } from './src/communityCounters.mjs'
import { createCalendarReads } from './src/calendarReads.mjs'
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
import { createBoardRouter } from './src/routes/board.mjs'
import { createAssistantRouter } from './src/routes/assistant.mjs'
import { createAnalyticsRouter } from './src/routes/analytics.mjs'
import { createCalendarFeedRouter } from './src/routes/calendarFeed.mjs'
import { createMeRouter } from './src/routes/me.mjs'
import { createSourcesRouter } from './src/routes/sources.mjs'
import { createReportsRouter } from './src/routes/reports.mjs'
import { createAdminReportsRouter } from './src/routes/adminReports.mjs'
import { createBlocksRouter } from './src/routes/blocks.mjs'
import { createPurdueEmailRouter } from './src/routes/purdueEmail.mjs'
import { createAdminRouter } from './src/routes/admin.mjs'
import { createAdvertiserRouter, createSpotlightRouter } from './src/routes/advertiser.mjs'
import { createAuthRouter } from './src/routes/auth.mjs'
import { createPurdueIdentity } from './src/purdueIdentity.mjs'
import { DB_FEATURES, isSchemaMissingError } from './src/dbErrors.mjs'
import { createMarketplacePhotos } from './src/marketplacePhotos.mjs'
import { createPurdueLinkHandoff } from './src/purdueLinkHandoff.mjs'
import { createPurdueLinkFlowRateLimit } from './src/purdueLinkThrottle.mjs'
import { normalizeEmail } from './src/userFields.mjs'
import { isSessionStale } from './src/sessionFreshness.mjs'
import { isEmailConfigured, sendAdvertiserPasswordResetEmail, sendEmail } from './src/email.mjs'
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
// Two-step sign-in (src/twoFactor.mjs): an email + password sign-in or sign-up
// waits on a code mailed to the account. Google sign-in skips it. Off unless
// set to on: it needs README step 41 and a Resend domain that delivers to
// students, and only on, 1 or true count, so a typo leaves a switch off.
const envSwitch = (name) => ['on', '1', 'true'].includes(String(process.env[name] || '').trim().toLowerCase())
const loginTwoFactorEnabled = envSwitch('LOGIN_TWO_FACTOR')
// Off until the native app has a code screen: it signs in with a password
// through supabase-sync, which the gate refuses. Without it, a password-only
// Supabase token still skips the code, so turn it on as soon as the app ships.
const loginTwoFactorSyncGate = envSwitch('LOGIN_TWO_FACTOR_SYNC_GATE')
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
  if (loginTwoFactorEnabled && !isEmailConfigured()) {
    console.error('WARNING: LOGIN_TWO_FACTOR is on but RESEND_API_KEY / RESEND_FROM are not set: email + password sign-in answers 503 and email sign-up is refused until they are (or LOGIN_TWO_FACTOR is unset).')
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
// Invalidated wherever those counts change; see getUserSummary in
// src/routes/auth.mjs and the choke points listed in src/onboardingSummaryCache.mjs.
const onboardingSummaryCache = createOnboardingSummaryCache()

// The bearer token the Supabase pg_cron jobs send to the two cron routes, the
// push reminder runner (src/routes/push.mjs) and the source re-sync
// (src/routes/sources.mjs). Blank leaves both to the JSON 404. Read here,
// above every mount, because both routers are handed it where they mount.
const PUSH_CRON_SECRET = String(process.env.PUSH_CRON_SECRET || '').trim()

function pushCronSecretMatches(header) {
  if (!PUSH_CRON_SECRET) return false
  const token = String(header || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return false
  const given = crypto.createHash('sha256').update(token).digest()
  const expected = crypto.createHash('sha256').update(PUSH_CRON_SECRET).digest()
  return crypto.timingSafeEqual(given, expected)
}

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
// Two-step sign-in codes. Each code allows five guesses (src/twoFactor.mjs);
// these cap guessing across restarted sign-ins and mail sent by resends.
const loginCodeRateLimit = createRateLimiter({
  name: 'login-code',
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyBy: 'ip',
  message: 'Too many verification attempts. Please wait a few minutes and try again.',
})
// The same guesses per account, keyed by the pending sign-in's user, so
// spreading them over many addresses or restarted sign-ins buys nothing. Only a
// correct password creates that key; without one the bucket falls back to IP.
const loginCodeAccountRateLimit = createRateLimiter({
  name: 'login-code-account',
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: (req) => req.session?.pendingLogin?.subject || null,
  message: 'Too many verification attempts for this account. Please try again later.',
})
const loginCodeSendRateLimit = createRateLimiter({
  name: 'login-code-send',
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: 'ip',
  message: 'Too many sign-in codes requested. Please try again later.',
})
// Code emails per account, from sign-in, sign-up and resend together: a
// window rather than a middleware, because the account is known only once the
// password checks out. It also keeps one account from spending the day's
// Resend quota.
const signInCodeMailWindow = createRateWindow({ name: 'login-code-mail', windowMs: 60 * 60 * 1000, max: 10 })
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

async function getCurrentUser(req) {
  const user = await getUserById(req.session.userId)
  if (!user) return null
  // Reject a session established before the account's last password change (#132),
  // so changing the password from Settings evicts other (e.g. stolen) sessions.
  if (isSessionStale(user.password_changed_at, req.session.authAt)) return null
  return user
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

// The per-user calendar reads the me, assistant, study groups and friends
// routers share (src/calendarReads.mjs, issue #191), built once.
const { listCalendarItems, getClassItemsForUser, readScheduleOverrides } = createCalendarReads(supabase)

// Linking a Purdue identity onto a student, and clearing one: the auth and
// purdueEmail routers and the admin link release share one instance
// (src/purdueIdentity.mjs, issue #191), built above all three mounts.
const { linkPurdueIdentity, clearPurdueLinkOnUser } = createPurdueIdentity({ supabase, getUserById })

// board_posts.reply_count / upvote_count and guide_recommendations.upvote_count
// are denormalized counters recomputed atomically from their source rows here,
// instead of the read-modify-write that lost updates under concurrent votes.
const communityCounters = createCommunityCounters(supabase)

// verifySupabasePassword reads the Supabase URL and keys, so it stays here
// with the other secret-built capabilities and is handed to the auth router.
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

// ── Student auth, the profile and the Purdue link ──
// Sign-up, sign-in, sign-out, the session reads and sync, the profile, account
// deletion and the Purdue link (CAS, mock, native handoff) are in
// src/routes/auth.mjs (issue #191); the session core and
// verifySupabasePassword stay here and are handed in.
app.use(createAuthRouter({ supabase, requireAuth, getCurrentUser, getUserById, isUserAdmin, verifySupabasePassword, linkPurdueIdentity, onboardingSummaryCache, purdueLinkHandoff, publicBaseUrl, clientAppUrl, purdueAuthMode, purdueLinkingEnabled, accountCreateRateLimit, signInRateLimit, sessionSyncIpRateLimit, sessionSyncRateLimit, purdueLinkTokenRateLimit, purdueLinkFlowRateLimit, userWriteRateLimit, loginCodeRateLimit, loginCodeAccountRateLimit, loginCodeSendRateLimit, signInCodeMailWindow, loginTwoFactorEnabled, loginTwoFactorSyncGate, twoFactorSecret: sessionSecret || 'dev-session-secret', sendEmail, isEmailConfigured, isProduction }))

// ── Linked calendar sources (issues #12 and #120) ───────────────────────────
// Connecting, syncing and deleting Brightspace and Purdue feeds, the dev-only
// debug and Purdue auto-capture routes, and the hourly re-sync cron route
// POST /api/internal/sources/resync are in src/routes/sources.mjs (issue
// #191), with runScheduleSync and the host allowlist. warnFeedTransient and
// warnCronTransient stay with the Sentry warnings and are handed in.
app.use(createSourcesRouter({ supabase, requireAuth, isProduction, purdueLinkingEnabled, onboardingSummaryCache, warnFeedTransient, sourceSyncRateLimit, userWriteRateLimit, PUSH_CRON_SECRET, pushCronSecretMatches, warnCronTransient }))

// ── The student's calendar, classes, tasks, grades, degree and schedule edits ──
// GET /api/me/calendar, /calendar/categories, /classes and /events, the task
// and grade routes, /api/me/degree and /api/me/schedule-overrides are in
// src/routes/me.mjs (issue #191). The readers it shares with the assistant,
// study groups and friends routers come from src/calendarReads.mjs.
app.use(createMeRouter({ supabase, requireAuth, userWriteRateLimit, listCalendarItems, getClassItemsForUser, readScheduleOverrides }))

// ── Calendar feed: subscribable .ics of the user's aggregated calendar (#48) ──
// The feed link routes and GET /feeds/calendar/:file are in
// src/routes/calendarFeed.mjs (issue #191), mounted where they were, behind
// the session middleware: a calendar app sends no cookie, so the token in the
// URL is the feed's only credential.
app.use(createCalendarFeedRouter({ supabase, requireAuth, publicBaseUrl, calendarFeedRateLimit, userWriteRateLimit }))

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
  // Model calls per user per hour. The intent router used to absorb the most
  // common asks for free; now every question reaches the model, so the
  // ceiling has to be high enough for a real conversation.
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

// The chat and briefing routes, with the system prompt, the context builders
// and the offline answers, in src/routes/assistant.mjs (issue #191). The Groq
// client and the limiters above stay here because the board router shares the
// client, and warnAssistantBusy stays with the other Sentry warnings further
// down. getClassItemsForUser, listCalendarItems and readScheduleOverrides come
// from src/calendarReads.mjs, built once near the top of this file.
app.use(createAssistantRouter({ supabase, requireAuth, assistantRateLimit, ai, warnAssistantBusy, getDiningSnapshot, getClassItemsForUser, listCalendarItems, readScheduleOverrides }))

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
// reminder cron route, plus the native app's /api/me/push-token (issue #194),
// in src/routes/push.mjs (issue #191). GET
// /api/push/config is mounted in the public reads block above, which is also
// where the VAPID keys are loaded. The cron bearer token and its check are
// read near the top of this file, and warnCronTransient sits with the Sentry
// warnings below; the sources router is handed them too.
// ============================================================
app.use(createPushRouter({ supabase, requireAuth, pushWriteRateLimit, pushTestRateLimit, vapidKeys, PUSH_CRON_SECRET, pushCronSecretMatches, warnCronTransient }))

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

// ============================================================
// Dining favorites (issue #49) - per-user starred menu items, in
// src/routes/dining.mjs (issue #191) with the public /api/dining snapshot,
// which is mounted in the public reads block above.
// ============================================================
app.use(createDiningRouter({ supabase, requireAuth, userWriteRateLimit }))

// ============================================================
// Campus board - posts, replies, upvotes, edits, deletes and the AI helpers,
// in src/routes/board.mjs (issue #191). The Groq client (ai), the ai-board
// limiter and the auto-tagger's window are built in the assistant section
// above, which shares the client, and are handed in.
// ============================================================

// The startup probe after listen names this file when board_posts is missing.
const BOARD_SQL_FILE = DB_FEATURES.board.sqlFile

app.use(createBoardRouter({ supabase, requireAuth, isUserAdmin, communityCounters, ai, boardAiRateLimit, boardTagWindow, boardWriteRateLimit, userWriteRateLimit }))

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
// db/supabase-advertiser-portal.sql and docs/advertiser-portal.md), in
// src/routes/advertiser.mjs (issue #191): createAdvertiserRouter, gated by
// req.session.advertiserId and never handed requireAuth, and
// createSpotlightRouter for students. The SQL file names stay for the
// startup probe after listen.
// ============================================================
const [ADVERTISER_SQL_FILE, ADVERTISER_CAMPAIGNS_SQL_FILE] = DB_FEATURES.advertiser.sqlFile
const ADVERTISER_AD_EVENTS_SQL_FILE = 'db/supabase-advertiser-ad-events.sql'

app.use(createAdvertiserRouter({ supabase, signInRateLimit, accountCreateRateLimit, passwordResetRateLimit, advertiserWriteRateLimit, sendAdvertiserPasswordResetEmail, clientAppUrl, isProduction }))
app.use(createSpotlightRouter({ supabase, requireAuth, adEventRateLimit, getCached }))

// ============================================================
// Platform admin (student session + isAdmin / ADMIN_EMAILS), in
// src/routes/admin.mjs (issue #191): the advertiser portal overview, leads,
// campaigns and accounts, the Purdue link release, soft-delete moderation,
// the hidden-listing queue and the Sentry smoke test. normalizeEmail (from
// src/userFields.mjs) and clearPurdueLinkOnUser (the Purdue identity built
// under requireAdmin) are handed in. The report queue below is its own router.
// ============================================================
app.use(createAdminRouter({ supabase, requireAuth, requireAdmin, adminWriteRateLimit, normalizeEmail, clearPurdueLinkOnUser }))

// ── Content reports queue (admin, issue #192) ───────────────────────────────
// GET /api/admin/reports and PATCH /api/admin/reports/:id live in
// src/routes/adminReports.mjs; taking reported content down stays with each
// type's own DELETE route and the hidden-listing takedown in src/routes/admin.mjs.
app.use(createAdminReportsRouter({ supabase, requireAuth, requireAdmin, adminWriteRateLimit }))

// ── First-party product analytics (issue #51) ───────────────────────────────
// POST /api/usage/events, the signed-in usage beacon, is in
// src/routes/analytics.mjs (issue #191).
app.use(createAnalyticsRouter({ supabase, requireAuth, analyticsRateLimit }))

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
