// Student Marketplace (issue #32, Phase 1). Pure validation + mapping helpers,
// unit-testable without DB/HTTP. No payments and no messaging in Phase 1 —
// contact is the seller's display name + Purdue email shown on the detail page.

export const MARKETPLACE_CATEGORIES = [
  'textbooks', 'furniture', 'electronics', 'housing', 'rideshare', 'tutoring', 'tickets', 'misc',
]
const CATEGORY_SET = new Set(MARKETPLACE_CATEGORIES)
const STATUS_SET = new Set(['active', 'sold', 'removed'])

export const MAX_LISTING_TITLE = 120
export const MAX_LISTING_DESCRIPTION = 2000
export const REPORTS_TO_HIDE = 3

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
 * only when `seller` is supplied (detail view for signed-in users).
 */
export function mapListingRow(row, currentUserId, seller = null) {
  const base = {
    id: row.id,
    title: row.title,
    description: row.description || '',
    category: row.category,
    priceCents: row.price_cents ?? null,
    imageUrl: row.image_url || null,
    status: row.status,
    createdAt: row.created_at,
    isMine: row.user_id === currentUserId,
  }
  if (seller) {
    base.sellerName = seller.name || 'Student'
    base.sellerEmail = seller.email || null
  }
  return base
}
