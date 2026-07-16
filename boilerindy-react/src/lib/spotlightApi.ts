// Student-side client for sponsored content (advertiser-portal M3). Uses the
// student cookie session (credentials: 'include'). Ads are non-critical chrome,
// so every call fails soft - a serving/tracking error must never break the
// dashboard. Migrated to TypeScript (issue #20).
//
// Named "spotlight" (file AND /api/spotlight/* routes) instead of "ads" because
// ad-blocker filter lists match the ads keyword.

/** Fetch the single active ad for a placement, or null. Never throws. */
export async function getActiveAd(placement = 'home-widget'): Promise<unknown> {
  try {
    const res = await fetch(`/api/spotlight/active?placement=${encodeURIComponent(placement)}`, {
      credentials: 'include',
    })
    if (!res.ok) return null
    const data = (await res.json()) as { ad?: unknown } | null
    return data?.ad || null
  } catch {
    return null
  }
}

/** Fetch multiple active ads for rotation (side rails, etc.). Never throws. */
export async function getActiveAds(placement = 'side-rail', limit = 8): Promise<unknown[]> {
  try {
    const params = new URLSearchParams({ placement, limit: String(limit) })
    const res = await fetch(`/api/spotlight/active?${params}`, { credentials: 'include' })
    if (!res.ok) return []
    const data = (await res.json()) as { ads?: unknown[] } | null
    return Array.isArray(data?.ads) ? data.ads.filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * Log an impression or tap for a served ad. Fire-and-forget - resolves to a
 * boolean but callers can ignore it.
 */
export async function trackAdEvent(campaignId: string, kind: 'impression' | 'tap'): Promise<boolean> {
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
