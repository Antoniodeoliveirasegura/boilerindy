import { useCallback, useEffect, useState } from 'react'
import Icon from '../components/Icons'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'

// Student Marketplace (issue #32, Phase 1). No payments / no messaging — contact
// is the seller's name + Purdue email, shown on the detail panel.
const CATEGORIES = [
  'textbooks', 'furniture', 'electronics', 'housing', 'rideshare', 'tutoring', 'tickets', 'misc',
]
const EMPTY_FORM = { title: '', description: '', category: 'textbooks', price: '', imageUrl: '' }

function priceLabel(cents) {
  if (cents == null) return 'Free / contact'
  return `$${(cents / 100).toFixed(2)}`
}

export default function Marketplace() {
  const [tab, setTab] = useState('browse') // 'browse' | 'mine'
  const [listings, setListings] = useState([])
  const [mine, setMine] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [canPost, setCanPost] = useState(false)

  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  const [selected, setSelected] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    track('marketplace_viewed')
  }, [])

  const loadBrowse = useCallback((opts = {}) => {
    const cat = opts.category ?? category
    const q = opts.query ?? query
    const p = opts.page ?? page
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (cat !== 'all') params.set('category', cat)
    if (q.trim()) params.set('q', q.trim())
    if (p) params.set('page', String(p))
    authRequest(`/api/marketplace?${params.toString()}`)
      .then((data) => {
        setListings(Array.isArray(data?.listings) ? data.listings : [])
        setHasMore(Boolean(data?.hasMore))
        setCanPost(Boolean(data?.canPost))
      })
      .catch((e) => setError(e?.message || 'Could not load the marketplace.'))
      .finally(() => setLoading(false))
  }, [category, query, page])

  const loadMine = useCallback(() => {
    authRequest('/api/marketplace/mine')
      .then((data) => setMine(Array.isArray(data?.listings) ? data.listings : []))
      .catch(() => setMine([]))
  }, [])

  useEffect(() => {
    let active = true
    authRequest('/api/marketplace')
      .then((data) => {
        if (!active) return
        setListings(Array.isArray(data?.listings) ? data.listings : [])
        setHasMore(Boolean(data?.hasMore))
        setCanPost(Boolean(data?.canPost))
      })
      .catch((e) => {
        if (active) setError(e?.message || 'Could not load the marketplace.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    loadMine()
    return () => {
      active = false
    }
  }, [loadMine])

  function applyFilter(nextCat, nextQuery) {
    setCategory(nextCat)
    setQuery(nextQuery)
    setPage(0)
    loadBrowse({ category: nextCat, query: nextQuery, page: 0 })
  }

  function changePage(delta) {
    const next = Math.max(0, page + delta)
    setPage(next)
    loadBrowse({ page: next })
  }

  function openListing(listing) {
    authRequest(`/api/marketplace/${listing.id}`)
      .then((data) => setSelected(data?.listing || null))
      .catch(() => {})
  }

  async function submitForm(e) {
    e.preventDefault()
    setFormError('')
    if (!form.title.trim()) {
      setFormError('A title is required.')
      return
    }
    setSubmitting(true)
    try {
      await authRequest('/api/marketplace', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim(),
          category: form.category,
          priceCents: form.price === '' ? null : Math.round(Number(form.price) * 100),
          imageUrl: form.imageUrl.trim(),
        }),
      })
      setForm(EMPTY_FORM)
      setShowForm(false)
      loadMine()
      loadBrowse({ page: 0 })
      setPage(0)
    } catch (err) {
      setFormError(err?.message || 'Could not post your listing.')
    } finally {
      setSubmitting(false)
    }
  }

  async function markSold(listing) {
    await authRequest(`/api/marketplace/${listing.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'sold' }) }).catch(() => {})
    loadMine()
    loadBrowse({})
  }

  async function deleteListing(listing) {
    if (!window.confirm(`Delete "${listing.title}"?`)) return
    setMine((prev) => prev.filter((l) => l.id !== listing.id))
    await authRequest(`/api/marketplace/${listing.id}`, { method: 'DELETE' }).catch(() => loadMine())
    loadBrowse({})
  }

  function reportListing(listing) {
    const reason = window.prompt('Why are you reporting this listing? (optional)') ?? ''
    authRequest(`/api/marketplace/${listing.id}/report`, { method: 'POST', body: JSON.stringify({ reason }) })
      .then(() => window.alert('Thanks — our team will review it.'))
      .catch(() => {})
  }

  function listingCard(listing, context) {
    return (
      <div key={listing.id} className="card p-4 flex flex-col">
        <button type="button" onClick={() => openListing(listing)} className="text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)]">{listing.category}</span>
            <span className="text-[13px] font-semibold text-[var(--color-txt-0)]">{priceLabel(listing.priceCents)}</span>
          </div>
          <h3 className="text-[14px] font-semibold text-[var(--color-txt-0)] mt-2 break-words">
            {listing.title}
            {listing.status === 'sold' && <span className="ml-2 text-[10px] text-[var(--color-error)]">SOLD</span>}
          </h3>
          {listing.description && <p className="text-[12px] text-[var(--color-txt-2)] mt-1 line-clamp-2">{listing.description}</p>}
        </button>
        {context === 'mine' && (
          <div className="flex gap-3 mt-3 pt-3 border-t border-[var(--color-border)]">
            {listing.status !== 'sold' && (
              <button type="button" onClick={() => markSold(listing)} className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)]">Mark sold</button>
            )}
            <button type="button" onClick={() => deleteListing(listing)} className="text-[12px] text-[var(--color-error)] hover:underline">Delete</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8 pb-24">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Marketplace</h1>
          <p className="text-[14px] text-[var(--color-txt-2)] mt-1">Buy and sell with other students. Contact is shared on each listing.</p>
        </div>
        {canPost ? (
          <button type="button" onClick={() => { setShowForm((s) => !s); setTab('browse') }} className="btn btn-primary px-4 py-2.5 text-[13px] w-fit">
            <Icon name="plus" size={16} />
            {showForm ? 'Close' : 'Post a listing'}
          </button>
        ) : (
          <span className="text-[12px] text-[var(--color-txt-3)]">Link Purdue in setup to post.</span>
        )}
      </div>

      {showForm && canPost && (
        <form onSubmit={submitForm} className="card p-5 mb-6 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} maxLength={120} placeholder="Title" className="input w-full text-[13px] px-3 py-2" />
            <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className="input w-full text-[13px] px-3 py-2">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={2000} rows={3} placeholder="Description" className="input w-full text-[13px] px-3 py-2 resize-y" />
          <div className="grid sm:grid-cols-2 gap-3">
            <input value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} inputMode="decimal" placeholder="Price in $ (optional)" className="input w-full text-[13px] px-3 py-2" />
            <input value={form.imageUrl} onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))} placeholder="Image URL (optional)" className="input w-full text-[13px] px-3 py-2" />
          </div>
          {formError && <p className="text-[12px] text-[var(--color-error)]">{formError}</p>}
          <button type="submit" disabled={submitting} className="btn btn-primary px-4 py-2.5 text-[13px] disabled:opacity-60">{submitting ? 'Posting…' : 'Post listing'}</button>
        </form>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="card p-5 mb-6 border-[var(--color-accent)]/30">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)]">{selected.category}</span>
              <h2 className="text-[18px] font-semibold text-[var(--color-txt-0)] mt-1.5">{selected.title} · {priceLabel(selected.priceCents)}</h2>
            </div>
            <button type="button" onClick={() => setSelected(null)} className="text-[var(--color-txt-3)] hover:text-[var(--color-txt-0)]"><Icon name="close" size={18} /></button>
          </div>
          {selected.description && <p className="text-[13px] text-[var(--color-txt-1)] mt-2 whitespace-pre-wrap">{selected.description}</p>}
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] text-[13px]">
            <div className="text-[var(--color-txt-2)]">Contact: <span className="text-[var(--color-txt-0)] font-medium">{selected.sellerName}</span></div>
            {selected.sellerEmail && <a href={`mailto:${selected.sellerEmail}`} className="text-[var(--color-accent)] hover:underline">{selected.sellerEmail}</a>}
          </div>
          {!selected.isMine && (
            <button type="button" onClick={() => reportListing(selected)} className="text-[12px] text-[var(--color-txt-3)] hover:text-[var(--color-error)] mt-3">Report listing</button>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        {['browse', 'mine'].map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`text-[13px] px-3 py-1.5 rounded-lg border ${tab === t ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]' : 'border-[var(--color-border-2)] text-[var(--color-txt-1)]'}`}>
            {t === 'browse' ? 'Browse' : 'My listings'}
          </button>
        ))}
      </div>

      {tab === 'browse' ? (
        <>
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <div className="flex flex-wrap gap-2">
              {['all', ...CATEGORIES].map((c) => (
                <button key={c} type="button" onClick={() => applyFilter(c, query)} className={`text-[12px] px-3 py-1.5 rounded-full border ${category === c ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]' : 'border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:bg-[var(--color-stat)]'}`}>
                  {c === 'all' ? 'All' : c}
                </button>
              ))}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); applyFilter(category, query) }} className="sm:ml-auto">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="input text-[13px] px-3 py-2 w-full sm:w-[200px]" />
            </form>
          </div>

          {error && <div className="card p-4 mb-4 text-[13px] text-[var(--color-error)]">{error}</div>}

          {loading ? (
            <p className="text-[13px] text-[var(--color-txt-3)]">Loading…</p>
          ) : listings.length === 0 ? (
            <div className="card p-10 text-center">
              <p className="text-[14px] font-medium text-[var(--color-txt-0)]">No listings found</p>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1">Try another category or be the first to post.</p>
            </div>
          ) : (
            <>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{listings.map((l) => listingCard(l, 'browse'))}</div>
              <div className="flex items-center justify-between mt-5">
                <button type="button" onClick={() => changePage(-1)} disabled={page === 0} className="text-[13px] px-3 py-2 rounded-lg border border-[var(--color-border-2)] disabled:opacity-40">← Prev</button>
                <span className="text-[12px] text-[var(--color-txt-3)]">Page {page + 1}</span>
                <button type="button" onClick={() => changePage(1)} disabled={!hasMore} className="text-[13px] px-3 py-2 rounded-lg border border-[var(--color-border-2)] disabled:opacity-40">Next →</button>
              </div>
            </>
          )}
        </>
      ) : mine.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-[14px] font-medium text-[var(--color-txt-0)]">You have no listings</p>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">{canPost ? 'Post one above.' : 'Link Purdue in setup to post.'}</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{mine.map((l) => listingCard(l, 'mine'))}</div>
      )}
    </div>
  )
}
