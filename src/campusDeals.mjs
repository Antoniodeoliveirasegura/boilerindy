// Campus Perks (issue #24). Admin-curated local deals. Pure helpers - distance,
// validation, active-window, row mapping - kept here so they are unit-testable
// without the DB or HTTP layer.

import { endOfDayInZone } from './pushReminders.mjs'

export const DEAL_CATEGORIES = ['food', 'coffee', 'entertainment', 'services', 'other']
const DEAL_CATEGORY_SET = new Set(DEAL_CATEGORIES)

// Static campus reference point (Purdue Indianapolis), matching the Map page.
export const CAMPUS_COORDS = { lat: 39.774, lng: -86.172 }

export const MAX_BUSINESS_NAME = 120
export const MAX_DEAL_DESCRIPTION = 2000
export const MAX_ADDRESS = 200

// The admin form's expiry is a calendar day (an <input type="date">).
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Great-circle distance in miles between two coordinates.
 */
export function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180
  const R = 3958.8 // Earth radius in miles
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * When a stored expiry ends. A day picked in the form is now saved as 23:59
 * that day on campus, but deals saved before that hold 00:00 UTC of the picked
 * day, which is the evening before in Indianapolis: they left the list and
 * showed the previous day. Those are read as the end of their day too. New
 * writes land at 03:59 or 04:59 UTC, never at midnight, so they pass through,
 * as does anything unparseable (it never reads as active).
 */
function expiryInstant(value) {
  const t = new Date(value)
  if (Number.isNaN(t.getTime())) return t
  const utcMidnight =
    t.getUTCHours() === 0 && t.getUTCMinutes() === 0 && t.getUTCSeconds() === 0 && t.getUTCMilliseconds() === 0
  return utcMidnight ? endOfDayInZone(t.toISOString().slice(0, 10)) : t
}

/**
 * A deal is shown only while active and not past its expiry.
 */
export function isDealActive(deal, now = new Date()) {
  if (!deal || deal.active === false) return false
  if (!deal.expires_at) return true
  return expiryInstant(deal.expires_at).getTime() > now.getTime()
}

function parseCoord(value, max) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n < -max || n > max) return { ok: false }
  return { ok: true, value: n }
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
 * Validate + coerce a deal body into DB columns.
 * @param {object} body
 * @param {{ partial?: boolean }} [opts] - partial allows missing fields (PATCH)
 * @returns {{ value: object } | { error: string }}
 */
export function validateDealInput(body, { partial = false } = {}) {
  const updates = {}
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k)

  if (has('businessName') || !partial) {
    const name = String(body?.businessName ?? '').trim()
    if (!name || name.length > MAX_BUSINESS_NAME) {
      return { error: `Business name is required (max ${MAX_BUSINESS_NAME} characters)` }
    }
    updates.business_name = name
  }
  if (has('description') || !partial) {
    const desc = String(body?.description ?? '').trim()
    if (desc.length > MAX_DEAL_DESCRIPTION) {
      return { error: `Description must be ${MAX_DEAL_DESCRIPTION} characters or fewer` }
    }
    updates.description = desc
  }
  if (has('category') || !partial) {
    const category = String(body?.category ?? '').trim().toLowerCase()
    if (!DEAL_CATEGORY_SET.has(category)) {
      return { error: `Category must be one of: ${DEAL_CATEGORIES.join(', ')}` }
    }
    updates.category = category
  }
  if (has('imageUrl')) {
    const url = String(body.imageUrl ?? '').trim()
    if (url && !isHttpUrl(url)) return { error: 'Image URL must be a valid http(s) link' }
    updates.image_url = url || null
  }
  if (has('address')) {
    const address = String(body.address ?? '').trim().slice(0, MAX_ADDRESS)
    updates.address = address || null
  }
  if (has('lat') || has('lng')) {
    const lat = parseCoord(body.lat, 90)
    const lng = parseCoord(body.lng, 180)
    if (!lat.ok || !lng.ok) return { error: 'Latitude/longitude are out of range' }
    const hasBoth = lat.value !== null && lng.value !== null
    updates.lat = hasBoth ? lat.value : null
    updates.lng = hasBoth ? lng.value : null
  }
  if (has('expiresAt')) {
    const raw = body.expiresAt
    if (raw === null || raw === '') {
      updates.expires_at = null
    } else {
      const t = new Date(raw)
      if (Number.isNaN(t.getTime())) return { error: 'Expiry date is invalid' }
      // A picked day is stored as 23:59 that day on campus. new Date('2026-10-31')
      // is midnight UTC, the evening of Oct 30 in Indianapolis, so the card read
      // one day early and isDealActive dropped the deal the evening before.
      const day = String(raw).trim()
      updates.expires_at = DATE_ONLY.test(day) ? endOfDayInZone(day).toISOString() : t.toISOString()
    }
  }
  if (has('featured')) updates.featured = body.featured === true || body.featured === 'true'
  if (has('active')) updates.active = !(body.active === false || body.active === 'false')

  return { value: updates }
}

/**
 * Shape a DB row for the API, adding distance from campus when coords exist.
 */
export function mapDealRow(row) {
  const hasCoords = row.lat != null && row.lng != null
  const distanceMiles = hasCoords
    ? Math.round(haversineMiles(CAMPUS_COORDS.lat, CAMPUS_COORDS.lng, row.lat, row.lng) * 10) / 10
    : null
  // Through expiryInstant, so the card and the Edit form show the picked day
  // for a deal saved before the end-of-day rule, and a re-save keeps it.
  const expiry = row.expires_at ? expiryInstant(row.expires_at) : null
  return {
    id: row.id,
    businessName: row.business_name,
    description: row.description || '',
    category: row.category,
    imageUrl: row.image_url || null,
    address: row.address || null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    distanceMiles,
    expiresAt: expiry && !Number.isNaN(expiry.getTime()) ? expiry.toISOString() : row.expires_at || null,
    featured: Boolean(row.featured),
    active: row.active !== false,
    createdAt: row.created_at,
  }
}
