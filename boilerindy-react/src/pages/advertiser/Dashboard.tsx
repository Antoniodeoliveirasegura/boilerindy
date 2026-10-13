import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../../context/ThemeContext'
import BrandMark from '../../components/BrandMark'
import Icon from '../../components/Icons'
import {
  listCampaigns,
  createCampaign,
  updateCampaign,
  getCampaignStats,
  advertiserSignOut,
} from '../../lib/advertiserApi'
import PageTitle from '../../components/PageTitle'

// Campaigns that have been live (or are) have stats worth showing.
const STATS_STATUSES = new Set(['active', 'paused', 'ended'])

// Advertiser campaigns dashboard (M2). Create, list, and edit campaigns.
// Activation is owner-gated: advertisers submit for review, they don't go live
// on their own. Analytics (impressions/taps) arrive in M3.

const PLACEMENTS = [
  { value: 'side-rail', label: 'Desktop side banners (recommended)' },
  { value: 'home-widget', label: 'Home dashboard widget' },
  { value: 'dining', label: 'Dining' },
  { value: 'transit', label: 'Transit' },
  { value: 'events', label: 'Events' },
]
const PLACEMENT_LABELS: Record<string, string> = Object.fromEntries(
  PLACEMENTS.map((p) => [p.value, p.label]),
)

type CampaignFormData = {
  name: string
  placement: string
  startsOn: string
  endsOn: string
  headline: string
  body: string
  ctaLabel: string
  ctaUrl: string
  photoUrls: string[]
}

type Creative = {
  headline?: string
  body?: string
  ctaLabel?: string
  ctaUrl?: string
  imageUrls?: string[]
  imageUrl?: string
}

type Campaign = {
  id: string
  name?: string
  placement?: string
  status?: string
  startsOn?: string | null
  endsOn?: string | null
  updatedAt?: string
  creative?: Creative
}

type CampaignStats = { impressions: number; taps: number; ctr: number }

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

// cls is added to the shared .badge: a route tint for the live states (Live
// green, Paused orange, In review blue), the plain stat badge for the rest.
const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: '' },
  pending_review: { label: 'In review', cls: 'badge-route r-cls' },
  active: { label: 'Live', cls: 'badge-route r-din' },
  paused: { label: 'Paused', cls: 'badge-route r-bus' },
  ended: { label: 'Ended', cls: 'text-[var(--color-txt-3)]' },
}

const MIN_PHOTOS = 3
const MAX_PHOTOS = 8

const EMPTY_FORM = {
  name: '',
  placement: 'side-rail',
  startsOn: '',
  endsOn: '',
  headline: '',
  body: '',
  ctaLabel: 'Visit website',
  ctaUrl: '',
  photoUrls: ['', '', ''],
}

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] || STATUS_META.draft
  return <span className={`badge shrink-0 ${meta.cls}`}>{meta.label}</span>
}

// Build the API payload from form state; omit blank optional fields.
function formToPayload(form: CampaignFormData) {
  const creative: Creative = {}
  if (form.headline.trim()) creative.headline = form.headline.trim()
  if (form.body.trim()) creative.body = form.body.trim()
  if (form.ctaLabel.trim()) creative.ctaLabel = form.ctaLabel.trim()
  if (form.ctaUrl.trim()) creative.ctaUrl = form.ctaUrl.trim()
  const imageUrls = (form.photoUrls || []).map((u) => u.trim()).filter(Boolean)
  if (imageUrls.length > 0) creative.imageUrls = imageUrls
  return {
    name: form.name.trim(),
    placement: form.placement,
    startsOn: form.startsOn || null,
    endsOn: form.endsOn || null,
    creative,
  }
}

function campaignToForm(c: Campaign): CampaignFormData {
  const urls = c.creative?.imageUrls?.length
    ? [...c.creative.imageUrls]
    : (c.creative?.imageUrl ? [c.creative.imageUrl] : [])
  while (urls.length < MIN_PHOTOS) urls.push('')
  return {
    name: c.name || '',
    placement: c.placement || 'side-rail',
    startsOn: c.startsOn || '',
    endsOn: c.endsOn || '',
    headline: c.creative?.headline || '',
    body: c.creative?.body || '',
    ctaLabel: c.creative?.ctaLabel || 'Visit website',
    ctaUrl: c.creative?.ctaUrl || '',
    photoUrls: urls.slice(0, MAX_PHOTOS),
  }
}

const inputCls = 'input'
const labelCls = 'block text-[13px] font-semibold text-[var(--color-txt-1)] mb-1.5'
const hintCls = 'text-[12px] leading-snug text-[var(--color-txt-3)]'

function CampaignForm({
  initial,
  submitting,
  onSubmit,
  onCancel,
  title,
  submitLabel,
}: {
  initial: CampaignFormData
  submitting: boolean
  onSubmit: (form: CampaignFormData) => void
  onCancel: () => void
  title: string
  submitLabel: string
}) {
  const [form, setForm] = useState(initial)
  const set =
    (key: keyof CampaignFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }))
  const setPhoto = (index: number) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => {
    const photoUrls = [...(f.photoUrls || [])]
    photoUrls[index] = e.target.value
    return { ...f, photoUrls }
  })
  const addPhotoSlot = () => {
    setForm((f) => {
      const photoUrls = [...(f.photoUrls || [])]
      if (photoUrls.length >= MAX_PHOTOS) return f
      return { ...f, photoUrls: [...photoUrls, ''] }
    })
  }

  const isBannerPlacement = form.placement === 'side-rail' || form.placement === 'home-widget'
  const filledPhotos = (form.photoUrls || []).filter((u) => u.trim()).length

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(form)
      }}
      className="card card-pad space-y-4"
    >
      <h3 className="card-title text-[18px]">{title}</h3>

      <div>
        <label className={labelCls} htmlFor="cmp-name">Campaign name</label>
        <input id="cmp-name" className={inputCls} value={form.name} onChange={set('name')} placeholder="Fall coffee promo" />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls} htmlFor="cmp-placement">Placement</label>
          <select id="cmp-placement" className={inputCls} value={form.placement} onChange={set('placement')}>
            {PLACEMENTS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="cmp-starts">Starts</label>
            <input id="cmp-starts" type="date" className={`${inputCls} tnum`} value={form.startsOn} onChange={set('startsOn')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="cmp-ends">Ends</label>
            <input id="cmp-ends" type="date" className={`${inputCls} tnum`} value={form.endsOn} onChange={set('endsOn')} />
          </div>
        </div>
      </div>

      <div className="pt-4 border-t border-[var(--color-border)]">
        <div className="eyebrow bare mb-3">Banner creative</div>
        <div className="space-y-3">
          <input className={inputCls} value={form.headline} onChange={set('headline')} placeholder="Headline (your business name)" aria-label="Headline" />
          <textarea className={`${inputCls} resize-none`} rows={2} value={form.body} onChange={set('body')} placeholder="Short description students will see" aria-label="Body" />

          {/* The link and its label read as one pair: the label field sits
              beside Website URL, bottom-aligned with its input. */}
          <div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px] sm:items-end">
              <div>
                <label className={labelCls} htmlFor="cmp-website">Website URL</label>
                <input id="cmp-website" className={inputCls} value={form.ctaUrl} onChange={set('ctaUrl')} placeholder="https://yourbusiness.com" aria-label="Website URL" />
              </div>
              <input className={inputCls} value={form.ctaLabel} onChange={set('ctaLabel')} placeholder="Link label (e.g. Visit website)" aria-label="Link label" />
            </div>
            <p className={`${hintCls} mt-1.5`}>Students tap the banner to open this link.</p>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className={labelCls.replace('mb-1.5', 'mb-0')}>Photos (min {MIN_PHOTOS})</span>
              {isBannerPlacement && (
                <span className={`font-display font-bold text-[12px] tnum ${filledPhotos >= MIN_PHOTOS ? 'text-[var(--color-success)]' : 'text-[var(--color-txt-3)]'}`}>
                  {filledPhotos}/{MIN_PHOTOS}+ added
                </span>
              )}
            </div>
            <p className={`${hintCls} mb-2`}>
              Paste direct image links (https://…). Side banners rotate through these photos.
            </p>
            <div className="space-y-2">
              {(form.photoUrls || []).map((url, index) => (
                <input
                  key={index}
                  className={inputCls}
                  value={url}
                  onChange={setPhoto(index)}
                  placeholder={`Photo ${index + 1} URL${index < MIN_PHOTOS ? ' (required for review)' : ''}`}
                  aria-label={`Photo ${index + 1} URL`}
                />
              ))}
            </div>
            {(form.photoUrls || []).length < MAX_PHOTOS && (
              <button
                type="button"
                onClick={addPhotoSlot}
                className="mt-1.5 inline-flex items-center min-h-[36px] max-md:min-h-[44px] font-display font-bold text-[13px] text-[var(--color-accent)] hover:underline underline-offset-2 cursor-pointer bg-transparent border-0 p-0"
              >
                + Add another photo
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" disabled={submitting} className="btn btn-primary">
          {submitting ? 'Saving…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  )
}

function CampaignCard({
  campaign,
  busy,
  onEdit,
  onStatus,
}: {
  campaign: Campaign
  busy: boolean
  onEdit: () => void
  onStatus: (status: string) => void
}) {
  const status = campaign.status || 'draft'
  const showStats = STATS_STATUSES.has(status)
  const [stats, setStats] = useState<CampaignStats | null>(null)

  // Load aggregate impression/tap stats once a campaign has been live; re-fetch
  // when its status changes (updatedAt moves) so newly-approved ones show data.
  useEffect(() => {
    if (!showStats) return undefined
    let active = true
    getCampaignStats(campaign.id)
      .then((data) => {
        const d = data as { stats?: CampaignStats }
        if (active && d.stats) setStats(d.stats)
      })
      .catch(() => {
        /* stats are non-critical */
      })
    return () => {
      active = false
    }
  }, [campaign.id, showStats, campaign.updatedAt])

  const dateLabel = campaign.startsOn
    ? `${campaign.startsOn}${campaign.endsOn ? ` → ${campaign.endsOn}` : ''}`
    : 'No dates set'

  // Status actions available to the advertiser (activation is owner-gated).
  const actions: { label: string; to: string; primary?: boolean; danger?: boolean }[] = []
  if (status === 'draft') actions.push({ label: 'Submit for review', to: 'pending_review', primary: true })
  if (status === 'pending_review') actions.push({ label: 'Withdraw', to: 'draft' })
  if (status === 'active') actions.push({ label: 'Pause', to: 'paused' })
  if (status === 'paused') actions.push({ label: 'Resume', to: 'active', primary: true })
  if (status !== 'ended') actions.push({ label: 'End', to: 'ended', danger: true })

  const canEdit = status === 'draft' || status === 'paused'

  return (
    <div className="card card-pad">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="card-title truncate">{campaign.name}</h3>
          <div className="card-sub">{PLACEMENT_LABELS[campaign.placement ?? ''] || campaign.placement}</div>
        </div>
        <StatusBadge status={status} />
      </div>

      {campaign.creative?.headline && (
        <p className="text-[13.5px] leading-snug text-[var(--color-txt-1)] mt-3 line-clamp-2">{campaign.creative.headline}</p>
      )}

      <div className="chip mt-3">
        <Icon name="calendar" size={13} />
        {dateLabel}
      </div>

      {showStats && stats && (
        // Each cell is as wide as its number or label and a cell that does not
        // fit wraps to the next line, so six- and seven-figure counts never run
        // into the next column. Numbers drop to 20px while the cards are 2-up.
        <div className="flex flex-wrap gap-x-6 gap-y-3 mt-4 pt-3.5 border-t border-[var(--color-border)]">
          <span className="flex flex-col gap-1.5"><strong className="big-stat text-[24px] sm:max-lg:text-[20px]">{stats.impressions.toLocaleString()}</strong>{' '}<span className="eyebrow bare text-[10.5px]">impressions</span></span>
          <span className="flex flex-col gap-1.5"><strong className="big-stat text-[24px] sm:max-lg:text-[20px]">{stats.taps.toLocaleString()}</strong>{' '}<span className="eyebrow bare text-[10.5px]">taps</span></span>
          <span className="flex flex-col gap-1.5"><strong className="big-stat text-[24px] sm:max-lg:text-[20px]">{(stats.ctr * 100).toFixed(1)}%</strong>{' '}<span className="eyebrow bare text-[10.5px]">CTR</span></span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        {canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            className="btn btn-secondary btn-sm"
          >
            <Icon name="edit" size={13} /> Edit
          </button>
        )}
        {actions.map((a) => (
          <button
            key={a.to}
            type="button"
            disabled={busy}
            onClick={() => onStatus(a.to)}
            className={a.primary ? 'btn btn-ink btn-sm' : a.danger ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function AdvertiserDashboard({ advertiser }: { advertiser?: { companyName?: string } }) {
  const { dark, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const editingCampaign = useMemo(
    () => campaigns.find((c) => c.id === editingId) || null,
    [campaigns, editingId],
  )

  useEffect(() => {
    let active = true
    listCampaigns()
      .then((data) => {
        const d = data as { campaigns?: Campaign[] }
        if (active) setCampaigns(d.campaigns || [])
      })
      .catch((e) => {
        if (active) setError(errorText(e, 'Could not load campaigns.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const handleCreate = async (form: CampaignFormData) => {
    setSubmitting(true)
    setError(null)
    try {
      const { campaign } = (await createCampaign(formToPayload(form))) as { campaign: Campaign }
      setCampaigns((list) => [campaign, ...list])
      setCreating(false)
    } catch (e) {
      setError(errorText(e, 'Could not create campaign.'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleEditSave = async (form: CampaignFormData) => {
    setSubmitting(true)
    setError(null)
    try {
      const { campaign } = (await updateCampaign(editingId ?? '', formToPayload(form))) as { campaign: Campaign }
      setCampaigns((list) => list.map((c) => (c.id === campaign.id ? campaign : c)))
      setEditingId(null)
    } catch (e) {
      setError(errorText(e, 'Could not save campaign.'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleStatus = async (id: string, status: string) => {
    setBusyId(id)
    setError(null)
    try {
      const { campaign } = (await updateCampaign(id, { status })) as { campaign: Campaign }
      setCampaigns((list) => list.map((c) => (c.id === campaign.id ? campaign : c)))
    } catch (e) {
      setError(errorText(e, 'Could not update campaign.'))
    } finally {
      setBusyId(null)
    }
  }

  const handleSignOut = async () => {
    try {
      await advertiserSignOut()
    } catch {
      /* clear UI regardless */
    }
    navigate('/advertise')
  }

  return (
    <div className="flex-1 text-[var(--color-txt-0)]">
      <PageTitle>Advertiser dashboard</PageTitle>
      {/* The portal's own band: the app's top bar (a paper band on a 4px ink
          rule in light, the ink band in dark), on the same 1200px edges. */}
      <header className="topbar sticky top-0 z-10">
        <div className="max-w-[1200px] mx-auto px-4 md:px-6 h-14 md:h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandMark size={32} />
            <div className="min-w-0">
              <div className="font-display font-extrabold text-[15px] leading-tight tracking-[-0.01em] truncate">Advertiser portal</div>
              <div className="text-[12px] leading-tight mt-0.5 truncate text-[var(--color-txt-2)] dark:text-[var(--color-ink-dim)]">{advertiser?.companyName}</div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="icon-btn"
            >
              <Icon name={dark ? 'sun' : 'moon'} size={18} />
            </button>
            <button type="button" onClick={handleSignOut} className="btn btn-secondary btn-sm">
              <Icon name="close" size={14} /> Sign out
            </button>
          </div>
        </div>
      </header>

      {/* PublicLayout renders the page's <main> (issue #221); this is the content column. */}
      <div className="page">
        <div className="page-head">
          <div>
            <h1 className="page-title">Campaigns</h1>
            <p className="page-sub">
              Build a banner with at least 3 photos and your website. Submit for review when ready.
            </p>
          </div>
          {!creating && !editingId && (
            <button type="button" onClick={() => setCreating(true)} className="btn btn-primary shrink-0">
              <Icon name="plus" size={16} /> New campaign
            </button>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border-[1.5px] border-[var(--color-error)]/45 bg-[var(--color-error)]/8 text-[var(--color-error)] px-3.5 py-2.5 mb-5 text-[13.5px] leading-snug"
          >
            {error}
          </div>
        )}

        {creating && (
          <div className="mb-6 max-w-[760px]">
            <CampaignForm
              initial={EMPTY_FORM}
              submitting={submitting}
              onSubmit={handleCreate}
              onCancel={() => setCreating(false)}
              title="New campaign"
              submitLabel="Create campaign"
            />
          </div>
        )}

        {editingCampaign && (
          <div className="mb-6 max-w-[760px]">
            <CampaignForm
              initial={campaignToForm(editingCampaign)}
              submitting={submitting}
              onSubmit={handleEditSave}
              onCancel={() => setEditingId(null)}
              title={`Edit “${editingCampaign.name}”`}
              submitLabel="Save changes"
            />
          </div>
        )}

        {loading ? (
          <div className="text-[14px] text-[var(--color-txt-2)] py-12 text-center">Loading campaigns…</div>
        ) : campaigns.length === 0 && !creating ? (
          <div className="empty items-center text-center px-6 py-12">
            <span className="ico">
              <Icon name="rocket" size={18} />
            </span>
            <h3 className="text-[17px] text-[var(--color-txt-0)]">No campaigns yet</h3>
            <p className="-mt-1.5">Create your first campaign to get started.</p>
            <button type="button" onClick={() => setCreating(true)} className="btn btn-secondary mt-1">
              <Icon name="plus" size={16} /> New campaign
            </button>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
            {campaigns.map((c) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                busy={busyId === c.id}
                onEdit={() => {
                  setCreating(false)
                  setEditingId(c.id)
                }}
                onStatus={(status) => handleStatus(c.id, status)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
