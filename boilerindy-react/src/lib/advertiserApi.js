// Thin client for the advertiser portal API. Mirrors lib/authApi.js (cookie
// session via credentials: 'include') but talks to the SEPARATE /api/advertiser/*
// routes — advertiser sessions are isolated from the student app server-side.

async function advertiserRequest(url, options = {}) {
  const headers = new Headers(options.headers || {})
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(url, { ...options, headers, credentials: 'include' })
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      (typeof payload === 'string' && payload) ||
      'Request failed'
    const error = new Error(message)
    error.status = response.status
    error.payload = payload
    throw error
  }

  return payload
}

/** @returns {Promise<{ session: { advertiser: object } }>} */
export function advertiserSignIn(email, password) {
  return advertiserRequest('/api/advertiser/sign-in', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function advertiserSignOut() {
  return advertiserRequest('/api/advertiser/sign-out', { method: 'POST' })
}

/** Resolve the current advertiser session, or null if not signed in. */
export async function getAdvertiserSession() {
  try {
    const data = await advertiserRequest('/api/advertiser/me')
    return data?.session?.advertiser || null
  } catch (error) {
    if (error.status === 401) return null
    throw error
  }
}

export function requestAdvertiserAccess({ email, companyName, message }) {
  return advertiserRequest('/api/advertiser/request-access', {
    method: 'POST',
    body: JSON.stringify({ email, companyName, message }),
  })
}

// ── Password reset (forgot-password) ─────────────────────────────────────────

/** Request a reset link. Resolves the same way whether or not the email exists. */
export function requestAdvertiserPasswordReset(email) {
  return advertiserRequest('/api/advertiser/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

/** Set a new password using the token from the emailed reset link. */
export function resetAdvertiserPassword(token, password) {
  return advertiserRequest('/api/advertiser/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
}

// ── Campaigns (M2) ───────────────────────────────────────────────────────────

/** @returns {Promise<{ campaigns: Array<object> }>} */
export function listCampaigns() {
  return advertiserRequest('/api/advertiser/campaigns')
}

/** @param {{ name, placement, startsOn?, endsOn?, creative? }} payload */
export function createCampaign(payload) {
  return advertiserRequest('/api/advertiser/campaigns', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** @param {string} id @param {object} patch partial fields incl. optional status */
export function updateCampaign(id, patch) {
  return advertiserRequest(`/api/advertiser/campaigns/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** @returns {Promise<{ stats: { impressions: number, taps: number, ctr: number } }>} */
export function getCampaignStats(id) {
  return advertiserRequest(`/api/advertiser/campaigns/${id}/stats`)
}
