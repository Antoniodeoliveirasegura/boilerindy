// Admin portal validation (student admins). Pure helpers for owner-only routes.

import { CAMPAIGN_STATUSES, mapCampaignRow } from './advertiserCampaign.mjs'

export const LEAD_STATUSES = ['new', 'contacted', 'closed']

/** Owner may activate campaigns and moderate any status. */
export const ADMIN_CAMPAIGN_STATUS_TRANSITIONS = {
  draft: ['pending_review', 'active', 'paused', 'ended'],
  pending_review: ['active', 'draft', 'paused', 'ended'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: [],
}

export function mapLeadRow(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    companyName: row.company_name || null,
    message: row.message || null,
    status: row.status,
    createdAt: row.created_at,
  }
}

export function mapAdminAdvertiserRow(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    companyName: row.company_name,
    contactName: row.contact_name || null,
    status: row.status,
    createdAt: row.created_at,
  }
}

export function mapAdminCampaignRow(row) {
  if (!row) return null
  const base = mapCampaignRow(row)
  const adv = row.advertisers ?? null
  return {
    ...base,
    advertiserId: row.advertiser_id,
    advertiserEmail: adv?.email ?? null,
    advertiserCompany: adv?.company_name ?? null,
  }
}

export function normalizeLeadStatusInput(status) {
  const next = typeof status === 'string' ? status.trim() : ''
  if (!LEAD_STATUSES.includes(next)) {
    throw new Error(`Lead status must be one of: ${LEAD_STATUSES.join(', ')}.`)
  }
  return next
}

export function normalizeAdminCampaignStatusInput(currentStatus, nextStatus) {
  const current = typeof currentStatus === 'string' ? currentStatus.trim() : ''
  const next = typeof nextStatus === 'string' ? nextStatus.trim() : ''
  if (!next) throw new Error('Campaign status is required.')
  if (!CAMPAIGN_STATUSES.includes(next)) {
    throw new Error('Unknown campaign status.')
  }
  if (next === current) return next
  const allowed = ADMIN_CAMPAIGN_STATUS_TRANSITIONS[current] || []
  if (!allowed.includes(next)) {
    throw new Error(`Cannot change campaign from "${current}" to "${next}".`)
  }
  return next
}

export function parseAdminListFilter(value, allowed, fallback = 'all') {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw === 'all') return fallback === 'all' ? null : fallback
  if (!allowed.includes(raw)) {
    throw new Error(`Invalid filter. Use one of: all, ${allowed.join(', ')}.`)
  }
  return raw
}
