import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../components/Icons'
import { listAdminCampaigns, updateAdminCampaign } from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader, StatusBadge } from './adminShared'
import { CAMPAIGN_STATUS_META, formatDateTime } from './adminHelpers'
import { useConfirm } from '../../hooks/useConfirm'
import PageTitle from '../../components/PageTitle'

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

// Caps label over each campaign fact: the shared eyebrow without its square,
// as a block so the value sits under it.
const DT = 'eyebrow bare flex text-[10.5px] mb-1.5'

// The confirm dialog names the action pressed. It used to reuse the target
// status's badge, asking 'Live campaign "X"?' with a button named Live, or
// 'Ended campaign "X"?' with Ended.
function statusAction(campaign: Campaign, status: string): { verb: string; button: string } {
  if (status === 'active') {
    return campaign.status === 'paused' ? { verb: 'Resume', button: 'Resume' } : { verb: 'Approve', button: 'Approve & go live' }
  }
  if (status === 'draft') return { verb: 'Send back', button: 'Send back' }
  if (status === 'paused') return { verb: 'Pause', button: 'Pause' }
  if (status === 'ended') return { verb: 'End', button: 'End' }
  const label = CAMPAIGN_STATUS_META[status]?.label || status
  return { verb: label, button: label }
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
  // Bumped by every load, so a list that arrives after a newer one was asked
  // for is dropped. A slow Pending review answer used to land after the admin
  // picked Live and show pending campaigns, Approve buttons and all, under
  // the Live pill.
  const loadSeq = useRef(0)
  // After a status change the button that was pressed is gone (the card
  // shows the new status's actions), and the confirm dialog could not give
  // it focus back because it was disabled while the change was saved, so
  // focus fell to <body> and the next Tab started at the top of the page.
  // Focus goes to the campaign's card instead.
  const cardElements = useRef(new Map<string, HTMLElement>())
  // A new object for every settled change, so the effect below runs once each.
  const [settledChange, setSettledChange] = useState<{ id: string } | null>(null)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const data = (await listAdminCampaigns(filter)) as { campaigns?: Campaign[] }
      if (seq !== loadSeq.current) return
      setCampaigns(data.campaigns || [])
    } catch (err) {
      if (seq !== loadSeq.current) return
      setError(err instanceof Error ? err.message : 'Could not load campaigns.')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!settledChange) return
    const active = document.activeElement
    if (!active || active === document.body) cardElements.current.get(settledChange.id)?.focus()
  }, [settledChange])

  async function setStatus(campaign: Campaign, status: string) {
    const label = CAMPAIGN_STATUS_META[status]?.label || status
    const { verb, button } = statusAction(campaign, status)
    // Ending cannot be undone (nothing leaves ended), so the dialog says so
    // and its button is styled as destructive.
    const ending = status === 'ended'
    const ok = await confirm({
      title: `${verb} "${campaign.name}"?`,
      message: ending ? 'An ended campaign cannot be resumed.' : undefined,
      confirmLabel: button,
      tone: ending ? 'danger' : 'default',
    })
    if (!ok) return

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
      setSettledChange({ id: campaign.id })
    }
  }

  return (
    <div>
      <PageTitle>Admin campaigns</PageTitle>
      {confirmDialog}
      <PageHeader
        title="Campaigns"
        description="Review sponsor creatives before they go live. Approve only campaigns with valid website links and at least three banner photos."
        actions={
          <button type="button" onClick={load} className="btn btn-secondary btn-sm">
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        }
      />

      <AlertBanner message={error} onDismiss={() => setError('')} />
      <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />

      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Campaign status">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={`pill ${filter === value ? 'pill-active' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-[13.5px] text-[var(--color-txt-2)]">Loading campaigns…</div>
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon="briefcase"
          title="No campaigns in this view"
          description={filter === 'pending_review' ? 'Submitted campaigns awaiting approval will appear here.' : 'Try another filter.'}
        />
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => {
            const creative: Creative = campaign.creative || {}
            const photos = creative.imageUrls?.length ? creative.imageUrls : creative.imageUrl ? [creative.imageUrl] : []
            const website = creative.ctaUrl || ''
            return (
              <article
                key={campaign.id}
                ref={(el) => {
                  if (el) cardElements.current.set(campaign.id, el)
                  else cardElements.current.delete(campaign.id)
                }}
                tabIndex={-1}
                className="card card-pad"
              >
                {/* Title row: name and status on the left, the card's actions on
                    the right, so the facts below span the full card in every
                    card whatever the action group's width. */}
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-x-4 gap-y-3 mb-4">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0 sm:min-h-[34px]">
                    <h2 className="card-title text-[17px]">{campaign.name}</h2>
                    <StatusBadge status={campaign.status} metaMap={CAMPAIGN_STATUS_META} />
                  </div>

                  <div className="flex flex-wrap gap-2 shrink-0 sm:justify-end">
                    {campaign.status === 'pending_review' && (
                      <>
                        <button
                          type="button"
                          disabled={busyId === campaign.id}
                          onClick={() => setStatus(campaign, 'active')}
                          className="btn btn-ink btn-sm"
                        >
                          Approve & go live
                        </button>
                        <button
                          type="button"
                          disabled={busyId === campaign.id}
                          onClick={() => setStatus(campaign, 'draft')}
                          className="btn btn-secondary btn-sm"
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
                        className="btn btn-secondary btn-sm"
                      >
                        Pause
                      </button>
                    )}
                    {campaign.status === 'paused' && (
                      <button
                        type="button"
                        disabled={busyId === campaign.id}
                        onClick={() => setStatus(campaign, 'active')}
                        className="btn btn-ink btn-sm"
                      >
                        Resume
                      </button>
                    )}
                    {['active', 'paused', 'pending_review'].includes(campaign.status) && (
                      <button
                        type="button"
                        disabled={busyId === campaign.id}
                        onClick={() => setStatus(campaign, 'ended')}
                        className="btn btn-danger btn-sm"
                      >
                        End
                      </button>
                    )}
                  </div>
                </div>

                {/* One template in every card: two columns, four in a row on wide
                    screens. Submitted comes before Website in the DOM too, so the
                    phone packing needs no visual reordering. */}
                <dl className="grid grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-3.5 text-[13.5px] leading-snug">
                  <div className="min-w-0 col-span-2 sm:col-span-1">
                    <dt className={DT}>Advertiser</dt>
                    <dd className="text-[var(--color-txt-0)]">{campaign.advertiserCompany || '-'}</dd>
                    <dd className="text-[12.5px] text-[var(--color-txt-2)] break-words">{campaign.advertiserEmail || '-'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={DT}>Placement</dt>
                    <dd className="text-[var(--color-txt-0)]">{PLACEMENT_LABELS[campaign.placement] || campaign.placement}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={DT}>Submitted</dt>
                    <dd className="text-[var(--color-txt-0)] tnum">{formatDateTime(campaign.updatedAt || campaign.createdAt)}</dd>
                  </div>
                  <div className="min-w-0 col-span-2 sm:col-span-1">
                    <dt className={DT}>Website</dt>
                    <dd className="truncate text-[var(--color-txt-1)]">
                      {website ? (
                        <a href={website} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline underline-offset-2">
                          {website}
                        </a>
                      ) : (
                        '-'
                      )}
                    </dd>
                  </div>
                </dl>
                {(creative.headline || creative.body) && (
                  <p className="text-[13.5px] text-[var(--color-txt-2)] mt-4 pt-3.5 border-t border-[var(--color-border)] leading-relaxed">
                    {creative.headline && <strong className="font-display font-bold text-[var(--color-txt-0)]">{creative.headline}. </strong>}
                    {creative.body}
                  </p>
                )}
                {photos.length > 0 && (
                  <div className="flex gap-2 mt-3.5 overflow-x-auto pb-1">
                    {photos.slice(0, 6).map((url, index) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 w-20 h-14 rounded-md overflow-hidden border border-[var(--color-border-2)] bg-[var(--color-stat)] hover:border-[var(--color-border-3)]"
                      >
                        <img src={url} alt={`Photo ${index + 1} of ${campaign.name}`} className="w-full h-full object-cover" loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
