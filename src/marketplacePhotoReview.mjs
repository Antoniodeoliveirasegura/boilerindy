// Marketplace photo review (issue #504). New listing photos wait for an admin
// before other students see them, behind MARKETPLACE_PHOTO_REVIEW (off by
// default), so the App Store submission can say how user-uploaded images are
// moderated (guideline 1.2, boilerindy-app#56). Listing text already has the
// word list, report and block and the admin takedown; this covers the photos.
//
// marketplace_listings.photos_review (db/supabase-marketplace-photo-review.sql,
// README step 46) holds the state. Reads apply it in mapListingRow
// (src/marketplace.mjs): until the photos are approved, only the seller and
// admins get their URLs. The admin queue in src/routes/adminPhotoReview.mjs
// approves or rejects them. The helpers that touch the database take the
// Supabase client first, like src/marketplaceDb.mjs.
//
// A database without step 46 keeps working while the switch is off: a row with
// no photos_review column reads as approved, and no write names the column
// unless the listing already holds a state only that column can store.

import { DB_FEATURES, isSchemaMissingError, logRouteError, logSchemaMissingOnce } from './dbErrors.mjs'
import { isMissingColumnError } from './moderation.mjs'

/** README step 46, named in the log by the photo_review_schema_missing answers. */
export const PHOTO_REVIEW_SQL_FILE = DB_FEATURES.photo_review.sqlFile
export const PHOTO_REVIEW_STATES = Object.freeze(['pending', 'approved', 'rejected'])
/** The admin queue's page, like the other admin lists. */
export const PHOTO_REVIEW_QUEUE_LIMIT = 200

/**
 * The review state of a listing row's photos. A row read before step 46 has
 * no photos_review column and reads as approved, like every existing listing.
 * @param {{ photos_review?: unknown } | null | undefined} row
 * @returns {'pending' | 'approved' | 'rejected'}
 */
export function photoReviewState(row) {
  const value = row?.photos_review
  return value === 'pending' || value === 'rejected' ? value : 'approved'
}

/**
 * Every photo URL on a row, cover first: the gallery, or the legacy cover alone
 * for a row from before the gallery migration.
 * @param {{ image_url?: string | null, image_urls?: string[] | null } | null | undefined} row
 * @returns {string[]}
 */
export function listingPhotoUrls(row) {
  if (Array.isArray(row?.image_urls) && row.image_urls.length) return row.image_urls
  return row?.image_url ? [row.image_url] : []
}

/**
 * The photos_review value a create or an edit writes, or undefined to leave
 * the column alone.
 *
 * - The write does not touch the photos (nextUrls undefined): unchanged.
 * - It leaves no photos: approved, since nothing is waiting any more.
 * - It adds a photo the listing did not have: pending while the switch is on,
 *   written even over pending, so an approval that lands between the edit's
 *   read and its write cannot approve the new photo. With the switch off, a
 *   rejected listing's new photos are approved (the rejected ones were
 *   cleared), and a pending listing stays pending, since photos nobody
 *   reviewed may still be on it.
 * - It keeps only photos the listing already had (reordered, or some
 *   removed): unchanged.
 *
 * @param {{ reviewOn: boolean, current?: object | null, nextUrls?: string[] }} input
 *   reviewOn is MARKETPLACE_PHOTO_REVIEW; current is the row before an edit
 *   (null for a create); nextUrls is the photo list the write stores
 * @returns {'pending' | 'approved' | undefined}
 */
export function nextPhotoReview({ reviewOn, current = null, nextUrls }) {
  if (!Array.isArray(nextUrls)) return undefined
  const state = photoReviewState(current)
  if (nextUrls.length === 0) return state === 'approved' ? undefined : 'approved'
  const before = new Set(listingPhotoUrls(current))
  if (!nextUrls.some((url) => !before.has(url))) return undefined
  if (reviewOn === true) return 'pending'
  return state === 'rejected' ? 'approved' : undefined
}

/**
 * True when the database reports that a photo review column (photos_review,
 * photos_reviewed_at or photos_reviewed_by) does not exist yet: step 46 has
 * not run.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMissingPhotoReviewColumn(err) {
  return isMissingColumnError(err, 'photos_review')
}

/**
 * One row of the admin queue: what the admin needs to judge the photos, and
 * updatedAt, which approve and reject send back so a listing the seller edited
 * after the queue loaded is never decided on photos the admin did not see.
 * @param {object} row a marketplace_listings row
 * @param {string | null} [sellerName]
 */
export function mapPhotoReviewRow(row, sellerName = null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    category: row.category,
    status: row.status,
    hidden: Boolean(row.hidden),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    images: listingPhotoUrls(row),
    seller: { id: row.user_id, displayName: sellerName },
  }
}

/**
 * The listings with photos waiting for an admin, the longest waiting first,
 * each with its seller's display name. Throws on a database error.
 * @param {object} supabase
 * @returns {Promise<ReturnType<typeof mapPhotoReviewRow>[]>}
 */
export async function listPendingPhotoReviews(supabase) {
  const { data, error } = await supabase
    .from('marketplace_listings')
    .select('*')
    .eq('photos_review', 'pending')
    .is('deleted_at', null)
    .order('updated_at', { ascending: true })
    .limit(PHOTO_REVIEW_QUEUE_LIMIT)
  if (error) throw error
  const rows = data || []
  const names = new Map()
  const sellerIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))]
  if (sellerIds.length) {
    const { data: users, error: usersError } = await supabase.from('users').select('id, display_name').in('id', sellerIds)
    if (usersError) throw usersError
    for (const user of users || []) names.set(user.id, user.display_name || null)
  }
  return rows.map((row) => mapPhotoReviewRow(row, names.get(row.user_id) ?? null))
}

/**
 * Approve or reject a listing's pending photos, as the admin saw them:
 * `updatedAt` is the listing's updated_at from the queue, and an edit since
 * then changes it, so nothing matches. A rejection clears the listing's
 * photos; the stored files stay until scripts/cleanup-marketplace-photos.mjs
 * removes the managed ones no listing references.
 * @param {object} supabase
 * @param {{ listingId: string, decision: 'approved' | 'rejected', updatedAt: string, reviewerId: string, now: string }} input
 * @returns {Promise<{ status: 200 | 404 | 409 }>} 404 when no live listing with
 *   pending photos has that id, 409 when it has pending photos but was edited
 *   after the admin loaded the queue
 */
export async function decidePhotoReview(supabase, { listingId, decision, updatedAt, reviewerId, now }) {
  const changes = { photos_review: decision, photos_reviewed_at: now, photos_reviewed_by: reviewerId }
  if (decision === 'rejected') Object.assign(changes, { image_url: null, image_urls: [] })
  const { data, error } = await supabase
    .from('marketplace_listings')
    .update(changes)
    .eq('id', listingId)
    .eq('photos_review', 'pending')
    .eq('updated_at', updatedAt)
    .is('deleted_at', null)
    .select('id')
  if (error) throw error
  if (data?.length) return { status: 200 }
  // Nothing matched: either the listing left the queue (decided, photos
  // removed, deleted) or the seller edited it after the queue loaded.
  const { data: row, error: lookupError } = await supabase
    .from('marketplace_listings')
    .select('id, photos_review')
    .eq('id', listingId)
    .is('deleted_at', null)
    .maybeSingle()
  if (lookupError) throw lookupError
  return { status: row && photoReviewState(row) === 'pending' ? 409 : 404 }
}

/**
 * How many live listings have photos waiting, for the admin overview, or null
 * when that cannot be counted (step 46 has not run, or the read failed). Never
 * throws: the overview's other counts do not depend on this one. A GET with a
 * count rather than a HEAD, because a HEAD error carries no code and a
 * missing column could not be told from an outage.
 * @param {object} supabase
 * @returns {Promise<number | null>}
 */
export async function countPendingPhotoReviews(supabase) {
  try {
    const { count, error } = await supabase
      .from('marketplace_listings')
      .select('id', { count: 'exact' })
      .eq('photos_review', 'pending')
      .is('deleted_at', null)
      .limit(1)
    if (error) throw error
    return Number.isFinite(count) ? count : 0
  } catch (err) {
    if (isMissingPhotoReviewColumn(err)) logSchemaMissingOnce(DB_FEATURES.photo_review, err)
    else if (!isSchemaMissingError(err)) logRouteError('GET /api/admin/overview pending photos', err)
    return null
  }
}
