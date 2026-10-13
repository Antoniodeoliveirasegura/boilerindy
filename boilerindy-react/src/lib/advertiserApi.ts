// Thin client for the advertiser portal API. Mirrors lib/authApi (cookie
// session via credentials: 'include') but talks to the SEPARATE /api/advertiser/*
// routes - advertiser sessions are isolated from the student app server-side.
// Migrated to TypeScript (issue #20).

// redirectOn401: false leaves a 401 to the caller. Saving a campaign passes it:
// the redirect is a full page load, so it threw away the campaign form the
// advertiser had just filled in, when they could sign in again in another tab
// and save the same form.
type RequestBehavior = { redirectOn401?: boolean }

async function advertiserRequest(
  url: string,
  options: RequestInit = {},
  { redirectOn401 = true }: RequestBehavior = {},
): Promise<unknown> {
  const headers = new Headers(options.headers || {})
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(url, { ...options, headers, credentials: 'include' })
  const contentType = response.headers.get('content-type') || ''
  const payload: unknown = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    // A 401 here means the advertiser session ended after RequireAdvertiser
    // let the page in: the cookie lapsed, or a sign-out or a student sign-in
    // in another tab replaced it. The dashboard used to stay put with "You
    // must sign in" over a false "No campaigns yet", so send the advertiser
    // back to sign in with a session-expired notice, as authRequest does for
    // the student app. A wrong password on the sign-in form is a 401 too and
    // must show its error, so the sign-in call is left to its caller, as are
    // the /me probe (which answers 200 either way), anything asked from the
    // sign-in page itself and any call that passes redirectOn401: false.
    if (
      response.status === 401 &&
      redirectOn401 &&
      window.location.pathname !== '/advertise' &&
      !url.includes('/api/advertiser/sign-in') &&
      !url.includes('/api/advertiser/me')
    ) {
      window.location.replace('/advertise?message=session-expired')
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

export function advertiserSignIn(email: string, password: string): Promise<unknown> {
  return advertiserRequest('/api/advertiser/sign-in', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function advertiserSignOut(): Promise<unknown> {
  return advertiserRequest('/api/advertiser/sign-out', { method: 'POST' })
}

/**
 * Resolve the current advertiser session, or null if not signed in.
 * GET /api/advertiser/me answers 200 either way (like /api/session), so a
 * signed-out probe never logs a 401 in the console: { authenticated: false }
 * when signed out, { authenticated: true, session: { advertiser } } otherwise.
 */
export async function getAdvertiserSession(): Promise<unknown> {
  const data = (await advertiserRequest('/api/advertiser/me')) as
    | { authenticated?: boolean; session?: { advertiser?: unknown } }
    | null
  if (!data || data.authenticated === false) return null
  return data.session?.advertiser || null
}

export function requestAdvertiserAccess(input: {
  email: string
  companyName: string
  message?: string
}): Promise<unknown> {
  return advertiserRequest('/api/advertiser/request-access', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

// ── Password reset (forgot-password) ─────────────────────────────────────────

/** Request a reset link. Resolves the same way whether or not the email exists. */
export function requestAdvertiserPasswordReset(email: string): Promise<unknown> {
  return advertiserRequest('/api/advertiser/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

/** Set a new password using the token from the emailed reset link. */
export function resetAdvertiserPassword(token: string, password: string): Promise<unknown> {
  return advertiserRequest('/api/advertiser/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
}

// ── Campaigns (M2) ───────────────────────────────────────────────────────────

export function listCampaigns(): Promise<unknown> {
  return advertiserRequest('/api/advertiser/campaigns')
}

// Saves never redirect on a 401 (see RequestBehavior), so the caller can keep
// the form open. A status change with no form open has nothing to lose and
// passes redirectOn401: true, as the campaign reads do by default.
export function createCampaign(payload: Record<string, unknown>): Promise<unknown> {
  return advertiserRequest(
    '/api/advertiser/campaigns',
    { method: 'POST', body: JSON.stringify(payload) },
    { redirectOn401: false },
  )
}

export function updateCampaign(
  id: string,
  patch: Record<string, unknown>,
  { redirectOn401 = false }: RequestBehavior = {},
): Promise<unknown> {
  return advertiserRequest(
    `/api/advertiser/campaigns/${id}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    { redirectOn401 },
  )
}

export function getCampaignStats(id: string): Promise<unknown> {
  return advertiserRequest(`/api/advertiser/campaigns/${id}/stats`)
}
