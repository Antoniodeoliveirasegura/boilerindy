import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../../components/Icons'
import { listAdminLeads, updateAdminLead } from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader, StatusBadge } from './adminShared'
import { LEAD_STATUS_META, TABLE_HEAD_ROW, TABLE_ROW, TABLE_TH, formatDateTime } from './adminHelpers'
import PageTitle from '../../components/PageTitle'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'closed', label: 'Closed' },
]

type Lead = {
  id: string
  companyName?: string
  email: string
  message?: string
  createdAt?: string
  status: string
}

export default function AdminLeads() {
  const [filter, setFilter] = useState('new')
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = (await listAdminLeads(filter)) as { leads?: Lead[] }
      setLeads(data.leads || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load access requests.')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  async function setLeadStatus(lead: Lead, status: string) {
    setBusyId(lead.id)
    setError('')
    setSuccess('')
    try {
      const data = (await updateAdminLead(lead.id, { status })) as { lead: Lead }
      setLeads((prev) => prev.map((row) => (row.id === lead.id ? data.lead : row)))
      setSuccess(`Updated ${lead.email} → ${LEAD_STATUS_META[status]?.label || status}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update lead.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageTitle>Admin access requests</PageTitle>
      <PageHeader
        title="Access requests"
        description="Businesses requesting advertiser portal access. Review each lead, then create an account from the Advertisers tab."
        actions={
          <button type="button" onClick={load} className="btn btn-secondary btn-sm">
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        }
      />

      <AlertBanner message={error} onDismiss={() => setError('')} />
      <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />

      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`pill ${filter === value ? 'pill-active' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-[13.5px] text-[var(--color-txt-2)]">Loading requests…</div>
      ) : leads.length === 0 ? (
        <EmptyState
          icon="users"
          title="No requests in this view"
          description={filter === 'new' ? 'New advertiser access requests will appear here.' : 'Try another filter.'}
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13.5px]">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Business</th>
                  <th className={TABLE_TH}>Message</th>
                  <th className={TABLE_TH}>Submitted</th>
                  <th className={TABLE_TH}>Status</th>
                  <th className={`${TABLE_TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className={`${TABLE_ROW} align-top`}>
                    <td className="px-4 py-3.5">
                      <div className="font-display font-bold text-[14px] leading-snug text-[var(--color-txt-0)]">{lead.companyName || '-'}</div>
                      <div className="text-[12.5px] text-[var(--color-txt-2)] mt-0.5">{lead.email}</div>
                    </td>
                    <td className="px-4 py-3.5 min-w-[12rem] text-[var(--color-txt-1)]">
                      <p className="line-clamp-3 whitespace-pre-wrap leading-snug">{lead.message || '-'}</p>
                    </td>
                    <td className="px-4 py-3.5 w-[8.75rem] text-[var(--color-txt-2)] tnum">
                      {formatDateTime(lead.createdAt)}
                    </td>
                    <td className="px-4 py-3.5">
                      <StatusBadge status={lead.status} metaMap={LEAD_STATUS_META} />
                    </td>
                    <td className="px-4 py-3">
                      {/* Same place in every row: the main action (Create account)
                          on the first line, the quieter Mark contacted and Close
                          on the second. Closed rows have no actions. */}
                      {lead.status !== 'closed' && (
                        <div className="flex flex-col items-end gap-1">
                          <Link
                            to={`/admin/advertisers?lead=${encodeURIComponent(lead.id)}&email=${encodeURIComponent(lead.email)}&company=${encodeURIComponent(lead.companyName || '')}`}
                            className="btn btn-secondary btn-sm no-underline"
                          >
                            Create account
                          </Link>
                          <div className="flex justify-end gap-1">
                            {lead.status === 'new' && (
                              <button
                                type="button"
                                disabled={busyId === lead.id}
                                onClick={() => setLeadStatus(lead, 'contacted')}
                                className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50"
                              >
                                Mark contacted
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busyId === lead.id}
                              onClick={() => setLeadStatus(lead, 'closed')}
                              className="btn btn-ghost btn-sm disabled:opacity-50"
                            >
                              Close
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
