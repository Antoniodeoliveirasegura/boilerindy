import { useEffect, useMemo, useState } from 'react'
import { authRequest } from '../lib/authApi'
import Icon from '../components/Icons'

// Standalone Lost & Found (issue #47) — its own page + table, independent of the
// campus board. Students post lost/found items, search them, and the author can
// mark a post resolved (rendered dimmed) or delete it.

const TYPE_BADGE = {
  lost: { label: 'Lost', cls: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' },
  found: { label: 'Found', cls: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' },
}

function formatWhen(dateString) {
  return new Date(dateString).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const EMPTY_FORM = { type: 'lost', title: '', description: '', location: '', contact: '' }

export default function LostFound() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [tab, setTab] = useState('all') // all | lost | found
  const [showResolved, setShowResolved] = useState(false)
  const [search, setSearch] = useState('')

  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function loadItems() {
    setLoading(true)
    try {
      const res = await authRequest('/api/lost-found')
      setItems(res.items || [])
      setUnavailable(Boolean(res.unavailable))
    } catch (e) {
      console.error('Failed to load lost & found:', e)
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await authRequest('/api/lost-found')
        if (cancelled) return
        setItems(res.items || [])
        setUnavailable(Boolean(res.unavailable))
      } catch (e) {
        if (!cancelled) {
          console.error('Failed to load lost & found:', e)
          setItems([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((item) => {
      if (tab !== 'all' && item.type !== tab) return false
      if (!showResolved && item.status === 'resolved') return false
      if (q) {
        const hay = `${item.title} ${item.description || ''} ${item.location || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, tab, showResolved, search])

  function updateForm(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!form.title.trim() || submitting) return
    setSubmitting(true)
    try {
      await authRequest('/api/lost-found', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          location: form.location.trim() || undefined,
          contact: form.contact.trim() || undefined,
        }),
      })
      setForm(EMPTY_FORM)
      await loadItems()
    } catch (err) {
      setError(err.message || 'Could not post. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleResolved(item) {
    setError('')
    try {
      await authRequest(`/api/lost-found/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: item.status === 'resolved' ? 'open' : 'resolved' }),
      })
      await loadItems()
    } catch (err) {
      setError(err.message || 'Could not update the post.')
    }
  }

  async function remove(item) {
    if (!window.confirm('Delete this post? This cannot be undone.')) return
    setError('')
    try {
      await authRequest(`/api/lost-found/${item.id}`, { method: 'DELETE' })
      await loadItems()
    } catch (err) {
      setError(err.message || 'Could not delete the post.')
    }
  }

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8 pb-24 transition-opacity duration-500 opacity-100">
      <div className="mb-6 animate-fade-in-up">
        <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Lost &amp; Found</h1>
        <p className="text-[14px] text-[var(--color-txt-2)] mt-1 max-w-[680px]">
          Report something you lost or found on campus. Mark your post resolved once it is sorted.
        </p>
        {error ? <p className="text-[13px] text-[var(--color-error)] mt-2">{error}</p> : null}
      </div>

      {unavailable && (
        <div className="card p-4 mb-4 border-amber-500/30 bg-amber-500/5 text-[13px] text-[var(--color-txt-2)] leading-relaxed">
          <span className="font-medium text-[var(--color-txt-1)]">Lost &amp; Found needs setup: </span>
          run <code className="text-[12px] px-1 rounded bg-[var(--color-stat)]">supabase-lost-found.sql</code> in the
          Supabase SQL Editor to enable posting.
        </div>
      )}

      {/* Composer */}
      <div className="card p-4 sm:p-5 mb-6 animate-fade-in-up stagger-1">
        <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">
          Post an item
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex flex-wrap gap-3 sm:items-end">
            <div className="shrink-0">
              <span className="text-[11px] text-[var(--color-txt-3)] block mb-1">Type</span>
              <div className="inline-flex p-1 rounded-xl bg-[var(--color-stat)] border border-[var(--color-border)]">
                {['lost', 'found'].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => updateForm('type', t)}
                    aria-pressed={form.type === t}
                    className={`px-4 py-2 rounded-lg text-[12px] font-semibold capitalize transition-all ${
                      form.type === t
                        ? 'bg-[var(--color-surface)] text-[var(--color-txt-0)] shadow-[var(--shadow-sm)]'
                        : 'text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label htmlFor="lf-title" className="text-[11px] text-[var(--color-txt-3)] block mb-1">Title</label>
              <input
                id="lf-title"
                type="text"
                value={form.title}
                onChange={(e) => updateForm('title', e.target.value)}
                placeholder="e.g. Black North Face backpack"
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)]"
              />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="lf-location" className="text-[11px] text-[var(--color-txt-3)] block mb-1">Location (optional)</label>
              <input
                id="lf-location"
                type="text"
                value={form.location}
                onChange={(e) => updateForm('location', e.target.value)}
                placeholder="e.g. Library 2nd floor"
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)]"
              />
            </div>
            <div>
              <label htmlFor="lf-contact" className="text-[11px] text-[var(--color-txt-3)] block mb-1">How to reach you (optional)</label>
              <input
                id="lf-contact"
                type="text"
                value={form.contact}
                onChange={(e) => updateForm('contact', e.target.value)}
                placeholder="e.g. DM on the board, or email"
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)]"
              />
            </div>
          </div>
          <div>
            <label htmlFor="lf-desc" className="text-[11px] text-[var(--color-txt-3)] block mb-1">Description (optional)</label>
            <textarea
              id="lf-desc"
              value={form.description}
              onChange={(e) => updateForm('description', e.target.value)}
              rows={2}
              placeholder="Distinguishing details, when/where, etc."
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)] resize-y"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !form.title.trim()}
            className="btn btn-primary text-[13px] px-5 py-2.5 disabled:opacity-40"
          >
            {submitting ? 'Posting…' : 'Post item'}
          </button>
        </form>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-5 animate-fade-in-up stagger-1">
        {['all', 'lost', 'found'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pill whitespace-nowrap capitalize ${tab === t ? 'pill-active' : ''}`}
          >
            {t}
          </button>
        ))}
        <span className="w-px self-stretch bg-[var(--color-border)] mx-1" aria-hidden="true" />
        <label className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)] cursor-pointer">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="w-4 h-4 rounded border-[var(--color-border-2)]"
          />
          Show resolved
        </label>
        <div className="relative ml-auto">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-txt-3)]">
            <Icon name="search" size={14} />
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items"
            aria-label="Search lost and found"
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-3 py-2 text-[13px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)]"
          />
        </div>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-[var(--color-txt-2)]">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center">
          <Icon name="search" size={28} className="mx-auto text-[var(--color-txt-3)] mb-3" />
          <div className="text-[var(--color-txt-1)] font-medium">Nothing here yet</div>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
            {search ? 'No items match your search.' : 'Be the first to post a lost or found item.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2 animate-fade-in-up stagger-2">
          {filtered.map((item) => {
            const badge = TYPE_BADGE[item.type] || TYPE_BADGE.lost
            const resolved = item.status === 'resolved'
            return (
              <div key={item.id} className={`card p-4 ${resolved ? 'opacity-60' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
                      {resolved && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-stat)] text-[var(--color-txt-2)] inline-flex items-center gap-1">
                          <Icon name="check" size={11} />
                          Resolved
                        </span>
                      )}
                      <span className="text-[11px] text-[var(--color-txt-3)]">{formatWhen(item.createdAt)}</span>
                    </div>
                    <div className={`font-medium text-[14px] mt-1.5 ${resolved ? 'line-through text-[var(--color-txt-3)]' : 'text-[var(--color-txt-0)]'}`}>
                      {item.title}
                    </div>
                    {item.description && (
                      <p className="text-[13px] text-[var(--color-txt-1)] mt-1 [overflow-wrap:anywhere]">{item.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-[12px] text-[var(--color-txt-2)] flex-wrap">
                      {item.location && (
                        <span className="flex items-center gap-1">
                          <Icon name="mapPin" size={12} />
                          {item.location}
                        </span>
                      )}
                      {item.contact && (
                        <span className="flex items-center gap-1 [overflow-wrap:anywhere]">
                          <Icon name="message" size={12} />
                          {item.contact}
                        </span>
                      )}
                    </div>
                    {item.isOwner && (
                      <div className="flex items-center gap-2 mt-3">
                        <button
                          type="button"
                          onClick={() => toggleResolved(item)}
                          className="btn btn-secondary text-[12px] px-3 py-1.5"
                        >
                          {resolved ? 'Reopen' : 'Mark resolved'}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(item)}
                          className="text-[12px] px-3 py-1.5 rounded-xl border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
