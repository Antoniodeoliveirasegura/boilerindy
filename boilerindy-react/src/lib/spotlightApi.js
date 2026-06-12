// Student-side client for sponsored content (advertiser-portal M3). Uses the
// student cookie session (credentials: 'include'). Ads are non-critical chrome,
// so every call fails soft — a serving/tracking error must never break the
// dashboard.
//
// Named "spotlight" (file AND /api/spotlight/* routes) instead of "ads" because
// ad-blocker filter lists match the ads keyword: in dev the blocked module file
// white-screened the whole app (net::ERR_BLOCKED_BY_CLIENT), and in production
// the API calls would be blocked the same way.

/** Fetch the single active ad for a placement, or null. Never throws. */
export async function getActiveAd(placement = 'home-widget') {
  try {
    const res = await fetch(`/api/spotlight/active?placement=${encodeURIComponent(placement)}`, {
      credentials: 'include',
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.ad || null
  } catch {
    return null
  }
}

/**
 * Log an impression or tap for a served ad. Fire-and-forget — resolves to a
 * boolean but callers can ignore it.
 * @param {string} campaignId
 * @param {'impression'|'tap'} kind
 */
export async function trackAdEvent(campaignId, kind) {
  if (!campaignId) return false
  try {
    const res = await fetch(`/api/spotlight/${encodeURIComponent(campaignId)}/event`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    })
    return res.ok
  } catch {
    return false
  }
}
