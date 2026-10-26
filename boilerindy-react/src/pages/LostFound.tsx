import { useEffect, useMemo, useState } from 'react'
import { authRequest } from '../lib/authApi'
import Icon from '../components/Icons'
import { useConfirm } from '../hooks/useConfirm'
import { useEntrance } from '../hooks/useEntrance'
import { useReportAndBlock } from '../hooks/useReportAndBlock'
import PageTitle from '../components/PageTitle'
import StatusBanner from '../components/StatusBanner'

// Standalone Lost & Found (issue #47) - its own page + table, independent of the
// campus board. Students post lost/found items, search them, and the author can
// mark a post resolved (rendered dimmed) or delete it. Everyone else can report
// the post or block its author (issue #192).

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  lost: { label: 'Lost', cls: 'bg-[var(--color-error)]/12 text-[var(--color-error)]' },
  found: { label: 'Found', cls: '' },
}

type LostFoundItem = {
  id: string
  type?: string
  title?: string
  description?: string
  location?: string
  contact?: string
  status?: string
  createdAt?: string
  isOwner?: boolean
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

// The posted date as a departures-style date block (month caps over the day,
// hidden from assistive tech) plus the one readable label, e.g. "Oct 5".
function whenParts(dateString: string | undefined) {
  if (!dateString) return null
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return null
  return {
    month: date.toLocaleDateString(undefined, { month: 'short' }),
    day: String(date.getDate()),
    label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  }
}

const EMPTY_FORM = { type: 'lost', title: '', description: '', location: '', contact: '' }

// The server trims each field and cuts it to these lengths (cleanField in
// src/routes/lostFound.mjs). The inputs stop at the same lengths, so a long
// title is no longer accepted here and then saved cut short without a word.
const MAX_TITLE = 200
const MAX_DESCRIPTION = 2000
const MAX_LOCATION = 200
const MAX_CONTACT = 200

// A failed read used to show "Nothing here yet. Be the first to post", and
// the server's `unavailable` answer (sent for any database error, not only a
// missing table) added the operator's SQL setup step. Students now get one of
// these in place of the list, with a way to read it again, and the composer
// waits while the board is unavailable.
const LOAD_ERROR = 'Could not load Lost & Found posts.'
const UNAVAILABLE = 'Lost & Found is temporarily unavailable. Try again in a few minutes.'

export default function LostFound() {
  const { confirm, confirmDialog } = useConfirm()
  const { report, blockAuthor, moderationUi } = useReportAndBlock()
  const [items, setItems] = useState<LostFoundItem[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState('all') // all | lost | found
  const [showResolved, setShowResolved] = useState(false)
  const [search, setSearch] = useState('')

  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  // Each write error shows where the student acted: a post's next to the Post
  // item button, a row action's in that row. They all used to sit in the page
  // header, which on a phone is about 1,000px above the composer and most rows.
  const [formError, setFormError] = useState('')
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)

  async function loadItems() {
    setLoading(true)
    try {
      const res = (await authRequest('/api/lost-found')) as {
        items?: LostFoundItem[]
        unavailable?: boolean
      }
      setItems(res.items || [])
      setUnavailable(Boolean(res.unavailable))
      setLoadError('')
    } catch (e) {
      console.error('Failed to load lost & found:', e)
      setItems([])
      setLoadError(LOAD_ERROR)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = (await authRequest('/api/lost-found')) as {
          items?: LostFoundItem[]
          unavailable?: boolean
        }
        if (cancelled) return
        setItems(res.items || [])
        setUnavailable(Boolean(res.unavailable))
      } catch (e) {
        if (!cancelled) {
          console.error('Failed to load lost & found:', e)
          setItems([])
          setLoadError(LOAD_ERROR)
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

  // The posts rise in when the list lands and when a tab, Show resolved or the
  // search swaps them (hooks/useEntrance).
  const rowsRef = useEntrance<HTMLOListElement>(!loading, `${tab}|${showResolved}|${search.trim().toLowerCase()}`)

  function updateForm(field: keyof typeof EMPTY_FORM, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError('')
    if (!form.title.trim() || submitting || unavailable) return
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
      setFormError(errorText(err, 'Could not post. Please try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleResolved(item: LostFoundItem) {
    setRowError(null)
    try {
      await authRequest(`/api/lost-found/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: item.status === 'resolved' ? 'open' : 'resolved' }),
      })
      await loadItems()
    } catch (err) {
      setRowError({ id: item.id, message: errorText(err, 'Could not update the post.') })
    }
  }

  async function remove(item: LostFoundItem) {
    if (!(await confirm({ title: 'Delete this post?', message: 'This removes your post from the board.', confirmLabel: 'Delete', tone: 'danger' }))) return
    setRowError(null)
    try {
      await authRequest(`/api/lost-found/${item.id}`, { method: 'DELETE' })
      await loadItems()
    } catch (err) {
      setRowError({ id: item.id, message: errorText(err, 'Could not delete the post.') })
    }
  }

  // A blocked author's posts leave the list, so it is read again.
  async function handleBlockAuthor(item: LostFoundItem) {
    if (await blockAuthor('lost_found', item.id)) await loadItems()
  }

  const fieldLabel = 'text-[13px] font-semibold text-[var(--color-txt-1)] block mb-1.5'

  return (
    <div className="page r-ink">
      <PageTitle>Lost & Found</PageTitle>
      {confirmDialog}
      {moderationUi}
      <header className="page-head">
        <div>
          <h1 className="page-title">Lost &amp; Found</h1>
          <p className="page-sub max-w-[680px]">
            Report something you lost or found on campus. Mark your post resolved once it is sorted.
          </p>
        </div>
      </header>

      {/* The feed (filters and list) and the composer: two columns from lg,
          so the list keeps to its column instead of running 1152px wide. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px] lg:gap-6 lg:items-start">
        <div className="min-w-0">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {['all', 'lost', 'found'].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`pill whitespace-nowrap capitalize ${tab === t ? 'pill-active' : ''}`}
              >
                {t}
              </button>
            ))}
            <span className="w-px self-stretch bg-[var(--color-border-2)] mx-1.5" aria-hidden="true" />
            <label className="flex items-center gap-2 min-h-[40px] text-[14px] text-[var(--color-txt-1)] cursor-pointer">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-txt-0)]"
              />
              Show resolved
            </label>
            <div className="relative w-full lg:w-[240px] lg:ml-auto">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-txt-2)] pointer-events-none">
                <Icon name="search" size={15} />
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search items"
                aria-label="Search lost and found"
                className="input pl-10 lg:min-h-[40px] lg:py-2"
              />
            </div>
          </div>

          {loading ? (
            <div className="card card-pad text-[14px] text-[var(--color-txt-2)]">Loading…</div>
          ) : loadError || unavailable ? (
            <div className="card card-pad space-y-3">
              <StatusBanner tone="error">{loadError || UNAVAILABLE}</StatusBanner>
              <button type="button" onClick={() => void loadItems()} className="btn btn-secondary btn-sm">
                Try again
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty row">
              <span className="ico">
                <Icon name="search" size={18} />
              </span>
              <div>
                <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">Nothing here yet</div>
                <p className="mt-0.5">
                  {search ? 'No items match your search.' : 'Be the first to post a lost or found item.'}
                </p>
              </div>
            </div>
          ) : (
            <section className="card px-5 max-sm:px-4 py-1">
              <ol ref={rowsRef} className="dep">
                {filtered.map((item) => {
                  const badge = TYPE_BADGE[item.type || 'lost'] || TYPE_BADGE.lost
                  const resolved = item.status === 'resolved'
                  const when = whenParts(item.createdAt)
                  return (
                    <li key={item.id} className={resolved ? 'opacity-60' : undefined}>
                      <div className="dep-row items-start py-4 max-sm:gap-y-2.5">
                        {when ? (
                          <span className="when" aria-hidden="true">
                            <span>{when.month}</span>
                            <b>{when.day}</b>
                          </span>
                        ) : (
                          <span className="when text-[var(--color-txt-2)]" aria-hidden="true">
                            <Icon name="tag" size={18} />
                          </span>
                        )}
                        <div className="body max-sm:col-span-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`badge ${badge.cls}`}>{badge.label}</span>
                            {resolved && (
                              <span className="badge">
                                <Icon name="check" size={11} />
                                Resolved
                              </span>
                            )}
                            {when ? (
                              <time className="sr-only" dateTime={item.createdAt}>
                                {when.label}
                              </time>
                            ) : null}
                          </div>
                          <div className={`ttl mt-1.5 ${resolved ? 'line-through text-[var(--color-txt-3)]' : ''}`}>
                            {item.title}
                          </div>
                          {item.description && (
                            <p className="text-[14px] leading-relaxed text-[var(--color-txt-1)] mt-1 max-w-[62ch] [overflow-wrap:anywhere]">{item.description}</p>
                          )}
                          {(item.location || item.contact) && (
                            <div className="meta flex items-center gap-x-4 gap-y-1 mt-1.5 flex-wrap">
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
                          )}
                          {!item.isOwner && (
                            <div className="mod-actions">
                              <button
                                type="button"
                                onClick={(e) => report({ targetType: 'lost_found', targetId: item.id, targetLabel: 'this post' }, e.currentTarget)}
                              >
                                <Icon name="flag" size={13} /> Report
                              </button>
                              <button type="button" onClick={() => void handleBlockAuthor(item)}>
                                Block author
                              </button>
                            </div>
                          )}
                          {rowError?.id === item.id && (
                            <StatusBanner tone="error" className="mt-2.5">
                              {rowError.message}
                            </StatusBanner>
                          )}
                        </div>
                        {item.isOwner && (
                          <div className="flex flex-wrap items-center gap-2 max-sm:col-start-2">
                            <button
                              type="button"
                              onClick={() => toggleResolved(item)}
                              className="btn btn-secondary btn-sm"
                            >
                              {resolved ? 'Reopen' : 'Mark resolved'}
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(item)}
                              className="btn btn-danger btn-sm"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </section>
          )}
        </div>

        {/* Composer: a side card from lg (sticky under the nav), after the
            list below lg, so the feed is what a visitor sees first. */}
        <section className="card card-pad max-lg:mt-6 lg:sticky lg:top-24">
          <div className="card-head">
            <span className="route-badge" aria-hidden="true">
              <Icon name="tag" size={18} />
            </span>
            <div className="card-title">
              Post an item
            </div>
          </div>
          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div className="grid gap-3.5 sm:grid-cols-[auto_minmax(0,1fr)] lg:grid-cols-1 sm:items-end">
              <div>
                <span className={fieldLabel}>Type</span>
                <div className="flex gap-2">
                  {['lost', 'found'].map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => updateForm('type', t)}
                      aria-pressed={form.type === t}
                      className={`pill capitalize min-h-[44px] px-4 ${form.type === t ? 'pill-active' : ''}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label htmlFor="lf-title" className={fieldLabel}>Title</label>
                <input
                  id="lf-title"
                  type="text"
                  value={form.title}
                  onChange={(e) => updateForm('title', e.target.value)}
                  maxLength={MAX_TITLE}
                  placeholder="e.g. Black North Face backpack"
                  className="input"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-1 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-1">
                <div>
                  <label htmlFor="lf-location" className={fieldLabel}>Location (optional)</label>
                  <input
                    id="lf-location"
                    type="text"
                    value={form.location}
                    onChange={(e) => updateForm('location', e.target.value)}
                    maxLength={MAX_LOCATION}
                    placeholder="e.g. Library 2nd floor"
                    className="input"
                  />
                </div>
                <div>
                  <label htmlFor="lf-contact" className={fieldLabel}>How to reach you (optional)</label>
                  <input
                    id="lf-contact"
                    type="text"
                    value={form.contact}
                    onChange={(e) => updateForm('contact', e.target.value)}
                    maxLength={MAX_CONTACT}
                    placeholder="e.g. DM on the board, or email"
                    className="input"
                  />
                </div>
              </div>
            </div>
            {formError && <StatusBanner tone="error">{formError}</StatusBanner>}
            <div className="flex flex-col gap-3.5 sm:flex-row sm:items-end lg:flex-col lg:items-stretch">
              <div className="flex-1 min-w-0 lg:flex-none">
                <label htmlFor="lf-desc" className={fieldLabel}>Description (optional)</label>
                <textarea
                  id="lf-desc"
                  value={form.description}
                  onChange={(e) => updateForm('description', e.target.value)}
                  maxLength={MAX_DESCRIPTION}
                  rows={2}
                  placeholder="Distinguishing details, when/where, etc."
                  className="input resize-y block"
                />
              </div>
              <button
                type="submit"
                disabled={submitting || unavailable || !form.title.trim()}
                className="btn btn-primary w-fit shrink-0"
              >
                {submitting ? 'Posting…' : 'Post item'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  )
}
