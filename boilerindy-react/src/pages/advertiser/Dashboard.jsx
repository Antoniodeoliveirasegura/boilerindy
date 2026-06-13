import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../../context/ThemeContext'
import Icon from '../../components/Icons'
import {
  listCampaigns,
  createCampaign,
  updateCampaign,
  getCampaignStats,
  advertiserSignOut,
} from '../../lib/advertiserApi'

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
const PLACEMENT_LABELS = Object.fromEntries(PLACEMENTS.map((p) => [p.value, p.label]))

const STATUS_META = {
  draft: { label: 'Draft', cls: 'text-[var(--color-txt-2)] bg-[var(--color-bg-2)] border-[var(--color-border)]' },
  pending_review: { label: 'In review', cls: 'text-[var(--color-gold-dark)] bg-[var(--color-gold)]/20 border-[var(--color-gold)]/40' },
  active: { label: 'Live', cls: 'text-emerald-700 bg-emerald-500/15 border-emerald-500/30 dark:text-emerald-300' },
  paused: { label: 'Paused', cls: 'text-amber-700 bg-amber-500/15 border-amber-500/30 dark:text-amber-300' },
  ended: { label: 'Ended', cls: 'text-[var(--color-txt-3)] bg-[var(--color-bg-2)] border-[var(--color-border)]' },
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

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.draft
  return (
    <span className={`inline-flex items-center text-[11px] font-semibold px-2.5 py-1 rounded-full border ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

// Build the API payload from form state; omit blank optional fields.
function formToPayload(form) {
  const creative = {}
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

function campaignToForm(c) {
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

const inputCls =
  'w-full rounded-xl border border-[var(--color-border-2)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 transition-shadow'
const labelCls = 'block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5'

function CampaignForm({ initial, submitting, onSubmit, onCancel, title, submitLabel }) {
  const [form, setForm] = useState(initial)
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const setPhoto = (index) => (e) => setForm((f) => {
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
      className="rounded-2xl border border-[var(--color-border-2)] bg-[var(--color-surface)] p-5 sm:p-6 space-y-4"
    >
      <h3 className="text-[15px] font-bold tracking-tight">{title}</h3>

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
            <input id="cmp-starts" type="date" className={inputCls} value={form.startsOn} onChange={set('startsOn')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="cmp-ends">Ends</label>
            <input id="cmp-ends" type="date" className={inputCls} value={form.endsOn} onChange={set('endsOn')} />
          </div>
        </div>
      </div>

      <div className="pt-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-txt-3)] mb-2">Banner creative</div>
        <div className="space-y-3">
          <input className={inputCls} value={form.headline} onChange={set('headline')} placeholder="Headline (your business name)" aria-label="Headline" />
          <textarea className={`${inputCls} resize-none`} rows={2} value={form.body} onChange={set('body')} placeholder="Short description students will see" aria-label="Body" />

          <div>
            <label className={labelCls} htmlFor="cmp-website">Website URL</label>
            <input id="cmp-website" className={inputCls} value={form.ctaUrl} onChange={set('ctaUrl')} placeholder="https://yourbusiness.com" aria-label="Website URL" />
            <p className="text-[11px] text-[var(--color-txt-3)] mt-1">Students tap the banner to open this link.</p>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className={labelCls.replace('mb-1.5', 'mb-0')}>Photos (min {MIN_PHOTOS})</span>
              {isBannerPlacement && (
                <span className={`text-[11px] font-medium ${filledPhotos >= MIN_PHOTOS ? 'text-emerald-600' : 'text-[var(--color-txt-3)]'}`}>
                  {filledPhotos}/{MIN_PHOTOS}+ added
                </span>
              )}
            </div>
            <p className="text-[11px] text-[var(--color-txt-3)] mb-2">
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
                className="mt-2 text-[12px] font-semibold text-[var(--color-accent)] hover:underline cursor-pointer bg-transparent border-0 p-0"
              >
                + Add another photo
              </button>
            )}
          </div>

          <input className={inputCls} value={form.ctaLabel} onChange={set('ctaLabel')} placeholder="Link label (e.g. Visit website)" aria-label="Link label" />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center justify-center gap-2 text-[13px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-4 py-2.5 rounded-xl border-0 cursor-pointer hover:brightness-105 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center text-[13px] font-semibold text-[var(--color-txt-1)] px-4 py-2.5 rounded-xl border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] cursor-pointer transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function CampaignCard({ campaign, busy, onEdit, onStatus }) {
  const { status } = campaign
  const showStats = STATS_STATUSES.has(status)
  const [stats, setStats] = useState(null)

  // Load aggregate impression/tap stats once a campaign has been live; re-fetch
  // when its status changes (updatedAt moves) so newly-approved ones show data.
  useEffect(() => {
    if (!showStats) return undefined
    let active = true
    getCampaignStats(campaign.id)
      .then((data) => {
        if (active) setStats(data.stats)
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
  const actions = []
  if (status === 'draft') actions.push({ label: 'Submit for review', to: 'pending_review', primary: true })
  if (status === 'pending_review') actions.push({ label: 'Withdraw', to: 'draft' })
  if (status === 'active') actions.push({ label: 'Pause', to: 'paused' })
  if (status === 'paused') actions.push({ label: 'Resume', to: 'active', primary: true })
  if (status !== 'ended') actions.push({ label: 'End', to: 'ended', danger: true })

  const canEdit = status === 'draft' || status === 'paused'

  return (
    <div className="rounded-2xl border border-[var(--color-border-2)] bg-[var(--color-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold tracking-tight truncate">{campaign.name}</h3>
          <div className="text-[12px] text-[var(--color-txt-2)] mt-0.5">{PLACEMENT_LABELS[campaign.placement] || campaign.placement}</div>
        </div>
        <StatusBadge status={status} />
      </div>

      {campaign.creative?.headline && (
        <p className="text-[13px] text-[var(--color-txt-1)] mt-3 line-clamp-2">{campaign.creative.headline}</p>
      )}

      <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-txt-2)] mt-3">
        <Icon name="calendar" size={13} />
        {dateLabel}
      </div>

      {showStats && stats && (
        <div className="flex items-center gap-4 text-[12px] text-[var(--color-txt-2)] mt-3 pt-3 border-t border-[var(--color-border)]">
          <span><strong className="text-[var(--color-txt-0)] font-semibold">{stats.impressions.toLocaleString()}</strong> impressions</span>
          <span><strong className="text-[var(--color-txt-0)] font-semibold">{stats.taps.toLocaleString()}</strong> taps</span>
          <span><strong className="text-[var(--color-txt-0)] font-semibold">{(stats.ctr * 100).toFixed(1)}%</strong> CTR</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        {canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-txt-1)] px-3 py-1.5 rounded-lg border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] cursor-pointer transition-colors disabled:opacity-60"
          >
            <Icon name="edit" size={12} /> Edit
          </button>
        )}
        {actions.map((a) => (
          <button
            key={a.to}
            type="button"
            disabled={busy}
            onClick={() => onStatus(a.to)}
            className={`inline-flex items-center text-[12px] font-semibold px-3 py-1.5 rounded-lg cursor-pointer transition-colors disabled:opacity-60 ${
              a.primary
                ? 'text-[var(--color-gold-dark)] bg-[var(--color-gold)] border-0 hover:brightness-105'
                : a.danger
                  ? 'text-[var(--color-error)] border border-[var(--color-error)]/30 hover:bg-[var(--color-error)]/8'
                  : 'text-[var(--color-txt-1)] border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)]'
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function AdvertiserDashboard({ advertiser }) {
  const { dark, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const editingCampaign = useMemo(
    () => campaigns.find((c) => c.id === editingId) || null,
    [campaigns, editingId],
  )

  useEffect(() => {
    let active = true
    listCampaigns()
      .then((data) => {
        if (active) setCampaigns(data.campaigns || [])
      })
      .catch((e) => {
        if (active) setError(e.message || 'Could not load campaigns.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const handleCreate = async (form) => {
    setSubmitting(true)
    setError(null)
    try {
      const { campaign } = await createCampaign(formToPayload(form))
      setCampaigns((list) => [campaign, ...list])
      setCreating(false)
    } catch (e) {
      setError(e.message || 'Could not create campaign.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleEditSave = async (form) => {
    setSubmitting(true)
    setError(null)
    try {
      const { campaign } = await updateCampaign(editingId, formToPayload(form))
      setCampaigns((list) => list.map((c) => (c.id === campaign.id ? campaign : c)))
      setEditingId(null)
    } catch (e) {
      setError(e.message || 'Could not save campaign.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleStatus = async (id, status) => {
    setBusyId(id)
    setError(null)
    try {
      const { campaign } = await updateCampaign(id, { status })
      setCampaigns((list) => list.map((c) => (c.id === campaign.id ? campaign : c)))
    } catch (e) {
      setError(e.message || 'Could not update campaign.')
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
    <div className="min-h-screen bg-[var(--color-bg-0)] text-[var(--color-txt-0)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-1)]/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-[920px] mx-auto px-5 sm:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2 py-1 rounded-md tracking-wide">BI</span>
            <div>
              <div className="text-[14px] font-semibold leading-tight">Advertiser portal</div>
              <div className="text-[11px] text-[var(--color-txt-2)] leading-tight">{advertiser?.companyName}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] transition-colors"
            >
              <Icon name={dark ? 'sun' : 'moon'} size={16} />
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-txt-1)] px-3 py-1.5 rounded-lg border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] cursor-pointer transition-colors"
            >
              <Icon name="close" size={14} /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[920px] mx-auto px-5 sm:px-8 py-8">
        <div className="flex items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="text-[1.7rem] font-bold tracking-tight">Campaigns</h1>
            <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
              Build a banner with at least 3 photos and your website. Submit for review when ready.
            </p>
          </div>
          {!creating && !editingId && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="shrink-0 inline-flex items-center gap-2 text-[13px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-4 py-2.5 rounded-xl border-0 cursor-pointer hover:brightness-105 transition-all"
            >
              <Icon name="plus" size={15} /> New campaign
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/8 text-[var(--color-error)] p-3.5 mb-5 text-[13px]">
            {error}
          </div>
        )}

        {creating && (
          <div className="mb-6">
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
          <div className="mb-6">
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
          <div className="rounded-2xl border border-dashed border-[var(--color-border-2)] py-14 text-center">
            <div className="w-11 h-11 mx-auto rounded-xl bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/25 text-[var(--color-gold-dark)] flex items-center justify-center mb-3">
              <Icon name="rocket" size={18} />
            </div>
            <h3 className="text-[15px] font-bold">No campaigns yet</h3>
            <p className="text-[13px] text-[var(--color-txt-2)] mt-1 mb-4">Create your first campaign to get started.</p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-2 text-[13px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-4 py-2.5 rounded-xl border-0 cursor-pointer hover:brightness-105 transition-all"
            >
              <Icon name="plus" size={15} /> New campaign
            </button>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
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
      </main>
    </div>
  )
}
