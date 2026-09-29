import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Icon from './Icons'
import StatusBanner from './StatusBanner'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { invalidateUserQueries, usePurdueEmailStatus, userKeys, useUserId } from '../lib/queries/userData'
import { responseStatus, writeFailureMessage } from '../lib/writeFailure'

// Link a @purdue.edu address by a code mailed to it (issue #181), against the
// three /api/me/purdue-email/* routes (docs/purdue-email-verification.md):
// type the address, get a six-digit code, type it back. On Settings and the
// setup page. A verified code refreshes the session, so user.hasPurdueLinked,
// onboarding and the Marketplace posting gate flip without a reload. A code
// sent before a reload is picked up again from the status route.

type Props = {
  /**
   * Offer "Link without a code (development)": the dev mock link
   * (POST /api/purdue/mock-link) for local work in PURDUE_AUTH_MODE=mock.
   */
  allowDevLink?: boolean
  /** Called once the address is linked. */
  onLinked?: (email: string) => void
}

type Notice = { tone: 'error' | 'success'; text: string }
type Busy = 'send' | 'verify' | 'dev' | null
type ErrorBody = { error?: { message?: unknown; retryAfterSeconds?: unknown } }

const COOLDOWN_FALLBACK_SECONDS = 60
const UNSENT_MESSAGE = 'We could not send the code right now. Please try again in a few minutes.'

function errorBody(err: unknown): ErrorBody['error'] {
  const payload = (err as { payload?: unknown } | null)?.payload
  return payload && typeof payload === 'object' ? (payload as ErrorBody).error : undefined
}

/** Seconds the server asked us to wait: the cooldown's retryAfterSeconds, or the limiter's Retry-After. */
function retryAfterSeconds(err: unknown): number {
  if (responseStatus(err) !== 429) return 0
  const fromBody = Number(errorBody(err)?.retryAfterSeconds)
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody)
  const ms = Number((err as { retryAfterMs?: unknown }).retryAfterMs)
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0
}

/** A failed request for a code: a 503 says why in its own words (not sent, or not set up yet). */
function requestFailureMessage(err: unknown): string {
  if (responseStatus(err) === 503) {
    const message = errorBody(err)?.message
    return typeof message === 'string' && message.trim() ? message.trim() : UNSENT_MESSAGE
  }
  return writeFailureMessage(err, 'Could not send the code. Please try again.')
}

function formatWait(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function PurdueEmailVerification({ allowDevLink = false, onLinked }: Props) {
  const { refreshSession } = useAuth()
  const queryClient = useQueryClient()
  const userId = useUserId()
  const status = usePurdueEmailStatus()

  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  // The address a code went to in this visit; before any request, the status
  // route's pending code stands in, unless the student chose another address.
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [changingAddress, setChangingAddress] = useState(false)
  const [linkedEmail, setLinkedEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  // Tick once a second until the resend wait is over.
  useEffect(() => {
    if (!cooldownUntil) return undefined
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= cooldownUntil) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [cooldownUntil])

  const waitSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))
  const pendingEmail = sentTo ?? (changingAddress ? null : status.data?.pending?.email ?? null)
  const verifiedEmail = linkedEmail ?? (status.data?.linked ? status.data.purdueEmail : null)

  function startCooldown(seconds: number) {
    const t = Date.now()
    setNow(t)
    setCooldownUntil(t + seconds * 1000)
  }

  async function finishLinked(email: string) {
    setLinkedEmail(email)
    setSentTo(null)
    setNotice(null)
    await refreshSession()
    void invalidateUserQueries(queryClient)
    onLinked?.(email)
  }

  async function sendCode(email: string) {
    if (!email || busy) return
    setBusy('send')
    setNotice(null)
    try {
      const data = (await authRequest('/api/me/purdue-email/request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })) as { email?: string; alreadyLinked?: boolean; cooldownSeconds?: number }
      if (data?.alreadyLinked) {
        await finishLinked(email.trim().toLowerCase())
        return
      }
      setSentTo(data?.email || email.trim().toLowerCase())
      setChangingAddress(false)
      setCode('')
      startCooldown(Number(data?.cooldownSeconds) || COOLDOWN_FALLBACK_SECONDS)
      if (userId) void queryClient.invalidateQueries({ queryKey: userKeys.purdueEmail(userId) })
    } catch (err) {
      const wait = retryAfterSeconds(err)
      if (wait) startCooldown(wait)
      setNotice({ tone: 'error', text: requestFailureMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  async function verifyCode(email: string) {
    if (code.length !== 6 || busy) return
    setBusy('verify')
    setNotice(null)
    try {
      const data = (await authRequest('/api/me/purdue-email/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })) as { purdueEmail?: string }
      await finishLinked(data?.purdueEmail || email)
    } catch (err) {
      // Wrong, expired or used up: the server's words, and the code box is
      // cleared for the next try or a new code.
      setCode('')
      const wait = retryAfterSeconds(err)
      if (wait) startCooldown(wait)
      setNotice({ tone: 'error', text: writeFailureMessage(err, 'Could not check the code. Please try again.') })
      if (userId) void queryClient.invalidateQueries({ queryKey: userKeys.purdueEmail(userId) })
    } finally {
      setBusy(null)
    }
  }

  async function devLink(email: string) {
    if (!email || busy) return
    setBusy('dev')
    setNotice(null)
    try {
      await authRequest('/api/purdue/mock-link', { method: 'POST', body: JSON.stringify({ email }) })
      await finishLinked(email.trim().toLowerCase())
    } catch (err) {
      setNotice({ tone: 'error', text: writeFailureMessage(err, 'Could not link your Purdue account.') })
    } finally {
      setBusy(null)
    }
  }

  function changeAddress() {
    setAddress(pendingEmail ?? '')
    setSentTo(null)
    setChangingAddress(true)
    setCode('')
    setNotice(null)
  }

  const noticeEl = notice ? (
    <StatusBanner tone={notice.tone} className="mb-3">
      {notice.text}
    </StatusBanner>
  ) : null

  if (verifiedEmail) {
    return (
      <div data-testid="purdue-email-verification" data-state="verified">
        <StatusBanner tone="success">Verified. {verifiedEmail} is linked to your account.</StatusBanner>
      </div>
    )
  }

  if (status.isLoading && !sentTo && !changingAddress) {
    return (
      <div data-testid="purdue-email-verification" data-state="loading" className="text-[13px] text-[var(--color-txt-3)]">
        Loading…
      </div>
    )
  }

  if (pendingEmail) {
    return (
      <form
        data-testid="purdue-email-verification"
        data-state="code"
        onSubmit={(e) => {
          e.preventDefault()
          void verifyCode(pendingEmail)
        }}
        className="space-y-3"
      >
        {noticeEl}
        <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">
          We sent a 6-digit code to <span className="font-medium text-[var(--color-txt-0)] break-all">{pendingEmail}</span>. It
          expires in 10 minutes.
        </p>
        <div>
          <label htmlFor="purdue-code" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">
            Verification code
          </label>
          <input
            id="purdue-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            disabled={busy !== null}
            className="input w-full px-4 py-3 text-[16px] tracking-[0.3em] font-mono"
          />
        </div>
        <button
          type="submit"
          disabled={code.length !== 6 || busy !== null}
          className="btn btn-primary w-full justify-center text-[13px] px-4 py-2.5 disabled:opacity-50"
        >
          <Icon name="check" size={14} />
          {busy === 'verify' ? 'Checking…' : 'Verify code'}
        </button>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <button
            type="button"
            onClick={() => void sendCode(pendingEmail)}
            disabled={waitSeconds > 0 || busy !== null}
            className="font-medium text-[var(--color-accent)] hover:underline disabled:text-[var(--color-txt-3)] disabled:no-underline"
          >
            {busy === 'send' ? 'Sending…' : waitSeconds > 0 ? `Send a new code in ${formatWait(waitSeconds)}` : 'Send a new code'}
          </button>
          <button type="button" onClick={changeAddress} disabled={busy !== null} className="text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]">
            Use a different address
          </button>
        </div>
      </form>
    )
  }

  const typed = address.trim()
  return (
    <form
      data-testid="purdue-email-verification"
      data-state="email"
      onSubmit={(e) => {
        e.preventDefault()
        void sendCode(typed)
      }}
      className="space-y-3"
    >
      {noticeEl}
      <div>
        <label htmlFor="purdue-email-address" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">
          Purdue email address
        </label>
        <input
          id="purdue-email-address"
          type="email"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="you@purdue.edu"
          autoComplete="email"
          disabled={busy !== null}
          className="input w-full px-4 py-3 text-[16px] sm:text-[14px]"
        />
        <p className="text-[12px] text-[var(--color-txt-3)] mt-1.5">We will email you a 6-digit code to prove the address is yours.</p>
      </div>
      <button
        type="submit"
        disabled={!typed || waitSeconds > 0 || busy !== null}
        className="btn btn-primary w-full justify-center text-[13px] px-4 py-2.5 disabled:opacity-50"
      >
        <Icon name="mail" size={14} />
        {busy === 'send' ? 'Sending…' : waitSeconds > 0 ? `Send code in ${formatWait(waitSeconds)}` : 'Send code'}
      </button>
      {allowDevLink ? (
        <button
          type="button"
          onClick={() => void devLink(typed)}
          disabled={!typed || busy !== null}
          className="block mx-auto text-[12px] text-[var(--color-txt-3)] hover:text-[var(--color-txt-1)] underline underline-offset-2 disabled:no-underline disabled:opacity-60"
        >
          {busy === 'dev' ? 'Linking…' : 'Link without a code (development)'}
        </button>
      ) : null}
    </form>
  )
}
