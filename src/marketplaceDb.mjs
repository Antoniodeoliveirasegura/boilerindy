// Marketplace database helpers (issue #191), shared by src/routes/marketplace.mjs
// and the admin hidden-listing routes in server.mjs. The two readers take the
// Supabase client first, so both callers pass the one they hold.

import { DB_FEATURES, respondSchemaMissing, respondSoftDeleteFeatureDbError } from './dbErrors.mjs'
import { isMissingGalleryPricingColumn, MARKETPLACE_GALLERY_PRICING_SQL_FILE } from './marketplace.mjs'
import { PhotoError, respondPhotoError } from './marketplacePhotos.mjs'

// The caller's own live listing, or null; throws on a database error.
export async function findOwnedMarketplaceListing(supabase, id, userId) {
  const { data, error } = await supabase.from('marketplace_listings').select('*')
    .eq('id', id).eq('user_id', userId).is('deleted_at', null).maybeSingle()
  if (error) throw error
  return data
}

// Reports per listing, for the owner's "hidden after reports" notice and the
// admin review list. marketplace_reports has no id column and PostgREST cannot
// group, so the rows come back and are counted here; the caller only ever asks
// about listings it is already showing.
export async function countMarketplaceReports(supabase, listingIds) {
  const counts = new Map()
  if (!listingIds.length) return counts
  const { data, error } = await supabase
    .from('marketplace_reports')
    .select('listing_id, reason')
    .in('listing_id', listingIds)
  if (error) throw error
  for (const row of data || []) {
    const entry = counts.get(row.listing_id) || { count: 0, reasons: [] }
    entry.count += 1
    if (row.reason) entry.reasons.push(row.reason)
    counts.set(row.listing_id, entry)
  }
  return counts
}

// A missing image_urls or price_mode column also answers marketplace_schema_missing,
// with the gallery and pricing migration named in the log, since the base
// marketplace file does not add them (#218).
export function respondMarketplaceDbError(res, err) {
  if (err instanceof PhotoError) return respondPhotoError(res, err)
  if (isMissingGalleryPricingColumn(err)) {
    return respondSchemaMissing(res, { ...DB_FEATURES.marketplace, sqlFile: MARKETPLACE_GALLERY_PRICING_SQL_FILE }, err)
  }
  return respondSoftDeleteFeatureDbError(res, err, DB_FEATURES.marketplace)
}
