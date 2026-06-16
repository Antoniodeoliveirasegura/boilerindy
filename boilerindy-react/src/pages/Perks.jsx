import { useEffect, useMemo, useState } from 'react'
import Icon from '../components/Icons'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'

// Campus Perks (issue #24): admin-curated local student deals.
const CATEGORIES = [
  { key: 'food', label: '🍔 Food' },
  { key: 'coffee', label: '☕ Coffee' },
  { key: 'entertainment', label: '🎟️ Fun' },
  { key: 'services', label: '🛠️ Services' },
  { key: 'other', label: '✨ Other' },
]
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]))
const EMPTY_FORM = {
  id: null, businessName: '', description: '', category: 'food',
  imageUrl: '', address: '', lat: '', lng: '', expiresAt: '', featured: false, active: true,
}

export default function Perks() {
  const { user } = useAuth()
  const isAdmin = Boolean(user?.isAdmin)

  const [deals, setDeals] = useState([])
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
      .then((data) => setDeals(Array.isArray(data?.deals) ? data.deals : []))
      .catch((e) => setError(e?.message || 'Could not load deals.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let active = true
    authRequest(`/api/deals${isAdmin ? '?all=1' : ''}`)
      .then((data) => {
        if (active) setDeals(Array.isArray(data?.deals) ? data.deals : [])
      })
      .catch((e) => {
        if (active) setError(e?.message || 'Could not load deals.')
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

  function startEdit(deal) {
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
      featured: deal.featured,
      active: deal.active,
    })
    setFormError('')
    setShowForm(true)
  }

  async function submitForm(e) {
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
      setFormError(err?.message || 'Could not save the deal.')
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteDeal(deal) {
    if (!window.confirm(`Delete "${deal.businessName}"?`)) return
    setDeals((prev) => prev.filter((d) => d.id !== deal.id))
    try {
      await authRequest(`/api/deals/${deal.id}`, { method: 'DELETE' })
    } catch {
      load()
    }
  }

  return (
    <div className="max-w-[960px] mx-auto px-6 py-8 pb-24">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Campus Perks</h1>
          <p className="text-[14px] text-[var(--color-txt-2)] mt-1">Local deals and discounts for students.</p>
        </div>
        {isAdmin && (
          <button type="button" onClick={startCreate} className="btn btn-primary px-4 py-2.5 text-[13px] w-fit">
            <Icon name="plus" size={16} />
            New deal
          </button>
        )}
      </div>

      {isAdmin && showForm && (
        <form onSubmit={submitForm} className="card p-5 mb-6 space-y-3">
          <div className="text-[12px] font-semibold text-[var(--color-txt-2)]">{form.id ? 'Edit deal' : 'New deal'}</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <input value={form.businessName} onChange={(e) => setForm((f) => ({ ...f, businessName: e.target.value }))} maxLength={120} placeholder="Business name" className="input w-full text-[13px] px-3 py-2" />
            <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className="input w-full text-[13px] px-3 py-2">
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={2000} rows={2} placeholder="Description / offer details" className="input w-full text-[13px] px-3 py-2 resize-y" />
          <div className="grid sm:grid-cols-2 gap-3">
            <input value={form.imageUrl} onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))} placeholder="Image URL (optional)" className="input w-full text-[13px] px-3 py-2" />
            <input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} maxLength={200} placeholder="Address (optional)" className="input w-full text-[13px] px-3 py-2" />
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <input value={form.lat} onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))} inputMode="decimal" placeholder="Lat (optional)" className="input w-full text-[13px] px-3 py-2" />
            <input value={form.lng} onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))} inputMode="decimal" placeholder="Lng (optional)" className="input w-full text-[13px] px-3 py-2" />
            <input type="date" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} className="input w-full text-[13px] px-3 py-2" />
          </div>
          <div className="flex items-center gap-4 text-[13px] text-[var(--color-txt-1)]">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.featured} onChange={(e) => setForm((f) => ({ ...f, featured: e.target.checked }))} /> Featured</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} /> Active</label>
          </div>
          {formError && <p className="text-[12px] text-[var(--color-error)]">{formError}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={submitting} className="btn btn-primary px-4 py-2.5 text-[13px] disabled:opacity-60">{submitting ? 'Saving…' : 'Save deal'}</button>
            <button type="button" onClick={() => setShowForm(false)} className="text-[13px] px-3 py-2.5 text-[var(--color-txt-2)] hover:underline">Cancel</button>
          </div>
        </form>
      )}

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="flex flex-wrap gap-2">
          {['all', ...CATEGORIES.map((c) => c.key)].map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveCat(key)}
              className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
                activeCat === key
                  ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                  : 'border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:bg-[var(--color-stat)]'
              }`}
            >
              {key === 'all' ? 'All' : CATEGORY_LABEL[key]}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search deals…"
          className="input text-[13px] px-3 py-2 sm:ml-auto sm:w-[220px]"
        />
      </div>

      {error && <div className="card p-4 mb-4 text-[13px] text-[var(--color-error)]">{error}</div>}

      {loading ? (
        <p className="text-[13px] text-[var(--color-txt-3)]">Loading deals…</p>
      ) : filtered.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-[14px] font-medium text-[var(--color-txt-0)]">No deals right now</p>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">Check back soon for new campus perks.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {filtered.map((deal) => (
            <div key={deal.id} className={`card p-4 ${deal.featured ? 'border-[var(--color-gold)]/40 bg-[var(--color-gold)]/5' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {deal.featured && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-gold)]/15 text-[var(--color-gold-muted)] font-semibold">★ Featured</span>}
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)]">{CATEGORY_LABEL[deal.category] || deal.category}</span>
                  {!deal.active && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-error)]/10 text-[var(--color-error)]">Inactive</span>}
                </div>
                {deal.distanceMiles != null && (
                  <span className="text-[11px] text-[var(--color-txt-3)] whitespace-nowrap">{deal.distanceMiles} mi</span>
                )}
              </div>
              <h3 className="text-[15px] font-semibold text-[var(--color-txt-0)] mt-2 break-words">{deal.businessName}</h3>
              {deal.description && <p className="text-[13px] text-[var(--color-txt-1)] mt-1 whitespace-pre-wrap break-words">{deal.description}</p>}
              {deal.address && (
                <a
                  href={`https://maps.google.com/?q=${encodeURIComponent(deal.address)}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => track('deal_clicked')}
                  className="text-[12px] text-[var(--color-accent)] hover:underline flex items-center gap-1 mt-2 w-fit"
                >
                  <Icon name="mapPin" size={12} />
                  {deal.address}
                </a>
              )}
              {deal.expiresAt && (
                <div className="text-[11px] text-[var(--color-txt-3)] mt-2">Expires {new Date(deal.expiresAt).toLocaleDateString()}</div>
              )}
              {isAdmin && (
                <div className="flex gap-3 mt-3 pt-3 border-t border-[var(--color-border)]">
                  <button type="button" onClick={() => startEdit(deal)} className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)]">Edit</button>
                  <button type="button" onClick={() => deleteDeal(deal)} className="text-[12px] text-[var(--color-error)] hover:underline">Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
