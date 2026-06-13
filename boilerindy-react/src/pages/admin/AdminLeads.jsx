import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../../components/Icons'
import { listAdminLeads, updateAdminLead } from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader, StatusBadge } from './adminShared'
import { LEAD_STATUS_META, formatDateTime } from './adminHelpers'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'closed', label: 'Closed' },
]

export default function AdminLeads() {
  const [filter, setFilter] = useState('new')
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listAdminLeads(filter)
      setLeads(data.leads || [])
    } catch (err) {
      setError(err.message || 'Could not load access requests.')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  async function setLeadStatus(lead, status) {
    setBusyId(lead.id)
    setError('')
    setSuccess('')
    try {
      const data = await updateAdminLead(lead.id, { status })
      setLeads((prev) => prev.map((row) => (row.id === lead.id ? data.lead : row)))
      setSuccess(`Updated ${lead.email} → ${LEAD_STATUS_META[status]?.label || status}.`)
    } catch (err) {
      setError(err.message || 'Could not update lead.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Access requests"
        description="Businesses requesting advertiser portal access. Review each lead, then create an account from the Advertisers tab."
        actions={
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] cursor-pointer"
          >
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        }
      />

      <AlertBanner message={error} onDismiss={() => setError('')} />
      <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />

      <div className="flex flex-wrap gap-2 mb-5">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium border cursor-pointer transition-colors ${
              filter === value
                ? 'bg-[var(--color-gold)]/20 border-[var(--color-gold)]/40 text-[var(--color-gold-dark)]'
                : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-txt-2)] hover:bg-[var(--color-bg-2)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-[13px] text-[var(--color-txt-2)]">Loading requests…</div>
      ) : leads.length === 0 ? (
        <EmptyState
          title="No requests in this view"
          description={filter === 'new' ? 'New advertiser access requests will appear here.' : 'Try another filter.'}
        />
      ) : (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-2)]/60">
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)]">Business</th>
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)]">Message</th>
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)]">Submitted</th>
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)]">Status</th>
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)] text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="px-4 py-4">
                      <div className="font-medium text-[var(--color-txt-0)]">{lead.companyName || '—'}</div>
                      <div className="text-[12px] text-[var(--color-txt-2)] mt-0.5">{lead.email}</div>
                    </td>
                    <td className="px-4 py-4 text-[var(--color-txt-1)] max-w-xs">
                      <p className="line-clamp-3 whitespace-pre-wrap">{lead.message || '—'}</p>
                    </td>
                    <td className="px-4 py-4 text-[var(--color-txt-2)] whitespace-nowrap">
                      {formatDateTime(lead.createdAt)}
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge status={lead.status} metaMap={LEAD_STATUS_META} />
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap justify-end gap-2">
                        {lead.status === 'new' && (
                          <button
                            type="button"
                            disabled={busyId === lead.id}
                            onClick={() => setLeadStatus(lead, 'contacted')}
                            className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-bg-2)] cursor-pointer disabled:opacity-50"
                          >
                            Mark contacted
                          </button>
                        )}
                        {lead.status !== 'closed' && (
                          <Link
                            to={`/admin/advertisers?lead=${encodeURIComponent(lead.id)}&email=${encodeURIComponent(lead.email)}&company=${encodeURIComponent(lead.companyName || '')}`}
                            className="rounded-lg bg-[var(--color-gold)] text-[var(--color-gold-dark)] px-2.5 py-1.5 text-[12px] font-semibold no-underline hover:opacity-90"
                          >
                            Create account
                          </Link>
                        )}
                        {lead.status !== 'closed' && (
                          <button
                            type="button"
                            disabled={busyId === lead.id}
                            onClick={() => setLeadStatus(lead, 'closed')}
                            className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] text-[var(--color-txt-2)] hover:bg-[var(--color-bg-2)] cursor-pointer disabled:opacity-50"
                          >
                            Close
                          </button>
                        )}
                      </div>
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
