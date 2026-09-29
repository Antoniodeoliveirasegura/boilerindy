// Reporting content (issue #192): one report shape for every surface students
// post to, a board post or reply, a lost and found item, a guide
// recommendation, a study group, a marketplace listing, or a user. Pure, so
// the rules are unit-tested without the database, and shared with the website:
// boilerindy-react reads REPORT_REASONS (here, or re-exported by
// src/marketplace.mjs) so the report dialog and the API offer one list.
// db/supabase-report-and-block.sql checks the same values.

import { isUuid } from './httpGuards.mjs'

/** Why a student reports something; content_reports.reason CHECKs this list. */
export const REPORT_REASONS = ['spam', 'scam', 'harassment', 'prohibited', 'other']
const REPORT_REASON_SET = new Set(REPORT_REASONS)

/** content_reports.details is CHECK (char_length(details) <= 500). */
export const MAX_REPORT_DETAILS = 500

/**
 * Where each reportable thing lives: its table, the column naming its author,
 * whether the table has deleted_at (soft delete, issue #195), and the column
 * the admin queue shows as its title. Keys are content_reports.target_type.
 */
export const REPORT_TARGETS = Object.freeze({
  board_post: Object.freeze({ table: 'board_posts', authorColumn: 'user_id', softDelete: true, titleColumn: 'title' }),
  board_reply: Object.freeze({ table: 'board_replies', authorColumn: 'user_id', softDelete: false, titleColumn: 'body' }),
  lost_found: Object.freeze({ table: 'lost_found_items', authorColumn: 'user_id', softDelete: true, titleColumn: 'title' }),
  guide: Object.freeze({ table: 'guide_recommendations', authorColumn: 'user_id', softDelete: true, titleColumn: 'title' }),
  study_group: Object.freeze({ table: 'study_groups', authorColumn: 'creator_id', softDelete: true, titleColumn: 'title' }),
  marketplace: Object.freeze({ table: 'marketplace_listings', authorColumn: 'user_id', softDelete: true, titleColumn: 'title' }),
  user: Object.freeze({ table: 'users', authorColumn: 'id', softDelete: false, titleColumn: 'display_name' }),
})

/** Every target type, in the order content_reports.target_type CHECKs them. */
export const REPORT_TARGET_TYPES = Object.freeze(Object.keys(REPORT_TARGETS))

/** The states a report moves through; an admin closes an open one. */
export const REPORT_STATUSES = Object.freeze(['open', 'resolved', 'dismissed'])

/**
 * Validate a POST /api/reports body. The target id is lowercased so it compares
 * equal to the ids the database hands back (the self-report check needs that).
 * Details are optional for every reason, trimmed and cut to fit the column.
 * @param {{ targetType?: unknown, targetId?: unknown, reason?: unknown, details?: unknown }} body
 * @returns {{ ok: true, value: { targetType: string, targetId: string, reason: string, details: string } }
 *   | { ok: false, message: string }}
 */
export function parseContentReport(body) {
  const targetType = String(body?.targetType ?? '').trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(REPORT_TARGETS, targetType)) {
    return { ok: false, message: 'Choose what you are reporting.' }
  }
  const targetId = String(body?.targetId ?? '').trim().toLowerCase()
  if (!isUuid(targetId)) return { ok: false, message: 'That id is not valid.' }
  const reason = String(body?.reason ?? '').trim().toLowerCase()
  if (!reason) return { ok: false, message: 'Choose a reason for the report.' }
  if (!REPORT_REASON_SET.has(reason)) {
    return { ok: false, message: `Reason must be one of: ${REPORT_REASONS.join(', ')}.` }
  }
  const details = String(body?.details ?? '').trim().slice(0, MAX_REPORT_DETAILS)
  return { ok: true, value: { targetType, targetId, reason, details } }
}
