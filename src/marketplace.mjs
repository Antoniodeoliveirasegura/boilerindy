// Student Marketplace (issue #32, Phase 1). Pure validation + mapping helpers,
// unit-testable without DB/HTTP. No payments and no messaging in Phase 1 -
// contact is the seller's display name + Purdue email shown on the detail page.

import { isMissingColumnError } from './moderation.mjs'

export const MARKETPLACE_CATEGORIES = [
  'textbooks', 'furniture', 'electronics', 'housing', 'rideshare', 'tutoring', 'tickets', 'misc',
]
const CATEGORY_SET = new Set(MARKETPLACE_CATEGORIES)
const STATUS_SET = new Set(['active', 'sold', 'removed'])

export const MAX_LISTING_TITLE = 120
export const MAX_LISTING_DESCRIPTION = 2000
export const REPORTS_TO_HIDE = 3

// Report reasons (issue #204). The website's report form (#224) sends one
// flattened string: a bare reason, or `other: <details>` when the reporter
// typed something. A client may instead send { reason, details } as separate
// fields. parseReportInput accepts both and stores one shape, so the enum lives
// here rather than in the page: boilerindy-react imports these values.
export const REPORT_REASONS = ['spam', 'scam', 'prohibited', 'other']
const REPORT_REASON_SET = new Set(REPORT_REASONS)

// marketplace_reports.reason is CHECK (char_length(reason) <= 500), so the
// composed string is cut to fit rather than rejected: a reporter who pastes an
// essay still gets their report filed.
export const MAX_REPORT_REASON = 500
export const REPORT_DETAILS_SEPARATOR = ': '

/**
 * Validate a report body and compose the stored reason.
 * @param {{ reason?: unknown, details?: unknown }} body
 * @returns {{ ok: true, reason: string } | { ok: false, message: string }}
 */
export function parseReportInput(body) {
  const raw = String(body?.reason ?? '').trim()
  if (!raw) return { ok: false, message: 'Choose a reason for the report.' }
  // Split on the first separator so `other: it never shipped` reads as the
  // reason `other` with details, and a colon inside the details survives.
  const cut = raw.indexOf(':')
  const reason = (cut === -1 ? raw : raw.slice(0, cut)).trim().toLowerCase()
  if (!REPORT_REASON_SET.has(reason)) {
    return { ok: false, message: `Reason must be one of: ${REPORT_REASONS.join(', ')}.` }
  }
  const details = String(body?.details ?? '').trim() || (cut === -1 ? '' : raw.slice(cut + 1).trim())
  const composed = details ? `${reason}${REPORT_DETAILS_SEPARATOR}${details}` : reason
  return { ok: true, reason: composed.slice(0, MAX_REPORT_REASON) }
}

/**
 * Decide whether a report may be filed against a listing. The route looks the
 * listing up first (live rows only), which is what keeps a soft-deleted or
 * unknown id from reaching the insert and failing as a foreign-key 500.
 * @param {{ listing?: { user_id?: string } | null, reporterId?: string }} input
 * @returns {{ status: 200 } | { status: 400 | 404, message: string }}
 */
export function evaluateReportTarget({ listing, reporterId } = {}) {
  if (!listing) return { status: 404, message: 'Listing not found.' }
  if (listing.user_id === reporterId) return { status: 400, message: 'You cannot report your own listing.' }
  return { status: 200 }
}

/**
 * True once a listing has drawn reports from REPORTS_TO_HIDE distinct accounts.
 * The primary key on (listing_id, reporter_id) is what makes the row count a
 * count of reporters.
 * @param {unknown} count
 * @returns {boolean}
 */
export function shouldAutoHide(count) {
  return Number(count) >= REPORTS_TO_HIDE
}

// db/supabase-marketplace.sql does not create image_urls or price_mode; the
// later gallery and pricing migration (README step 31) adds them. A database
// error naming one of them sends the operator to that file (#218).
export const MARKETPLACE_GALLERY_PRICING_SQL_FILE = 'db/supabase-marketplace-gallery-pricing.sql'
export const MARKETPLACE_GALLERY_PRICING_COLUMNS = Object.freeze(['image_urls', 'price_mode'])

/**
 * True when the database reports that a column from
 * MARKETPLACE_GALLERY_PRICING_COLUMNS does not exist yet (42703 or PGRST204).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMissingGalleryPricingColumn(err) {
  return MARKETPLACE_GALLERY_PRICING_COLUMNS.some((column) => isMissingColumnError(err, column))
}

function isHttpUrl(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validate + coerce a listing body into DB columns.
 * @param {object} body
 * @param {{ partial?: boolean }} [opts] - partial allows missing fields (PATCH)
 * @returns {{ value: object } | { error: string }}
 */
export function validateListingInput(body, { partial = false } = {}) {
  const updates = {}
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k)

  if (has('title') || !partial) {
    const title = String(body?.title ?? '').trim()
    if (!title || title.length > MAX_LISTING_TITLE) {
      return { error: `Title is required (max ${MAX_LISTING_TITLE} characters)` }
    }
    updates.title = title
  }
  if (has('description') || !partial) {
    const desc = String(body?.description ?? '').trim()
    if (desc.length > MAX_LISTING_DESCRIPTION) {
      return { error: `Description must be ${MAX_LISTING_DESCRIPTION} characters or fewer` }
    }
    updates.description = desc
  }
  if (has('category') || !partial) {
    const category = String(body?.category ?? '').trim().toLowerCase()
    if (!CATEGORY_SET.has(category)) {
      return { error: `Category must be one of: ${MARKETPLACE_CATEGORIES.join(', ')}` }
    }
    updates.category = category
  }
  if (has('priceCents')) {
    const raw = body.priceCents
    if (raw === null || raw === '') {
      updates.price_cents = null
    } else {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0 || n > 100000000) {
        return { error: 'Price must be a whole number of cents (0 or more)' }
      }
      updates.price_cents = n
    }
  }
  if (has('priceMode')) {
    if (!['fixed', 'free', 'best_offer'].includes(body.priceMode)) return { error: 'Choose a valid price option' }
    updates.price_mode = body.priceMode
    if (body.priceMode === 'free') updates.price_cents = 0
    if (body.priceMode === 'best_offer') updates.price_cents = null
    if (body.priceMode === 'fixed' && !has('priceCents')) updates.price_cents = null
  } else if (has('priceCents')) {
    updates.price_mode = updates.price_cents === 0 ? 'free' : 'fixed'
  }
  if (updates.price_cents === 0) updates.price_mode = 'free'
  if (has('imageUrl')) {
    const url = String(body.imageUrl ?? '').trim()
    if (url && !isHttpUrl(url)) return { error: 'Image URL must be a valid http(s) link' }
    updates.image_url = url || null
  }
  if (has('status')) {
    const status = String(body.status ?? '').trim().toLowerCase()
    if (!STATUS_SET.has(status)) return { error: 'Status must be active, sold, or removed' }
    updates.status = status
  }
  return { value: updates }
}

/**
 * Shape a DB row for the API. Seller contact (name + Purdue email) is included
 * only when `seller` is supplied (detail view for signed-in users), and
 * `reportCount` only when the row belongs to the caller (issue #204).
 */
export function mapListingRow(row, currentUserId, seller = null, { reportCount } = {}) {
  const base = {
    id: row.id,
    title: row.title,
    description: row.description || '',
    category: row.category,
    priceCents: row.price_cents ?? null,
    priceMode: row.price_cents === 0 ? 'free' : row.price_mode || 'fixed',
    imageUrl: row.image_url || null,
    images: row.image_urls?.length ? row.image_urls : row.image_url ? [row.image_url] : [],
    status: row.status,
    createdAt: row.created_at,
    isMine: row.user_id === currentUserId,
    hidden: Boolean(row.hidden),
  }
  // Report totals are moderation data: the owner sees why their own listing
  // went dark, nobody else sees who is being reported or how close they are to
  // the threshold.
  if (base.isMine && Number.isFinite(reportCount)) base.reportCount = Number(reportCount)
  if (seller) {
    base.sellerName = seller.name || 'Student'
    base.sellerEmail = seller.email || null
  }
  return base
}
