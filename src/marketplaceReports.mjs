// The double write behind every marketplace listing report (issue #192).
// marketplace_reports drives the automatic hide at three distinct reporters
// (#204) and content_reports feeds the one admin queue, so a listing reported
// through POST /api/marketplace/:id/report or through POST /api/reports writes
// both, here. Plain functions taking the Supabase client first, like
// src/marketplaceDb.mjs; the caller looks the listing up and refuses a
// self-report before calling.

import { MAX_REPORT_DETAILS } from './contentReports.mjs'
import { isSchemaMissingError } from './dbErrors.mjs'
import { composeReportReason, shouldAutoHide } from './marketplace.mjs'

/**
 * Record one reporter's report of a listing.
 * @param {object} supabase
 * @param {{ listingId: string, reporterId: string, reason: string, details?: string, now: string }} report
 *   reason is one of REPORT_REASONS, details free text (cut to each table's width)
 * @returns {Promise<{ duplicate: boolean, hidden: boolean }>} duplicate when this
 *   reporter had already reported the listing (nothing is written or recounted);
 *   hidden when the listing is at or past the hide threshold after this report
 */
export async function recordListingReport(supabase, { listingId, reporterId, reason, details = '', now }) {
  const { error: insErr } = await supabase
    .from('marketplace_reports')
    .insert({ listing_id: listingId, reporter_id: reporterId, reason: composeReportReason(reason, details), created_at: now })
  // The primary key (listing_id, reporter_id) caps a reporter at one report
  // per listing, so a second one cannot move the count. Saying so saves the
  // recount round trip.
  if (insErr?.code === '23505') return { duplicate: true, hidden: false }
  if (insErr) throw insErr

  const { count } = await supabase
    .from('marketplace_reports')
    .select('reporter_id', { count: 'exact', head: true })
    .eq('listing_id', listingId)
  const hidden = shouldAutoHide(count)
  if (hidden) {
    await supabase.from('marketplace_listings').update({ hidden: true }).eq('id', listingId)
  }

  const { error: queueErr } = await supabase.from('content_reports').insert({
    target_type: 'marketplace',
    target_id: listingId,
    reporter_id: reporterId,
    reason,
    details: String(details || '').slice(0, MAX_REPORT_DETAILS),
    created_at: now,
  })
  // 23505: this reporter already has a queue entry for the listing (an admin
  // un-hide clears marketplace_reports, not the queue). A missing table means
  // README step 38 has not run yet: the report still counts toward the hide,
  // which is what the marketplace did before the queue existed.
  if (queueErr && queueErr.code !== '23505' && !isSchemaMissingError(queueErr)) throw queueErr
  return { duplicate: false, hidden }
}
