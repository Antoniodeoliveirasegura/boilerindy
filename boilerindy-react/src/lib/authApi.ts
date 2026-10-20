// Authenticated fetch wrapper + small user/display helpers shared across the app.
// Migrated to TypeScript (issue #20).

import type { BackendSession } from '../context/AuthContext'
import { retryAfterMsFromHeader } from './queries/publicData'
import { normalizeRoutePath } from './routePath'
import { clearSignupRef, signupRefField } from './signupRef'

type UserLike = { name?: string | null; email?: string | null } | null | undefined

/** What authRequest throws for a non-2xx answer. `code` is the API's error.code when it sent one. */
export type ApiRequestError = Error & { status?: number; payload?: unknown; code?: string; retryAfterMs?: number }

// Sign-in and sign-up either return a session, or (two-step sign-in)
// `twoFactorRequired` with the masked address the code was emailed to.
// `codeSent: false` means a sign-up's account exists but its code email failed.
export type SignInResponse = {
  session?: BackendSession | null
  twoFactorRequired?: boolean
  email?: string
  expiresAt?: string
  codeSent?: boolean
}

// Carries the tab's sign-up source (lib/signupRef), which the server saves with
// the new account; dropped once the account exists, and kept when the request
// fails, so a retry with another address still carries it.
export async function registerSupabaseUser(
  email: string,
  password: string,
  name: string,
  rememberMe = false,
): Promise<SignInResponse> {
  const registered = (await authRequest('/api/auth/register-supabase', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, rememberMe, ...signupRefField() }),
  })) as SignInResponse
  clearSignupRef()
  return registered
}

export async function authRequest(url: string, options: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(options.headers || {})
  const init: RequestInit = { ...options, headers, credentials: 'include' }

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(url, init)
  const contentType = response.headers.get('content-type') || ''
  const payload: unknown = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    if (
      response.status === 401 &&
      window.location.pathname !== '/login' &&
      !url.includes('/api/session') &&
      !url.includes('/api/auth')
    ) {
      const current = window.location.pathname + window.location.search
      const next = encodeURIComponent(current)
      window.location.replace(`/login?next=${next}&message=session-expired`)
      await new Promise(() => {})
    }
    const p = payload as { error?: { message?: string; code?: unknown }; message?: string } | string | null
    const message =
      (typeof p === 'object' && p?.error?.message) ||
      (typeof p === 'object' && p?.message) ||
      (typeof p === 'string' && p) ||
      'Request failed'
    const error = new Error(message) as ApiRequestError
    error.status = response.status
    error.payload = payload
    // The limiter's Retry-After, so a query's retry delay can honour it (issue #327).
    if (response.status === 429) error.retryAfterMs = retryAfterMsFromHeader(response.headers.get('Retry-After'))
    // Machine-readable reason, e.g. marketplace_schema_missing (docs/api-error-codes.md).
    const code = typeof p === 'object' ? p?.error?.code : undefined
    if (typeof code === 'string') error.code = code
    throw error
  }

  return payload
}

export function getInitials(name?: string | null, email?: string | null): string {
  const source = (name || email || 'PIH').trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

export function getDisplayName(user: UserLike): string {
  if (!user) return 'Student'
  if (user.name && user.name.trim()) return user.name.trim()
  if (user.email && user.email.includes('@')) return user.email.split('@')[0]
  return 'Student'
}

export function getFirstName(user: UserLike): string {
  const displayName = getDisplayName(user)
  return displayName.split(/\s+/)[0] || displayName
}

export const SKIP_SETUP_KEY = 'pih-skip-setup'

export function shouldSkipSetup(): boolean {
  try {
    return localStorage.getItem(SKIP_SETUP_KEY) === '1'
  } catch {
    return false
  }
}

export function setSkipSetup(skip: boolean): void {
  try {
    if (skip) localStorage.setItem(SKIP_SETUP_KEY, '1')
    else localStorage.removeItem(SKIP_SETUP_KEY)
  } catch {
    /* storage unavailable */
  }
}

/**
 * A `next` value as a same-site path, or null. Resolved the way the browser
 * and the router will resolve it, because a prefix check is not enough: URL
 * parsing drops tabs and newlines, so "/\t/evil.example" passed a startsWith
 * check and then resolved to "//evil.example", which React Router refuses by
 * throwing, crashing the app on every visit to such a link. Dot segments
 * ("/..//evil.example") can leave a same-origin URL whose path still starts
 * with "//", so that is refused too. So is /login itself: signing in would
 * land back on the sign-in form.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/')) return null
  const base = 'https://next.invalid'
  try {
    const url = new URL(next, base)
    if (url.origin !== base || url.pathname.startsWith('//')) return null
    if (normalizeRoutePath(url.pathname) === '/login') return null
    return url.pathname + url.search + url.hash
  } catch {
    return null
  }
}

export function parseNextPath(search: string): string {
  const next = safeNextPath(new URLSearchParams(search).get('next'))
  if (next) return next
  // Respect a saved choice to skip the schedule-setup screen on login
  return shouldSkipSetup() ? '/dashboard' : '/setup'
}

export type OnboardingLike = { needsScheduleSource?: boolean } | null | undefined

/**
 * Where to send a signed-in user who arrived at /login: an explicit safe
 * `next` wins; otherwise students who already connected a schedule source (or
 * chose to skip setup) go to the dashboard, and everyone else to setup. Before
 * this, every launch of the installed app landed on the setup screen because
 * parseNextPath only knew about the skip flag.
 */
export function resolvePostLoginPath(search: string, onboarding?: OnboardingLike): string {
  const next = safeNextPath(new URLSearchParams(search).get('next'))
  if (next) return next
  if (shouldSkipSetup()) return '/dashboard'
  if (onboarding && onboarding.needsScheduleSource === false) return '/dashboard'
  return '/setup'
}

export function startPurdueLink(nextPath = '/setup'): void {
  const safeNext = safeNextPath(nextPath) ?? '/setup'
  window.location.href = `/auth/purdue/connect?next=${encodeURIComponent(safeNext)}`
}
