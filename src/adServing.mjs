// Pure ad-serving logic (M3), kept out of server.mjs so eligibility, selection,
// and stats are unit-testable. The server fetches campaign rows + ad_event rows
// and feeds them here; this module decides what (if anything) to serve and how
// to shape it for the student home dashboard.

export const AD_EVENT_KINDS = ['impression', 'tap']

export function isValidAdEventKind(kind) {
  return AD_EVENT_KINDS.includes(kind)
}

// A campaign is servable when it is approved-and-live (active) and today falls
// within its window. Null dates mean open-ended on that side. `today` and the
// stored dates are 'YYYY-MM-DD' strings, which compare correctly lexically.
export function isCampaignServable(campaign, today) {
  if (!campaign || campaign.status !== 'active') return false
  if (campaign.starts_on && campaign.starts_on > today) return false
  if (campaign.ends_on && campaign.ends_on < today) return false
  return true
}

/**
 * Choose one servable campaign at random (fair rotation across advertisers).
 * @param {Array} campaigns candidate rows for a placement
 * @param {string} today 'YYYY-MM-DD'
 * @param {() => number} rng injectable for deterministic tests
 * @returns {object|null}
 */
export function selectServableCampaign(campaigns, today, rng = Math.random) {
  const eligible = (campaigns || []).filter((c) => isCampaignServable(c, today))
  if (eligible.length === 0) return null
  const index = Math.floor(rng() * eligible.length)
  return eligible[Math.min(index, eligible.length - 1)]
}

// Defense-in-depth: only serve http/https URLs even though they were validated
// on write (guards against legacy/hand-edited rows injecting javascript:/data:).
function safeServeUrl(url) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

/** Return up to `limit` servable campaigns, shuffled for fair rotation. */
export function listServableCampaigns(campaigns, today, limit = 8, rng = Math.random) {
  const eligible = (campaigns || []).filter((c) => isCampaignServable(c, today))
  if (eligible.length === 0) return []
  const shuffled = [...eligible]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, Math.max(1, limit))
}

/** Shape a campaign into the minimal, safe creative payload served to students. */
export function toServedAd(campaign) {
  if (!campaign) return null
  const creative = campaign.creative || {}
  const rawUrls = Array.isArray(creative.imageUrls) ? creative.imageUrls : []
  const imageUrls = rawUrls.map((url) => safeServeUrl(url)).filter(Boolean)
  const legacyImage = safeServeUrl(creative.imageUrl)
  if (imageUrls.length === 0 && legacyImage) imageUrls.push(legacyImage)
  return {
    campaignId: campaign.id,
    placement: campaign.placement,
    headline: creative.headline || null,
    body: creative.body || null,
    imageUrl: imageUrls[0] || null,
    imageUrls,
    ctaLabel: creative.ctaLabel || null,
    ctaUrl: safeServeUrl(creative.ctaUrl),
  }
}

/** Aggregate ad_event rows into counts + click-through rate. No PII involved. */
export function summarizeAdEvents(events) {
  let impressions = 0
  let taps = 0
  for (const event of events || []) {
    if (event.kind === 'impression') impressions += 1
    else if (event.kind === 'tap') taps += 1
  }
  return {
    impressions,
    taps,
    ctr: impressions > 0 ? taps / impressions : 0,
  }
}
