// Authenticated fetch wrapper + small user/display helpers shared across the app.
// Migrated to TypeScript (issue #20).

type UserLike = { name?: string | null; email?: string | null } | null | undefined

export async function registerSupabaseUser(
  email: string,
  password: string,
  name: string,
  rememberMe = false,
): Promise<unknown> {
  return authRequest('/api/auth/register-supabase', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, rememberMe }),
  })
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
    const p = payload as { error?: { message?: string }; message?: string } | string | null
    const message =
      (typeof p === 'object' && p?.error?.message) ||
      (typeof p === 'object' && p?.message) ||
      (typeof p === 'string' && p) ||
      'Request failed'
    const error = new Error(message) as Error & { status?: number; payload?: unknown }
    error.status = response.status
    error.payload = payload
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

export function parseNextPath(search: string): string {
  const next = new URLSearchParams(search).get('next')
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) return next
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
  const next = new URLSearchParams(search).get('next')
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) return next
  if (shouldSkipSetup()) return '/dashboard'
  if (onboarding && onboarding.needsScheduleSource === false) return '/dashboard'
  return '/setup'
}

export function startPurdueLink(nextPath = '/setup'): void {
  const safeNext =
    nextPath.startsWith('/') && !nextPath.startsWith('//') && !nextPath.startsWith('/\\') ? nextPath : '/setup'
  window.location.href = `/auth/purdue/connect?next=${encodeURIComponent(safeNext)}`
}
