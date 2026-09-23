import { authRequest } from './authApi'

// Admin console API helpers (migrated to TypeScript, issue #20).

export function getAdminOverview(): Promise<unknown> {
  return authRequest('/api/admin/overview')
}

export function listAdminLeads(status = 'all'): Promise<unknown> {
  const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : ''
  return authRequest(`/api/admin/leads${query}`)
}

export function updateAdminLead(id: string, { status }: { status: string }): Promise<unknown> {
  return authRequest(`/api/admin/leads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export function listAdminCampaigns(status = 'all'): Promise<unknown> {
  const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : ''
  return authRequest(`/api/admin/campaigns${query}`)
}

export function updateAdminCampaign(id: string, { status }: { status: string }): Promise<unknown> {
  return authRequest(`/api/admin/campaigns/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export function listAdminAdvertisers(): Promise<unknown> {
  return authRequest('/api/admin/advertisers')
}

export function createAdminAdvertiser(input: {
  email: string
  password: string
  companyName: string
  contactName: string
  leadId?: string | null
}): Promise<unknown> {
  return authRequest('/api/admin/advertisers', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function clearAdminPurdueLink(input: {
  purdueEmail?: string
  userId?: string
}): Promise<unknown> {
  return authRequest('/api/admin/purdue-links/clear', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

// Soft-delete moderation: list content users soft-deleted, then restore it or
// permanently (hard) delete it. `type` must match the server whitelist.
export type DeletedContentType = 'board' | 'marketplace' | 'lost-found' | 'guide' | 'deals' | 'study-groups'

export function listDeletedItems(type: DeletedContentType): Promise<unknown> {
  return authRequest(`/api/admin/deleted/${type}`)
}

export function restoreDeletedItem(type: DeletedContentType, id: string): Promise<unknown> {
  return authRequest(`/api/admin/deleted/${type}/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
  })
}

export function hardDeleteItem(type: DeletedContentType, id: string): Promise<unknown> {
  return authRequest(`/api/admin/deleted/${type}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// Live-content takedown (issue #195): preview a live row by id, then remove it
// through that type's own DELETE route, which lets admins past the owner check
// (deals are admin-only already). The row lands in the deleted list, so a
// takedown is a soft delete an admin can restore.
const TAKEDOWN_PATHS: Record<DeletedContentType, string> = {
  board: '/api/board/posts',
  marketplace: '/api/marketplace',
  'lost-found': '/api/lost-found',
  guide: '/api/guide',
  deals: '/api/deals',
  'study-groups': '/api/study-groups',
}

export function getLiveContent(type: DeletedContentType, id: string): Promise<unknown> {
  return authRequest(`/api/admin/content/${type}/${encodeURIComponent(id)}`)
}

export function takeDownContent(type: DeletedContentType, id: string): Promise<unknown> {
  return authRequest(`${TAKEDOWN_PATHS[type]}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// Auto-hidden marketplace listings (issue #204). Three distinct reports hide a
// listing on their own; these routes are the only way back out. Un-hiding also
// clears that listing's reports, so the same three cannot re-hide it, and a
// takedown soft-deletes it into the deleted list above.
export function listHiddenMarketplace(): Promise<unknown> {
  return authRequest('/api/admin/hidden/marketplace')
}

export function unhideMarketplaceListing(id: string): Promise<unknown> {
  return authRequest(`/api/admin/hidden/marketplace/${encodeURIComponent(id)}/unhide`, {
    method: 'POST',
  })
}

export function takeDownHiddenListing(id: string): Promise<unknown> {
  return authRequest(`/api/admin/hidden/marketplace/${encodeURIComponent(id)}/takedown`, {
    method: 'POST',
  })
}
