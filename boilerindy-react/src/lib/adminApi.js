import { authRequest } from './authApi'

export function getAdminOverview() {
  return authRequest('/api/admin/overview')
}

export function listAdminLeads(status = 'all') {
  const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : ''
  return authRequest(`/api/admin/leads${query}`)
}

export function updateAdminLead(id, { status }) {
  return authRequest(`/api/admin/leads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export function listAdminCampaigns(status = 'all') {
  const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : ''
  return authRequest(`/api/admin/campaigns${query}`)
}

export function updateAdminCampaign(id, { status }) {
  return authRequest(`/api/admin/campaigns/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export function listAdminAdvertisers() {
  return authRequest('/api/admin/advertisers')
}

export function createAdminAdvertiser({ email, password, companyName, contactName, leadId }) {
  return authRequest('/api/admin/advertisers', {
    method: 'POST',
    body: JSON.stringify({ email, password, companyName, contactName, leadId }),
  })
}

export function clearAdminPurdueLink({ purdueEmail, userId }) {
  return authRequest('/api/admin/purdue-links/clear', {
    method: 'POST',
    body: JSON.stringify({ purdueEmail, userId }),
  })
}
