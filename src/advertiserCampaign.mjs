// Pure validation/normalization for advertiser campaigns (M2), kept out of
// server.mjs so it can be unit-tested without a live Supabase. Shapes the data
// that goes into the `campaigns` table (see supabase-advertiser-campaigns.sql)
// and enforces the approval flow via a status-transition map.

export const CAMPAIGN_PLACEMENTS = ['home-widget', 'side-rail', 'dining', 'transit', 'events']
export const CAMPAIGN_STATUSES = ['draft', 'pending_review', 'active', 'paused', 'ended']
export const MIN_BANNER_PHOTOS = 3
export const MAX_BANNER_PHOTOS = 8

export const CAMPAIGN_NAME_MAX = 200
const CREATIVE_LIMITS = {
  headline: 120,
  body: 300,
  ctaLabel: 40,
  imageUrl: 500,
  ctaUrl: 500,
  imageUrls: 500,
}

// Transitions an ADVERTISER may perform. Activating a campaign (-> 'active' from
// draft/pending_review) is intentionally absent: only the owner approves, via
// scripts/review-campaign.mjs. Resuming an already-approved paused campaign IS
// allowed (paused -> active); editing its banner or placement first sends it
// back to draft (see normalizeCampaignPatch), so what resumes is what was approved.
export const ADVERTISER_STATUS_TRANSITIONS = {
  draft: ['pending_review', 'ended'],
  pending_review: ['draft', 'ended'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: [],
}

// Statuses the owner has approved. A campaign in one of them went through
// review with the placement and creative it holds now.
const APPROVED_STATUSES = ['active', 'paused']

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// What students see of a creative, as one comparable string. The photo list
// falls back to the single legacy imageUrl, as toServedAd serves it. A missing
// link label is the default students see (SpotlightCard), which the edit form
// also fills in, so a dates-only save of an approved banner with no label of
// its own is not taken for a new banner and sent back to draft.
const DEFAULT_CTA_LABEL = 'Visit website'
function servedCreativeKey(creative) {
  const c = creative || {}
  const photos = Array.isArray(c.imageUrls) && c.imageUrls.length > 0 ? c.imageUrls : c.imageUrl ? [c.imageUrl] : []
  return JSON.stringify([c.headline || '', c.body || '', c.ctaLabel || DEFAULT_CTA_LABEL, c.ctaUrl || '', photos])
}

export function isValidPlacement(placement) {
  return CAMPAIGN_PLACEMENTS.includes(placement)
}

// Returns the url unchanged if it is a syntactically valid http/https URL,
// otherwise throws. Guards against javascript:/data: injection in served ads.
export function safeHttpUrl(url, label = 'URL') {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label} must be a valid URL starting with http:// or https://`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must start with http:// or https://`)
  }
  return parsed.toString()
}

function validateDate(value, label) {
  const raw = cleanString(value)
  if (!raw) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} must be a date in YYYY-MM-DD format.`)
  }
  const date = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} is not a valid date.`)
  }
  return raw
}

// Normalize the creative payload: trim, length-cap, validate URLs, drop unknown
// keys. Returns a plain object with only the provided fields.
export function normalizeCreative(input = {}) {
  if (input == null || typeof input !== 'object') {
    throw new Error('Creative must be an object.')
  }
  const creative = {}

  for (const field of ['headline', 'body', 'ctaLabel']) {
    const val = cleanString(input[field])
    if (val) {
      if (val.length > CREATIVE_LIMITS[field]) {
        throw new Error(`${field} must be ${CREATIVE_LIMITS[field]} characters or fewer.`)
      }
      creative[field] = val
    }
  }

  for (const field of ['imageUrl', 'ctaUrl']) {
    const val = cleanString(input[field])
    if (val) {
      if (val.length > CREATIVE_LIMITS[field]) {
        throw new Error(`${field} must be ${CREATIVE_LIMITS[field]} characters or fewer.`)
      }
      creative[field] = safeHttpUrl(val, field === 'ctaUrl' ? 'Website URL' : field)
    }
  }

  if (input.imageUrls != null) {
    if (!Array.isArray(input.imageUrls)) {
      throw new Error('imageUrls must be an array of photo URLs.')
    }
    const urls = input.imageUrls
      .map((url) => cleanString(url))
      .filter(Boolean)
      .map((url) => {
        if (url.length > CREATIVE_LIMITS.imageUrls) {
          throw new Error(`Each photo URL must be ${CREATIVE_LIMITS.imageUrls} characters or fewer.`)
        }
        return safeHttpUrl(url, 'Photo URL')
      })
    if (urls.length > MAX_BANNER_PHOTOS) {
      throw new Error(`At most ${MAX_BANNER_PHOTOS} photo URLs are allowed.`)
    }
    if (urls.length > 0) {
      creative.imageUrls = urls
      creative.imageUrl = urls[0]
    }
  } else if (creative.imageUrl && !creative.imageUrls) {
    creative.imageUrls = [creative.imageUrl]
  }

  return creative
}

export function assertBannerCreative(creative, placement) {
  if (!['home-widget', 'side-rail'].includes(placement)) return
  const urls = creative?.imageUrls || (creative?.imageUrl ? [creative.imageUrl] : [])
  if (urls.length < MIN_BANNER_PHOTOS) {
    throw new Error(`Banner campaigns need at least ${MIN_BANNER_PHOTOS} photo URLs.`)
  }
  if (!creative?.ctaUrl) {
    throw new Error('Banner campaigns require a website URL (https://…).')
  }
}

function assertDateOrder(startsOn, endsOn) {
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new Error('End date must be on or after the start date.')
  }
}

/**
 * Validate input for creating a campaign. New campaigns always start as 'draft'
 * (status is set by the server, not here).
 * @returns {{ name, placement, startsOn, endsOn, creative }}
 */
export function normalizeCampaignInput(input = {}) {
  const name = cleanString(input.name)
  if (!name || name.length > CAMPAIGN_NAME_MAX) {
    throw new Error(`Campaign name is required and must be ${CAMPAIGN_NAME_MAX} characters or fewer.`)
  }
  const placement = cleanString(input.placement)
  if (!isValidPlacement(placement)) {
    throw new Error(`Placement must be one of: ${CAMPAIGN_PLACEMENTS.join(', ')}.`)
  }
  const startsOn = validateDate(input.startsOn, 'Start date')
  const endsOn = validateDate(input.endsOn, 'End date')
  assertDateOrder(startsOn, endsOn)
  const creative = normalizeCreative(input.creative || {})

  return { name, placement, startsOn, endsOn, creative }
}

/**
 * Validate a partial campaign update against the current row. Only the provided
 * fields are returned. A status change is validated against the advertiser
 * transition map relative to currentStatus.
 * @returns object with snake_case-free fields actually changed
 */
export function normalizeCampaignPatch(input = {}, currentRow = {}) {
  const patch = {}

  if (input.name !== undefined) {
    const name = cleanString(input.name)
    if (!name || name.length > CAMPAIGN_NAME_MAX) {
      throw new Error(`Campaign name is required and must be ${CAMPAIGN_NAME_MAX} characters or fewer.`)
    }
    patch.name = name
  }

  if (input.placement !== undefined) {
    const placement = cleanString(input.placement)
    if (!isValidPlacement(placement)) {
      throw new Error(`Placement must be one of: ${CAMPAIGN_PLACEMENTS.join(', ')}.`)
    }
    patch.placement = placement
  }

  if (input.startsOn !== undefined) patch.startsOn = validateDate(input.startsOn, 'Start date')
  if (input.endsOn !== undefined) patch.endsOn = validateDate(input.endsOn, 'End date')

  // Cross-field date check against the effective (merged) values.
  const effectiveStarts = patch.startsOn !== undefined ? patch.startsOn : (currentRow.starts_on || null)
  const effectiveEnds = patch.endsOn !== undefined ? patch.endsOn : (currentRow.ends_on || null)
  assertDateOrder(effectiveStarts, effectiveEnds)

  if (input.creative !== undefined) {
    patch.creative = normalizeCreative(input.creative || {})
  }

  // Changing what students see on an approved campaign sends it back to
  // draft, so it has to be submitted and approved again before it can run.
  // Without this an advertiser could pause a live campaign, swap its link,
  // photos, copy or placement, and resume it with content the owner never
  // reviewed. A new name or new dates keep the approval: students never see
  // the name, and the dates only bound when the reviewed ad runs.
  const reopensReview =
    APPROVED_STATUSES.includes(currentRow.status) &&
    ((patch.placement !== undefined && patch.placement !== currentRow.placement) ||
      (patch.creative !== undefined && servedCreativeKey(patch.creative) !== servedCreativeKey(currentRow.creative)))

  if (input.status !== undefined) {
    const next = cleanString(input.status)
    const current = currentRow.status
    if (!CAMPAIGN_STATUSES.includes(next)) {
      throw new Error('Unknown campaign status.')
    }
    if (reopensReview && next !== 'draft') {
      throw new Error(
        "Changes to an approved campaign's banner or placement send it back to draft for review, so save them without a status change.",
      )
    }
    if (next !== current && !reopensReview) {
      const allowed = ADVERTISER_STATUS_TRANSITIONS[current] || []
      if (!allowed.includes(next)) {
        if (next === 'active') {
          throw new Error('A campaign must be approved before it can go live. Submit it for review instead.')
        }
        throw new Error(`You can't change a campaign from "${current}" to "${next}".`)
      }
      if (next === 'pending_review') {
        const effectiveCreative = patch.creative || currentRow.creative || {}
        const effectivePlacement = patch.placement !== undefined ? patch.placement : currentRow.placement
        assertBannerCreative(effectiveCreative, effectivePlacement)
      }
    }
    patch.status = next
  } else if (reopensReview) {
    patch.status = 'draft'
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('No valid fields to update.')
  }

  return patch
}

/** Shape a DB campaign row into the client-facing JSON. */
export function mapCampaignRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    placement: row.placement,
    status: row.status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    creative: row.creative || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
