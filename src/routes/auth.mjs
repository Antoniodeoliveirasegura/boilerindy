import crypto from 'node:crypto'
import express from 'express'
import { buildCasServiceUrl, createCasState, spendCasState } from '../casLinkState.mjs'
import { DB_FEATURES, badRequest, logRouteError, respondDbError } from '../dbErrors.mjs'
import { maskEmail, signInCodeEmail } from '../email.mjs'
import { onboardingFlags } from '../onboardingFlags.mjs'
import { verifyPassword } from '../passwordHash.mjs'
import { SESSION_COOKIE_NAME } from '../publicReadKey.mjs'
import { HandoffError } from '../purdueLinkHandoff.mjs'
import { linkHandoffToken } from '../purdueLinkThrottle.mjs'
import { isSessionStale } from '../sessionFreshness.mjs'
import { applyPasswordChange, hasLegacyHash, resolveSignIn, verifyCurrentPassword } from '../studentPasswordAuth.mjs'
import {
  CODE_TTL_MS,
  DEVICE_TRUST_TTL_MS,
  MAX_ATTEMPTS,
  PENDING_COOKIE_MS,
  RESEND_COOLDOWN_MS,
  challengeErrorMessage,
  challengeStatus,
  checkDeviceTrustToken,
  codeMatches,
  createDeviceTrustToken,
  generateCode,
  hashSignInCode,
  parseCookies,
  resendStatus,
  tokenNeedsSignInCode,
} from '../twoFactor.mjs'
import { UpstreamError, fetchUpstream, isAbortLike } from '../upstreamFetch.mjs'
import {
  deriveDisplayName,
  normalizeAvatarUrl,
  normalizeDisplayName,
  normalizeEmail,
  normalizeProfileName,
  normalizeProvider,
} from '../userFields.mjs'

// Student auth (issue #191): sign-up, sign-in, sign-out, the session read and
// the Supabase session sync, the profile and account deletion, and the Purdue
// link (the CAS and mock website flows, the native app handoff of #214 and the
// JSON mock link). Moved out of server.mjs as a feature router with the
// handlers unchanged apart from nowIso() and makeId() inlined. The profile and
// account deletion came from the me group: they share the GoTrue check, the
// legacy migration, the session payload, the cookie name and the sign-in
// limiter with sign-in, and nothing with the other /api/me routes.
//
// server.mjs keeps the session core (getUserById, getCurrentUser, isUserAdmin,
// requireAuth), verifySupabasePassword (it reads the Supabase URL and keys),
// the cookie options and purdueLinkHandoff (built with SESSION_SECRET; the flow
// limiter verifies with the same instance), and hands them in.

const defaultNextPath = '/setup'
const DEVICE_TRUST_COOKIE = 'pih.td'
const REMEMBER_ME_MS = 1000 * 60 * 60 * 24 * 30

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

/**
 * The student auth, profile and Purdue link routes, mounted by server.mjs
 * behind the session middleware where the routes used to be. Paths stay
 * absolute (`/api/auth/sign-in`, `/auth/purdue/connect`) so docs/RATE_LIMITS.md
 * and its guard test read the same whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase                 the Supabase client (tables and auth.admin)
 * @param {Function} deps.requireAuth              loads req.currentUser or answers 401
 * @param {Function} deps.getCurrentUser           the session's user, or null when signed out or stale
 * @param {Function} deps.getUserById              a users row by id, or null
 * @param {Function} deps.isUserAdmin              true for an admin (is_admin or ADMIN_EMAILS)
 * @param {Function} deps.verifySupabasePassword   (email, password) => the GoTrue user or null; throws
 *   an UpstreamError on an outage
 * @param {Function} deps.linkPurdueIdentity       (userId, { email }) => the updated users row
 *   (src/purdueIdentity.mjs)
 * @param {object}   deps.onboardingSummaryCache   server.mjs's one instance (src/onboardingSummaryCache.mjs)
 * @param {object}   deps.purdueLinkHandoff        server.mjs's one instance (src/purdueLinkHandoff.mjs)
 * @param {string}   deps.publicBaseUrl            this backend's public origin, for the CAS service URL
 * @param {string}   deps.clientAppUrl             the website origin, for the link redirects
 * @param {string}   deps.purdueAuthMode           'off', 'mock' or 'cas'
 * @param {boolean}  deps.purdueLinkingEnabled     false when PURDUE_AUTH_MODE is off
 * @param {Function} deps.accountCreateRateLimit   register (account-create)
 * @param {Function} deps.signInRateLimit          sign-in, PATCH profile and delete-account (sign-in)
 * @param {Function} deps.sessionSyncIpRateLimit   supabase-sync, per IP (session-sync-ip)
 * @param {Function} deps.sessionSyncRateLimit     supabase-sync, per account (session-sync)
 * @param {Function} deps.purdueLinkTokenRateLimit the native handoff token (purdue-link-token)
 * @param {Function} deps.purdueLinkFlowRateLimit  the three link flow routes, ahead of the user lookup
 *   (purdue-link-flow)
 * @param {Function} deps.userWriteRateLimit       the JSON mock link (user-write)
 * @param {Function} deps.loginCodeRateLimit       two-step code checks, per IP (login-code)
 * @param {Function} deps.loginCodeAccountRateLimit two-step code checks, per pending account
 *   (login-code-account), inside the IP bucket
 * @param {Function} deps.loginCodeSendRateLimit   two-step code resends, per IP (login-code-send)
 * @param {{ hit: (key: string) => { allowed: boolean, resetAt: number } }} [deps.signInCodeMailWindow]
 *   the createRateWindow (login-code-mail) hit once per code mailed to an account, from sign-in,
 *   sign-up or a resend
 * @param {boolean}  [deps.loginTwoFactorEnabled]  password sign-in and sign-up wait on an emailed code
 * @param {boolean}  [deps.loginTwoFactorSyncGate] supabase-sync refuses a password-only Supabase token
 *   unless this session already passed the code or the device is trusted. Off until every client
 *   (the native app signs in through supabase-sync) has a code screen.
 * @param {string}   [deps.twoFactorSecret]        HMAC key for codes and trusted-device cookies
 * @param {Function} [deps.sendEmail]              ({ to, subject, html }) => { sent } or { sent: false, skipped: true }
 * @param {Function} [deps.isEmailConfigured]      () => whether Resend is set up; in production a
 *   sign-up is refused before the account exists when it is not
 * @param {boolean}  [deps.isProduction]           an unsent code fails the request; cookies are Secure
 */
export function createAuthRouter({
  supabase,
  requireAuth,
  getCurrentUser,
  getUserById,
  isUserAdmin,
  verifySupabasePassword,
  linkPurdueIdentity,
  onboardingSummaryCache,
  purdueLinkHandoff,
  publicBaseUrl,
  clientAppUrl,
  purdueAuthMode,
  purdueLinkingEnabled,
  accountCreateRateLimit,
  signInRateLimit,
  sessionSyncIpRateLimit,
  sessionSyncRateLimit,
  purdueLinkTokenRateLimit,
  purdueLinkFlowRateLimit,
  userWriteRateLimit,
  loginCodeRateLimit,
  loginCodeAccountRateLimit,
  loginCodeSendRateLimit,
  signInCodeMailWindow,
  loginTwoFactorEnabled = false,
  loginTwoFactorSyncGate = false,
  twoFactorSecret,
  sendEmail,
  isEmailConfigured = () => true,
  isProduction = false,
}) {
  const router = express.Router()

  // ── Two-step sign-in ──────────────────────────────────────────────────────

  function hasDeviceTrust(req, user) {
    return checkDeviceTrustToken(twoFactorSecret, parseCookies(req.headers.cookie)[DEVICE_TRUST_COOKIE], {
      userId: user.id,
      passwordChangedAt: user.password_changed_at,
    })
  }

  function needsSignInCode(req, user) {
    return loginTwoFactorEnabled && !hasDeviceTrust(req, user)
  }

  // false when the code could not be sent and the caller must answer 503.
  async function deliverSignInCode(to, code) {
    let delivery
    try {
      delivery = await sendEmail({ to, ...signInCodeEmail({ code }) })
    } catch (error) {
      logRouteError('[login-code] send failed', error)
      return false
    }
    if (delivery?.skipped) {
      if (isProduction) {
        console.error('[login-code] RESEND_API_KEY or RESEND_FROM is not set; no code was sent')
        return false
      }
      console.log('[login-code] dev code for %s: %s', maskEmail(to), code)
    }
    return true
  }

  const UNSENT_LOGIN_CODE = {
    error: { message: 'We could not send your sign-in code right now. Please try again in a moment.', status: 503 },
  }

  // The pending sign-ins (db/supabase-sign-in-challenges.sql). The session
  // holds only { challengeId, subject, rememberMe }; the code's hash and its
  // counters live in the row, where parallel requests cannot each keep a copy.
  const CHALLENGES = 'sign_in_challenges'
  const CHALLENGE_COLUMNS = 'id, user_id, code_hash, expires_at, attempts, sends, sent_at, created_at'
  // The answers that end the pending sign-in: the client starts over from the password.
  const RESTART_REASONS = new Set(['missing', 'timed-out', 'too-many-attempts', 'password-changed'])

  function challengeError(res, result) {
    return res.status(400).json({
      error: {
        message: challengeErrorMessage(result),
        status: 400,
        code: result.reason,
        restart: RESTART_REASONS.has(result.reason),
      },
    })
  }

  function regenerate(req) {
    return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())))
  }

  function save(req) {
    return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())))
  }

  // Ends this session's pending sign-in; the row, if any, is the caller's to remove.
  async function dropPending(req) {
    delete req.session.pendingLogin
    await save(req)
  }

  async function readChallenge(pending) {
    const { data, error } = await supabase
      .from(CHALLENGES)
      .select(CHALLENGE_COLUMNS)
      .eq('id', pending.challengeId)
      .eq('user_id', pending.subject)
    if (error) throw error
    return data?.[0] ?? null
  }

  // Deleting the row spends a right code, and of two requests only one gets the
  // row back, so a code signs in one session. Also clears a finished row.
  async function removeChallenge(id) {
    const { data, error } = await supabase.from(CHALLENGES).delete().eq('id', id).select('id')
    if (error) throw error
    return Boolean(data?.length)
  }

  // Counts one guess with a compare-and-swap on `attempts` before any code is
  // compared, and answers the row as the count left it. Each guess in flight
  // needs its own count, so no more than MAX_ATTEMPTS codes are compared per code
  // mailed, however many arrive at once. A lost swap means another request
  // counted first (or a resend reset the count), so it reads again; past the
  // loop's bound it answers 'exhausted', closed rather than open.
  async function claimGuess(pending, row) {
    let current = row
    for (let i = 0; i <= MAX_ATTEMPTS; i += 1) {
      const status = challengeStatus(current)
      if (status !== 'live') return { status }
      const attempts = Number(current.attempts) || 0
      const { data, error } = await supabase
        .from(CHALLENGES)
        .update({ attempts: attempts + 1 })
        .eq('id', current.id)
        .eq('attempts', attempts)
        .select(CHALLENGE_COLUMNS)
      if (error) throw error
      if (data?.length) return { status: 'claimed', row: data[0] }
      current = await readChallenge(pending)
    }
    return { status: 'exhausted' }
  }

  // The per-account cap on code emails (login-code-mail) across sign-in,
  // sign-up and resend, which the per-IP buckets cannot see. Answers the 429
  // itself and returns true when the account is over it.
  function codeMailRefused(res, userId) {
    const result = signInCodeMailWindow?.hit(userId)
    if (!result || result.allowed) return false
    const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
    res.setHeader('Retry-After', String(retryAfterSeconds))
    res.status(429).json({
      error: { message: 'Too many sign-in codes were sent to this account. Please try again later.', status: 429, retryAfterSeconds },
    })
    return true
  }

  // Swaps in a session that holds only the pending challenge, never a userId,
  // on a short cookie. Answers the response itself: the code-pending body, a 429
  // over the account's mail cap, or 503 when the code went unsent. A sign-up has
  // already created the account, so an unsent code still answers the
  // code-pending body (codeSent: false) and the client offers a resend; a 503
  // there would strand the address on "account already exists".
  async function startSignInChallenge(req, res, user, { rememberMe, status = 200, keepOnUnsent = false }) {
    if (isProduction && !isEmailConfigured()) {
      console.error('[login-code] RESEND_API_KEY or RESEND_FROM is not set; no code was sent')
      return res.status(503).json(UNSENT_LOGIN_CODE)
    }
    if (codeMailRefused(res, user.id)) return res
    const now = Date.now()
    const id = crypto.randomUUID()
    const code = generateCode()
    const expiresAt = new Date(now + CODE_TTL_MS).toISOString()
    try {
      // One pending sign-in per account: a new one voids any earlier code.
      const { error: clearErr } = await supabase.from(CHALLENGES).delete().eq('user_id', user.id)
      if (clearErr) throw clearErr
      const { error: insertErr } = await supabase.from(CHALLENGES).insert({
        id,
        user_id: user.id,
        code_hash: hashSignInCode(twoFactorSecret, { challengeId: id, subject: user.id, code }),
        expires_at: expiresAt,
        attempts: 0,
        sends: 1,
        sent_at: new Date(now).toISOString(),
        created_at: new Date(now).toISOString(),
      })
      if (insertErr) throw insertErr
    } catch (error) {
      return respondDbError(res, error, DB_FEATURES.sign_in_codes)
    }
    const codeSent = await deliverSignInCode(user.email, code)
    if (!codeSent && !keepOnUnsent) {
      // Nothing was delivered, so nothing is pending.
      try {
        await removeChallenge(id)
      } catch (error) {
        logRouteError('[login-code] could not remove an unsent code', error)
      }
      return res.status(503).json(UNSENT_LOGIN_CODE)
    }
    await regenerate(req)
    req.session.cookie.maxAge = PENDING_COOKIE_MS
    req.session.pendingLogin = { challengeId: id, subject: user.id, rememberMe }
    await save(req)
    return res.status(status).json({
      twoFactorRequired: true,
      email: maskEmail(user.email),
      expiresAt,
      ...(codeSent ? {} : { codeSent: false }),
    })
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
        updated_at: new Date().toISOString()
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
        .update({ password_changed_at: new Date().toISOString() })
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

  // The CAS service URL must match byte for byte between the login redirect and
  // ticket validation. The website variant carries the post-link path and the
  // single-use state nonce, so the nonce is part of the service string CAS signs
  // (#293); the native variant carries only the handoff token so the callback
  // can identify the student without a session cookie (#214).
  function casServiceUrl({ nextPath, token, state }) {
    return buildCasServiceUrl(publicBaseUrl, { nextPath, token, state })
  }

  router.get('/api/auth-config', (_req, res) => {
    res.json({
      authProvider: 'local',
      purdueAuthMode,
      supportsPurdueLink: purdueLinkingEnabled,
      supportedSources: ['purdue_schedule_ical', 'brightspace_ical'],
    })
  })

  router.get('/api/session', async (req, res) => {
    const user = await getCurrentUser(req)
    const sessionPayload = await buildSessionPayload(user, req)
    res.json({ authenticated: Boolean(sessionPayload), session: sessionPayload })
  })

  router.post('/api/auth/register-supabase', accountCreateRateLimit, async (req, res) => {
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

      // With two-step on, a sign-up finishes with a mailed code. Refuse before
      // the account exists when production cannot mail one, or the address is
      // stranded: no code arrives, and signing up again says it is taken.
      if (loginTwoFactorEnabled && isProduction && !isEmailConfigured()) {
        console.error('[login-code] RESEND_API_KEY or RESEND_FROM is not set; refused a sign-up before creating the account')
        return res.status(503).json({
          error: { message: 'Email sign-up is unavailable right now. Please try again later, or continue with Google.', status: 503 },
        })
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
      const timestamp = new Date().toISOString()
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

      // The first sign-in proves the address is the student's own.
      if (loginTwoFactorEnabled) return await startSignInChallenge(req, res, row, { rememberMe, status: 201, keepOnUnsent: true })

      req.session.regenerate((err) => {
        if (err) {
          return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
        }
        req.session.cookie.maxAge = cookieMaxAge
        req.session.userId = row.id
        req.session.authAt = new Date().toISOString()
        req.session.save(async () => {
          res.status(201).json({ session: await buildSessionPayload(row, req) })
        })
      })
    } catch (error) {
      res.status(500).json({ error: { message: error.message || 'Could not create account.', status: 500 } })
    }
  })

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
      .update({ password_hash: '', updated_at: new Date().toISOString() })
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
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id)
        .select()
        .single()

      return error ? user : data
    }

    const timestamp = new Date().toISOString()
    const { data, error } = await supabase
      .from('users')
      .insert({
        id: supabaseUser?.id || crypto.randomUUID(),
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

  router.post('/api/auth/sign-in', signInRateLimit, async (req, res) => {
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

      if (needsSignInCode(req, user)) return await startSignInChallenge(req, res, user, { rememberMe })

      req.session.regenerate(async (err) => {
        if (err) {
          return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
        }
        req.session.cookie.maxAge = cookieMaxAge
        req.session.userId = user.id
        req.session.authAt = new Date().toISOString()
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

  // Why a claim found no guess to count, as the answer's reason. An expired
  // code keeps the pending sign-in (a resend replaces it); the rest end it.
  const UNCLAIMED_REASONS = { missing: 'missing', 'timed-out': 'timed-out', exhausted: 'too-many-attempts', expired: 'expired' }

  router.post('/api/auth/sign-in/verify', loginCodeRateLimit, loginCodeAccountRateLimit, async (req, res) => {
    const pending = req.session.pendingLogin
    // Nothing to check and nothing to save, so a stray request writes no session.
    if (!pending?.challengeId) return challengeError(res, { reason: 'missing' })
    try {
      const row = await readChallenge(pending)
      const claim = await claimGuess(pending, row)
      if (claim.status !== 'claimed') {
        const reason = UNCLAIMED_REASONS[claim.status]
        if (RESTART_REASONS.has(reason)) {
          if (row) await removeChallenge(row.id)
          await dropPending(req)
        }
        return challengeError(res, { reason })
      }

      const claimed = claim.row
      if (!codeMatches(twoFactorSecret, claimed, req.body.code)) {
        const remaining = MAX_ATTEMPTS - (Number(claimed.attempts) || 0)
        if (remaining > 0) return challengeError(res, { reason: 'invalid', remaining })
        await removeChallenge(claimed.id)
        await dropPending(req)
        return challengeError(res, { reason: 'too-many-attempts' })
      }

      // Of two right answers in flight, one signs in and the other starts over.
      if (!(await removeChallenge(claimed.id))) {
        await dropPending(req)
        return challengeError(res, { reason: 'missing' })
      }

      const user = await getUserById(pending.subject)
      if (!user) {
        await dropPending(req)
        return res.status(401).json({ error: { message: 'This account no longer exists.', status: 401 } })
      }
      // The password changed after the code was sent (in Settings, on another
      // device): whoever typed the old one has to start over with the new one.
      if (isSessionStale(user.password_changed_at, claimed.created_at)) {
        await dropPending(req)
        return challengeError(res, { reason: 'password-changed' })
      }

      await regenerate(req)
      req.session.cookie.maxAge = pending.rememberMe ? REMEMBER_ME_MS : undefined
      req.session.userId = user.id
      req.session.authAt = new Date().toISOString()
      await save(req)
      if (req.body.trustDevice === true) {
        res.cookie(DEVICE_TRUST_COOKIE, createDeviceTrustToken(twoFactorSecret, {
          userId: user.id,
          passwordChangedAt: user.password_changed_at,
        }), { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: DEVICE_TRUST_TTL_MS, path: '/' })
      }
      res.json({ session: await buildSessionPayload(user, req) })
    } catch (error) {
      return respondDbError(res, error, DB_FEATURES.sign_in_codes)
    }
  })

  router.post('/api/auth/sign-in/resend', loginCodeSendRateLimit, async (req, res) => {
    const pending = req.session.pendingLogin
    if (!pending?.challengeId) return challengeError(res, { reason: 'missing' })
    try {
      const now = Date.now()
      const row = await readChallenge(pending)
      const status = resendStatus(row, now)
      if (status.reason === 'missing' || status.reason === 'timed-out' || status.reason === 'exhausted') {
        if (row) await removeChallenge(row.id)
        await dropPending(req)
        return challengeError(res, { reason: UNCLAIMED_REASONS[status.reason] })
      }
      // Too many sends, or the cooldown: the code already mailed still works.
      if (status.reason !== 'ok') return challengeError(res, status)

      const user = await getUserById(pending.subject)
      if (!user) {
        await removeChallenge(row.id)
        await dropPending(req)
        return challengeError(res, { reason: 'missing' })
      }
      if (codeMailRefused(res, user.id)) return

      // The swap on `sends` lets one of two resends in flight mail a code; the
      // other is told to wait, as if it had arrived inside the cooldown.
      const code = generateCode()
      const expiresAt = new Date(now + CODE_TTL_MS).toISOString()
      const sends = Number(row.sends) || 0
      const { data: swapped, error: swapErr } = await supabase
        .from(CHALLENGES)
        .update({
          code_hash: hashSignInCode(twoFactorSecret, { challengeId: row.id, subject: row.user_id, code }),
          expires_at: expiresAt,
          attempts: 0,
          sends: sends + 1,
          sent_at: new Date(now).toISOString(),
        })
        .eq('id', row.id)
        .eq('sends', sends)
        .select('id')
      if (swapErr) throw swapErr
      if (!swapped?.length) return challengeError(res, { reason: 'cooldown', retryAfterMs: RESEND_COOLDOWN_MS })

      if (!(await deliverSignInCode(user.email, code))) return res.status(503).json(UNSENT_LOGIN_CODE)
      res.json({ ok: true, expiresAt })
    } catch (error) {
      return respondDbError(res, error, { ...DB_FEATURES.sign_in_codes, fallback: 'Could not send a new code. Please try again.' })
    }
  })

  router.post('/api/sign-out', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE_NAME)
      res.json({ ok: true })
    })
  })

  router.post('/api/auth/supabase-sync', sessionSyncIpRateLimit, sessionSyncRateLimit, async (req, res) => {
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

      // Anyone holding the password can mint a password-only Supabase token
      // directly, so with the gate on such a token may only refresh the session
      // that already passed the emailed code, or sign in a trusted device.
      if (loginTwoFactorEnabled && loginTwoFactorSyncGate && tokenNeedsSignInCode(accessToken)) {
        const resumesSession = Boolean(user) && req.session?.userId === user.id
        if (!user || !(resumesSession || hasDeviceTrust(req, user))) {
          return res.status(401).json({
            error: { message: 'Enter the code we emailed you to finish signing in.', status: 401, code: 'two-factor-required' },
          })
        }
      }

      if (!user) {
        const timestamp = new Date().toISOString()
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
            updated_at: new Date().toISOString()
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
        req.session.authAt = new Date().toISOString()
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

  router.get('/auth/purdue/connect', purdueLinkFlowRateLimit, resolvePurdueLinkActor, (req, res) => {
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

  router.post('/auth/purdue/dev/link', purdueLinkFlowRateLimit, resolvePurdueLinkActor, async (req, res) => {
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

  router.post('/api/purdue/mock-link', userWriteRateLimit, requireAuth, async (req, res) => {
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
  router.post('/api/purdue/link-token', purdueLinkTokenRateLimit, requireAuth, (req, res) => {
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

  router.get('/auth/purdue/callback', purdueLinkFlowRateLimit, resolvePurdueLinkActor, async (req, res) => {
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

  router.get('/api/me/profile', requireAuth, async (req, res) => {
    const payload = await buildSessionPayload(req.currentUser, req)
    res.json({ user: payload.user })
  })

  router.patch('/api/me/profile', signInRateLimit, requireAuth, async (req, res) => {
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
        req.session.authAt = new Date().toISOString()
      }
      const payload = await buildSessionPayload(user, req)
      res.json({ user: payload.user })
    } catch (error) {
      res.status(400).json({ error: { message: error.message || 'Could not update profile.', status: 400 } })
    }
  })

  router.post('/api/me/delete-account', signInRateLimit, requireAuth, async (req, res) => {
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

  return router
}
