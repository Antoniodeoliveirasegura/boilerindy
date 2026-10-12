import { useEffect, useMemo, useState } from 'react'
import Icon from '../components/Icons'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { writeFailureMessage } from '../lib/writeFailure'
import { useConfirm } from '../hooks/useConfirm'
import PageTitle from '../components/PageTitle'

// Campus Perks (issue #24): admin-curated local student deals.
const CATEGORIES = [
  { key: 'food', label: '🍔 Food' },
  { key: 'coffee', label: '☕ Coffee' },
  { key: 'entertainment', label: '🎟️ Fun' },
  { key: 'services', label: '🛠️ Services' },
  { key: 'other', label: '✨ Other' },
]
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c.label]),
)
// The icon each deal's route badge carries, by category.
const CATEGORY_ICON: Record<string, string> = {
  food: 'dining',
  coffee: 'coffee',
  entertainment: 'star',
  services: 'briefcase',
  other: 'tag',
}

type Deal = {
  id: string
  businessName: string
  description?: string
  category: string
  imageUrl?: string
  address?: string
  lat?: number | null
  lng?: number | null
  expiresAt?: string | null
  featured?: boolean
  active?: boolean
  distanceMiles?: number | null
  [key: string]: unknown
}

type DealForm = {
  id: string | null
  businessName: string
  description: string
  category: string
  imageUrl: string
  address: string
  lat: string | number
  lng: string | number
  expiresAt: string
  featured: boolean
  active: boolean
}

const EMPTY_FORM: DealForm = {
  id: null, businessName: '', description: '', category: 'food',
  imageUrl: '', address: '', lat: '', lng: '', expiresAt: '', featured: false, active: true,
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

export default function Perks() {
  const { confirm, confirmDialog } = useConfirm()
  const { user } = useAuth()
  const isAdmin = Boolean(user?.isAdmin)

  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeCat, setActiveCat] = useState('all')
  const [query, setQuery] = useState('')

  const [form, setForm] = useState(EMPTY_FORM)
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    track('deal_viewed')
  }, [])

  function load() {
    setLoading(true)
    setError('')
    authRequest(`/api/deals${isAdmin ? '?all=1' : ''}`)
      .then((data) => {
        const d = data as { deals?: Deal[] }
        setDeals(Array.isArray(d?.deals) ? d.deals : [])
      })
      .catch((e) => setError(errorText(e, 'Could not load deals.')))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let active = true
    authRequest(`/api/deals${isAdmin ? '?all=1' : ''}`)
      .then((data) => {
        const d = data as { deals?: Deal[] }
        if (active) setDeals(Array.isArray(d?.deals) ? d.deals : [])
      })
      .catch((e) => {
        if (active) setError(errorText(e, 'Could not load deals.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [isAdmin])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return deals.filter((d) => {
      if (activeCat !== 'all' && d.category !== activeCat) return false
      if (!q) return true
      return (
        d.businessName.toLowerCase().includes(q) ||
        (d.description || '').toLowerCase().includes(q)
      )
    })
  }, [deals, activeCat, query])

  function startCreate() {
    setForm(EMPTY_FORM)
    setFormError('')
    setShowForm(true)
  }

  function startEdit(deal: Deal) {
    setForm({
      id: deal.id,
      businessName: deal.businessName,
      description: deal.description || '',
      category: deal.category,
      imageUrl: deal.imageUrl || '',
      address: deal.address || '',
      lat: deal.lat ?? '',
      lng: deal.lng ?? '',
      expiresAt: deal.expiresAt ? deal.expiresAt.slice(0, 10) : '',
      featured: deal.featured ?? false,
      active: deal.active ?? false,
    })
    setFormError('')
    setShowForm(true)
  }

  async function submitForm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError('')
    if (!form.businessName.trim()) {
      setFormError('Business name is required.')
      return
    }
    setSubmitting(true)
    const payload = {
      businessName: form.businessName.trim(),
      description: form.description.trim(),
      category: form.category,
      imageUrl: form.imageUrl.trim(),
      address: form.address.trim(),
      lat: form.lat === '' ? null : Number(form.lat),
      lng: form.lng === '' ? null : Number(form.lng),
      expiresAt: form.expiresAt || null,
      featured: form.featured,
      active: form.active,
    }
    try {
      if (form.id) {
        await authRequest(`/api/deals/${form.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      } else {
        await authRequest('/api/deals', { method: 'POST', body: JSON.stringify(payload) })
      }
      setShowForm(false)
      setForm(EMPTY_FORM)
      load()
    } catch (err) {
      setFormError(errorText(err, 'Could not save the deal.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteDeal(deal: Deal) {
    if (!(await confirm({ title: `Delete "${deal.businessName}"?`, confirmLabel: 'Delete', tone: 'danger' }))) return
    setDeals((prev) => prev.filter((d) => d.id !== deal.id))
    try {
      await authRequest(`/api/deals/${deal.id}`, { method: 'DELETE' })
    } catch (err) {
      // The reload brings the deal back; say why (load clears the banner
      // first, so set it after). Issue #202.
      load()
      setError(writeFailureMessage(err, 'Could not delete the deal. Please try again.'))
    }
  }

  return (
    <div className="page r-ink">
      <PageTitle>Campus Perks</PageTitle>
      {confirmDialog}
      <header className="page-head">
        <div>
          <h1 className="page-title">Campus Perks</h1>
          <p className="page-sub">Local deals and discounts for students.</p>
        </div>
        {isAdmin && (
          <button type="button" onClick={startCreate} className={`btn ${showForm ? 'btn-secondary' : 'btn-primary'}`}>
            <Icon name="plus" size={16} />
            New deal
          </button>
        )}
      </header>

      {isAdmin && showForm && (
        <form onSubmit={submitForm} className="card card-pad mb-6 space-y-3 max-w-[760px]">
          <div className="card-title mb-1">{form.id ? 'Edit deal' : 'New deal'}</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <input value={form.businessName} onChange={(e) => setForm((f) => ({ ...f, businessName: e.target.value }))} maxLength={120} placeholder="Business name" className="input" />
            <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className="input">
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={2000} rows={2} placeholder="Description / offer details" className="input resize-y" />
          <div className="grid sm:grid-cols-2 gap-3">
            <input value={form.imageUrl} onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))} placeholder="Image URL (optional)" className="input" />
            <input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} maxLength={200} placeholder="Address (optional)" className="input" />
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <input value={form.lat} onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))} inputMode="decimal" placeholder="Lat (optional)" className="input tnum" />
            <input value={form.lng} onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))} inputMode="decimal" placeholder="Lng (optional)" className="input tnum" />
            <input type="date" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} className="input tnum" />
          </div>
          <div className="flex items-center gap-5 text-[13px] font-semibold text-[var(--color-txt-1)]">
            <label className="flex items-center gap-2 min-h-[40px]"><input type="checkbox" className="w-4 h-4 accent-[var(--color-txt-0)]" checked={form.featured} onChange={(e) => setForm((f) => ({ ...f, featured: e.target.checked }))} /> Featured</label>
            <label className="flex items-center gap-2 min-h-[40px]"><input type="checkbox" className="w-4 h-4 accent-[var(--color-txt-0)]" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} /> Active</label>
          </div>
          {formError && <p className="text-[13px] text-[var(--color-error)]">{formError}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={submitting} className="btn btn-primary disabled:opacity-60">{submitting ? 'Saving…' : 'Save deal'}</button>
            <button type="button" onClick={() => setShowForm(false)} className="btn btn-ghost">Cancel</button>
          </div>
        </form>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex flex-wrap gap-2">
          {['all', ...CATEGORIES.map((c) => c.key)].map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveCat(key)}
              className={`pill ${activeCat === key ? 'pill-active' : ''}`}
            >
              {key === 'all' ? 'All' : CATEGORY_LABEL[key]}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search deals…"
          className="input sm:ml-auto sm:w-[240px]"
        />
      </div>

      {error && <div className="card p-4 mb-4 text-[13px] text-[var(--color-error)] border-[var(--color-error)]/30">{error}</div>}

      {loading ? (
        <p className="text-[13px] text-[var(--color-txt-3)]">Loading deals…</p>
      ) : filtered.length === 0 ? (
        <div className="empty row">
          <span className="ico shrink-0">
            <Icon name="tag" size={18} />
          </span>
          <div>
            <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No deals right now</p>
            <p className="text-[13px] mt-0.5">Check back soon for new campus perks.</p>
          </div>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          {filtered.map((deal) => (
            <div key={deal.id} className="card card-pad">
              <div className="card-head items-start last:mb-0">
                <span className="route-badge">
                  <Icon name={CATEGORY_ICON[deal.category] || 'tag'} size={18} />
                </span>
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {deal.featured && <span className="badge badge-route">★ Featured</span>}
                    <span className="chip">{CATEGORY_LABEL[deal.category] || deal.category}</span>
                    {!deal.active && <span className="badge bg-[var(--color-error)]/10 text-[var(--color-error)]">Inactive</span>}
                  </div>
                  <h3 className="text-[17px] leading-tight text-[var(--color-txt-0)] mt-2 break-words">{deal.businessName}</h3>
                </div>
                {deal.distanceMiles != null && (
                  <span className="chip shrink-0">{deal.distanceMiles} mi</span>
                )}
              </div>
              {deal.description && <p className="text-[14px] text-[var(--color-txt-1)] whitespace-pre-wrap break-words">{deal.description}</p>}
              {deal.address && (
                <a
                  href={`https://maps.google.com/?q=${encodeURIComponent(deal.address)}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => track('deal_clicked')}
                  className="text-[13px] font-display font-bold text-[var(--color-accent)] hover:underline underline-offset-[3px] flex items-center gap-1 mt-3 w-fit"
                >
                  <Icon name="mapPin" size={13} />
                  {deal.address}
                </a>
              )}
              {deal.expiresAt && (
                <div className="text-[12.5px] text-[var(--color-txt-2)] mt-2 tnum">Expires {new Date(deal.expiresAt).toLocaleDateString()}</div>
              )}
              {isAdmin && (
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-[var(--color-border)]">
                  <button type="button" onClick={() => startEdit(deal)} className="btn btn-ghost btn-sm text-[var(--color-txt-2)]">Edit</button>
                  <button type="button" onClick={() => deleteDeal(deal)} className="btn btn-ghost btn-sm text-[var(--color-error)] hover:text-[var(--color-error)]">Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
