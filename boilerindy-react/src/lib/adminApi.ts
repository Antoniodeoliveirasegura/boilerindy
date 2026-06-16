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
