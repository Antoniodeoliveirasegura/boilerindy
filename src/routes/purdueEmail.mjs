import crypto from 'node:crypto'
import express from 'express'
import { badRequest, DB_FEATURES, respondDbError } from '../dbErrors.mjs'
import { maskEmail, purdueVerificationEmail } from '../email.mjs'
import {
  LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE,
  RESEND_COOLDOWN_MS,
  attemptsLeft,
  challengeExpiry,
  cooldownRemainingSeconds,
  evaluateChallenge,
  generateCode,
  hashCode,
  isChallengeExpired,
  normalizePurdueEmail,
  parseVerificationCode,
} from '../purdueEmailVerification.mjs'

// Purdue email-code verification (issue #181): request a code for a
// @purdue.edu address, verify it, and read where the student stands. A
// verified code links the address through linkPurdueIdentity, injected from
// server.mjs, so every uniqueness, recovery and orphan rule of a CAS link
// applies unchanged. The rules live in src/purdueEmailVerification.mjs; the
// contracts are in docs/purdue-email-verification.md.
//
// Codes are never logged in production and never sent back in an answer. The
// request answer never says whether an address belongs to someone else; only
// a student who proved they own the mailbox can learn that, from verify.

const TABLE = 'purdue_email_challenges'
const EXPIRED_MESSAGE = 'That code has expired. Request a new one.'
const UNSENT_MESSAGE = 'We could not send the code right now. Please try again in a few minutes.'
// A wrong code is counted with the count it was read at, so two wrong codes
// in flight cannot land on one count; the loser reads the count again.
const COUNT_RETRIES = 5

const sameAddress = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

// The student's newest challenge, or null. Earlier ones are deleted by the
// next request, so this is the only one that can be live.
async function newestChallenge(supabase, userId, columns) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(columns)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

async function countWrongCode(supabase, challenge) {
  let attempts = Number(challenge.attempts) || 0
  for (let i = 0; i < COUNT_RETRIES; i += 1) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ attempts: attempts + 1 })
      .eq('id', challenge.id)
      .eq('attempts', attempts)
      .select('id')
    if (error) throw error
    if (data?.length) return
    const { data: row, error: readErr } = await supabase.from(TABLE).select('attempts').eq('id', challenge.id).maybeSingle()
    if (readErr) throw readErr
    // Gone: a new request replaced it, and that challenge starts at zero.
    if (!row) return
    attempts = Number(row.attempts) || 0
  }
}

/**
 * The Purdue email routes, mounted by server.mjs next to the layouts router.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase               the Supabase client
 * @param {Function} deps.requireAuth            loads req.currentUser or answers 401
 * @param {Function} deps.purdueVerifyRateLimit  the `purdue-verify` limiter (10 an hour)
 * @param {Function} deps.linkPurdueIdentity     (userId, { email }) => the updated user row; throws with a message for the student
 * @param {Function} deps.sendEmail              ({ to, subject, html }) => { sent } or { sent: false, skipped: true }
 * @param {boolean}  deps.isProduction           whether an unsent code must fail the request
 */
export function createPurdueEmailRouter({ supabase, requireAuth, purdueVerifyRateLimit, linkPurdueIdentity, sendEmail, isProduction }) {
  const router = express.Router()

  router.post('/api/me/purdue-email/request', purdueVerifyRateLimit, requireAuth, async (req, res) => {
    const user = req.currentUser
    const email = normalizePurdueEmail(req.body?.email)
    if (!email) return badRequest(res, 'Use your @purdue.edu address.')
    if (sameAddress(user.purdue_email, email)) return res.json({ ok: true, alreadyLinked: true })
    if (user.purdue_email) return badRequest(res, LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE)
    try {
      const now = Date.now()
      const newest = await newestChallenge(supabase, user.id, 'id, created_at')
      const wait = cooldownRemainingSeconds(newest?.created_at, now)
      if (wait > 0) {
        res.set('Retry-After', String(wait))
        return res.status(429).json({
          error: { message: 'Please wait a minute before requesting another code.', status: 429, retryAfterSeconds: wait },
        })
      }

      // A new request invalidates every earlier code.
      const { error: clearErr } = await supabase.from(TABLE).delete().eq('user_id', user.id)
      if (clearErr) throw clearErr
      // The id is made here so the stored hash can cover it.
      const id = crypto.randomUUID()
      const code = generateCode()
      const expiresAt = challengeExpiry(now)
      const { error: insertErr } = await supabase.from(TABLE).insert({
        id,
        user_id: user.id,
        email,
        code_hash: hashCode(id, code),
        expires_at: expiresAt,
        attempts: 0,
        created_at: new Date(now).toISOString(),
      })
      if (insertErr) throw insertErr

      // The code goes to the address being verified, not the login email.
      let delivery = null
      try {
        delivery = await sendEmail({ to: email, ...purdueVerificationEmail({ code }) })
      } catch (sendErr) {
        // A constant format string: the address is an argument, never the format.
        console.error('[purdue-email] could not send a code to %s:', maskEmail(email), sendErr?.message || sendErr)
      }
      if (!delivery || (delivery.skipped && isProduction)) {
        if (delivery?.skipped) console.error('[purdue-email] RESEND_API_KEY or RESEND_FROM is not set; no code was sent')
        // Nothing was delivered, so nothing is pending and no cooldown applies.
        const { error: undoErr } = await supabase.from(TABLE).delete().eq('id', id)
        if (undoErr) console.error('[purdue-email] could not remove an unsent code:', undoErr.code, undoErr.message)
        return res.status(503).json({ error: { message: UNSENT_MESSAGE, status: 503 } })
      }
      // Local work without an email provider, like the advertiser reset link.
      if (delivery.skipped) console.log('[purdue-email] dev code for %s: %s', maskEmail(email), code)
      res.json({ ok: true, email, expiresAt, cooldownSeconds: RESEND_COOLDOWN_MS / 1000 })
    } catch (e) {
      return respondDbError(res, e, DB_FEATURES.purdue_email_verification)
    }
  })

  router.post('/api/me/purdue-email/verify', purdueVerifyRateLimit, requireAuth, async (req, res) => {
    const code = parseVerificationCode(req.body?.code)
    if (!code) return badRequest(res, 'Enter the 6-digit code.')
    const userId = req.currentUser.id
    try {
      const now = Date.now()
      const challenge = await newestChallenge(supabase, userId, 'id, email, code_hash, expires_at, attempts, consumed_at, created_at')
      const verdict = evaluateChallenge(challenge, code, now)
      if (verdict === 'none' || verdict === 'consumed') return badRequest(res, 'Request a code first.')
      if (verdict === 'expired' || verdict === 'exhausted') return badRequest(res, EXPIRED_MESSAGE)
      if (verdict === 'wrong') {
        await countWrongCode(supabase, challenge)
        return badRequest(res, 'That code is not right.')
      }

      // Spend the code before linking, and only if nobody else did: of two
      // right answers in flight, one links and the other is told to start over.
      const { data: spent, error: spendErr } = await supabase
        .from(TABLE)
        .update({ consumed_at: new Date(now).toISOString() })
        .eq('id', challenge.id)
        .is('consumed_at', null)
        .select('id')
      if (spendErr) throw spendErr
      if (!spent?.length) return badRequest(res, EXPIRED_MESSAGE)

      // linkPurdueIdentity writes nothing until its checks pass, so a refusal
      // (the address is held by another profile, or this one holds another
      // address) leaves the existing linkage as it was.
      let linked
      try {
        linked = await linkPurdueIdentity(userId, { email: challenge.email })
      } catch (linkErr) {
        return badRequest(res, linkErr?.message || 'Could not link your Purdue account. Please try again.')
      }
      res.json({ ok: true, purdueEmail: linked?.purdue_email || challenge.email })
    } catch (e) {
      return respondDbError(res, e, DB_FEATURES.purdue_email_verification)
    }
  })

  router.get('/api/me/purdue-email/status', requireAuth, async (req, res) => {
    const user = req.currentUser
    try {
      const challenge = await newestChallenge(supabase, user.id, 'email, expires_at, attempts, consumed_at')
      const pending =
        challenge && !challenge.consumed_at && !isChallengeExpired(challenge.expires_at)
          ? { email: challenge.email, expiresAt: new Date(challenge.expires_at).toISOString(), attemptsLeft: attemptsLeft(challenge) }
          : null
      res.json({ linked: Boolean(user.purdue_email), purdueEmail: user.purdue_email || null, pending })
    } catch (e) {
      return respondDbError(res, e, DB_FEATURES.purdue_email_verification)
    }
  })

  return router
}
