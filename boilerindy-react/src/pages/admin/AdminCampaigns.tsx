import { useCallback, useEffect, useState } from 'react'
import Icon from '../../components/Icons'
import { listAdminCampaigns, updateAdminCampaign } from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader, StatusBadge } from './adminShared'
import { CAMPAIGN_STATUS_META, formatDateTime } from './adminHelpers'
import { useConfirm } from '../../hooks/useConfirm'

const FILTERS = [
  { value: 'pending_review', label: 'Pending review' },
  { value: 'active', label: 'Live' },
  { value: 'paused', label: 'Paused' },
  { value: 'all', label: 'All' },
]

const PLACEMENT_LABELS: Record<string, string> = {
  'side-rail': 'Side banners',
  'home-widget': 'Home widget',
  dining: 'Dining',
  transit: 'Transit',
  events: 'Events',
}

type Creative = {
  imageUrls?: string[]
  imageUrl?: string
  ctaUrl?: string
  headline?: string
  body?: string
}
type Campaign = {
  id: string
  name: string
  status: string
  advertiserCompany?: string
  advertiserEmail?: string
  placement: string
  updatedAt?: string
  createdAt?: string
  creative?: Creative
}

export default function AdminCampaigns() {
  const { confirm, confirmDialog } = useConfirm()
  const [filter, setFilter] = useState('pending_review')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = (await listAdminCampaigns(filter)) as { campaigns?: Campaign[] }
      setCampaigns(data.campaigns || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load campaigns.')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  async function setStatus(campaign: Campaign, status: string) {
    const label = CAMPAIGN_STATUS_META[status]?.label || status
    if (!(await confirm({ title: `${label} campaign "${campaign.name}"?`, confirmLabel: label }))) return

    setBusyId(campaign.id)
    setError('')
    setSuccess('')
    try {
      const data = (await updateAdminCampaign(campaign.id, { status })) as { campaign: Campaign }
      setCampaigns((prev) => prev.map((row) => (row.id === campaign.id ? data.campaign : row)))
      setSuccess(`"${campaign.name}" is now ${label.toLowerCase()}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update campaign.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      {confirmDialog}
      <PageHeader
        title="Campaigns"
        description="Review sponsor creatives before they go live. Approve only campaigns with valid website links and at least three banner photos."
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
        <div className="text-[13px] text-[var(--color-txt-2)]">Loading campaigns…</div>
      ) : campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns in this view"
          description={filter === 'pending_review' ? 'Submitted campaigns awaiting approval will appear here.' : 'Try another filter.'}
        />
      ) : (
        <div className="space-y-4">
          {campaigns.map((campaign) => {
            const creative: Creative = campaign.creative || {}
            const photos = creative.imageUrls?.length ? creative.imageUrls : creative.imageUrl ? [creative.imageUrl] : []
            const website = creative.ctaUrl || ''
            return (
              <article
                key={campaign.id}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
              >
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <h2 className="text-[15px] font-semibold text-[var(--color-txt-0)]">{campaign.name}</h2>
                      <StatusBadge status={campaign.status} metaMap={CAMPAIGN_STATUS_META} />
                    </div>
                    <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
                      <div>
                        <dt className="text-[var(--color-txt-3)]">Advertiser</dt>
                        <dd className="text-[var(--color-txt-1)]">{campaign.advertiserCompany || '—'}</dd>
                        <dd className="text-[var(--color-txt-2)]">{campaign.advertiserEmail || '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-txt-3)]">Placement</dt>
                        <dd className="text-[var(--color-txt-1)]">{PLACEMENT_LABELS[campaign.placement] || campaign.placement}</dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-txt-3)]">Website</dt>
                        <dd className="truncate">
                          {website ? (
                            <a href={website} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">
                              {website}
                            </a>
                          ) : (
                            '—'
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-txt-3)]">Submitted</dt>
                        <dd className="text-[var(--color-txt-1)]">{formatDateTime(campaign.updatedAt || campaign.createdAt)}</dd>
                      </div>
                    </dl>
                    {(creative.headline || creative.body) && (
                      <p className="text-[13px] text-[var(--color-txt-2)] mt-3 leading-relaxed">
                        {creative.headline && <strong className="text-[var(--color-txt-1)]">{creative.headline}. </strong>}
                        {creative.body}
                      </p>
                    )}
                    {photos.length > 0 && (
                      <div className="flex gap-2 mt-4 overflow-x-auto pb-1">
                        {photos.slice(0, 6).map((url) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 w-20 h-14 rounded-lg overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-2)]"
                          >
                            <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 shrink-0">
                    {campaign.status === 'pending_review' && (
                      <>
                        <button
                          type="button"
                          disabled={busyId === campaign.id}
                          onClick={() => setStatus(campaign, 'active')}
                          className="rounded-xl bg-emerald-600 text-white px-3.5 py-2 text-[12px] font-semibold hover:bg-emerald-700 cursor-pointer disabled:opacity-50"
                        >
                          Approve & go live
                        </button>
                        <button
                          type="button"
                          disabled={busyId === campaign.id}
                          onClick={() => setStatus(campaign, 'draft')}
                          className="rounded-xl border border-[var(--color-border)] px-3.5 py-2 text-[12px] hover:bg-[var(--color-bg-2)] cursor-pointer disabled:opacity-50"
                        >
                          Send back
                        </button>
                      </>
                    )}
                    {campaign.status === 'active' && (
                      <button
                        type="button"
                        disabled={busyId === campaign.id}
                        onClick={() => setStatus(campaign, 'paused')}
                        className="rounded-xl border border-[var(--color-border)] px-3.5 py-2 text-[12px] hover:bg-[var(--color-bg-2)] cursor-pointer disabled:opacity-50"
                      >
                        Pause
                      </button>
                    )}
                    {campaign.status === 'paused' && (
                      <button
                        type="button"
                        disabled={busyId === campaign.id}
                        onClick={() => setStatus(campaign, 'active')}
                        className="rounded-xl bg-[var(--color-gold)] text-[var(--color-gold-dark)] px-3.5 py-2 text-[12px] font-semibold hover:opacity-90 cursor-pointer disabled:opacity-50"
                      >
                        Resume
                      </button>
                    )}
                    {['active', 'paused', 'pending_review'].includes(campaign.status) && (
                      <button
                        type="button"
                        disabled={busyId === campaign.id}
                        onClick={() => setStatus(campaign, 'ended')}
                        className="rounded-xl border border-[var(--color-error)]/30 text-[var(--color-error)] px-3.5 py-2 text-[12px] hover:bg-[var(--color-error)]/8 cursor-pointer disabled:opacity-50"
                      >
                        End
                      </button>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
