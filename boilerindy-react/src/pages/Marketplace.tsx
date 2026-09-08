import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../components/Icons'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { useConfirm } from '../hooks/useConfirm'
import {
  FORM_DEFAULT_CATEGORY,
  MARKETPLACE_CATEGORIES,
  categoryFor,
  centsToInput,
  formatPrice,
  labelForCategory,
  listingImage,
  parsePriceInput,
  type CategoryTone,
  type Listing,
} from '../lib/marketplace'
import {
  PHOTO_ACCEPT,
  PHOTO_MAX_EDGE,
  PhotoUploadError,
  formatBytes,
  isReceiptUsable,
  reuploadListingPhoto,
  uploadListingPhoto,
  type PhotoStep,
  type ReadyPhoto,
} from '../lib/marketplacePhotos'

// Student Marketplace (issue #32, Phase 1). No payments / no messaging - contact
// is the seller's name + Purdue email, shown on the detail panel. Listing photos
// (#171) go straight to Supabase Storage from the browser and are attached by a
// signed receipt; cards and the detail hero render them the way the mobile app
// does, with the category tile underneath so a broken link degrades gracefully.

const EMPTY_FORM = { title: '', description: '', category: FORM_DEFAULT_CATEGORY, price: '', imageUrl: '' }
type FormState = typeof EMPTY_FORM
type BrowseOpts = { category?: string; query?: string; page?: number }

type PhotoState =
  | { status: 'idle' }
  | { status: 'working'; step: PhotoStep; previewUrl: string | null }
  | { status: 'ready'; photo: ReadyPhoto }
  | { status: 'error'; message: string; retryable: boolean; previewUrl: string | null; file: Blob | null }

// Full class strings so Tailwind's scanner sees them.
const TONE_CLASS: Record<CategoryTone, string> = {
  map: 'bg-[var(--color-map-bg)] text-[var(--color-map-color)]',
  events: 'bg-[var(--color-events-bg)] text-[var(--color-events-color)]',
  bus: 'bg-[var(--color-bus-bg)] text-[var(--color-bus-title)]',
  dining: 'bg-[var(--color-dining-bg)] text-[var(--color-dining-color)]',
}

const STEP_TEXT: Record<PhotoStep, string> = {
  preparing: 'Preparing photo',
  authorizing: 'Getting upload permission',
  uploading: 'Uploading',
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

function formFromListing(listing: Listing): FormState {
  return {
    title: listing.title || '',
    description: listing.description || '',
    category: categoryFor(listing.category).slug,
    price: centsToInput(listing.priceCents),
    imageUrl: listing.imageUrl || '',
  }
}

function photoPreview(photo: PhotoState): string | null {
  if (photo.status === 'ready') return photo.photo.previewUrl
  if (photo.status === 'working' || photo.status === 'error') return photo.previewUrl
  return null
}

/** Category tile with the photo on top, so a slow or broken URL shows the tile. */
function ListingImage({ listing, className, iconSize = 28 }: { listing: Listing; className: string; iconSize?: number }) {
  const url = listingImage(listing)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const cat = categoryFor(listing.category)
  const showImage = Boolean(url) && failedUrl !== url
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden ${TONE_CLASS[cat.tone]} ${className}`}
      data-listing-image={showImage ? 'photo' : 'placeholder'}
    >
      <Icon name={cat.icon} size={iconSize} />
      {showImage && url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(url)}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : null}
    </div>
  )
}

type PhotoFieldProps = {
  photo: PhotoState
  currentUrl: string
  disabled: boolean
  verb: 'post' | 'save'
  linkValue: string
  onPick: (file: File) => void
  onRetry: () => void
  onRemove: () => void
  onLinkChange: (value: string) => void
}

function PhotoField({ photo, currentUrl, disabled, verb, linkValue, onPick, onRetry, onRemove, onLinkChange }: PhotoFieldProps) {
  const busy = photo.status === 'working'
  const preview = photoPreview(photo) || (photo.status === 'idle' ? currentUrl : '')
  const hasPhoto = photo.status !== 'idle' || Boolean(currentUrl)

  let message = ''
  let messageTone = 'text-[var(--color-txt-3)]'
  if (photo.status === 'working') {
    message = `${STEP_TEXT[photo.step]}…`
  } else if (photo.status === 'ready') {
    message = `Photo ready (${formatBytes(photo.photo.byteSize)}). It is attached when you ${verb}.`
    messageTone = 'text-[var(--color-success)]'
  } else if (photo.status === 'error') {
    message = photo.message
    messageTone = 'text-[var(--color-error)]'
  } else if (currentUrl) {
    message = 'Current photo. Choose another to replace it.'
  } else {
    message = `Photos are resized to ${PHOTO_MAX_EDGE} px and converted to JPEG in your browser before upload.`
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3 sm:p-4" data-photo-status={photo.status}>
      <div className="flex items-start gap-4">
        <div className="relative w-24 h-24 rounded-lg overflow-hidden bg-[var(--color-stat)] flex items-center justify-center shrink-0">
          {preview ? (
            <img src={preview} alt="" className="w-full h-full object-cover" data-photo-preview />
          ) : (
            <Icon name="image" size={26} className="text-[var(--color-txt-3)]" />
          )}
          {busy ? (
            <div className="absolute inset-0 bg-black/35 flex items-center justify-center">
              <Icon name="refresh" size={18} className="text-white animate-spin" />
            </div>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-[12px] font-semibold text-[var(--color-txt-1)]">Photo</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="listing-photo"
              type="file"
              accept={PHOTO_ACCEPT}
              className="sr-only"
              aria-label="Listing photo"
              disabled={disabled || busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onPick(file)
                e.target.value = ''
              }}
            />
            <label
              htmlFor="listing-photo"
              className={`btn btn-secondary text-[12px] px-3 py-1.5 cursor-pointer ${disabled || busy ? 'opacity-60 pointer-events-none' : ''}`}
            >
              <Icon name="camera" size={14} /> {hasPhoto ? 'Change photo' : 'Choose photo'}
            </label>
            {photo.status === 'error' && photo.retryable ? (
              <button type="button" onClick={onRetry} disabled={disabled} className="btn btn-secondary text-[12px] px-3 py-1.5">
                <Icon name="refresh" size={14} /> Retry
              </button>
            ) : null}
            {hasPhoto && !busy ? (
              <button type="button" onClick={onRemove} disabled={disabled} className="btn btn-ghost text-[12px] px-3 py-1.5 text-[var(--color-error)]">
                <Icon name="trash" size={14} /> Remove
              </button>
            ) : null}
          </div>
          <p className={`text-[12px] m-0 min-h-[1rem] ${messageTone}`} aria-live="polite" data-photo-message>
            {message}
          </p>
        </div>
      </div>
      {photo.status === 'idle' ? (
        <div className="mt-3">
          <label className="sr-only" htmlFor="listing-image-url">
            Image link
          </label>
          <input
            id="listing-image-url"
            value={linkValue}
            onChange={(e) => onLinkChange(e.target.value)}
            disabled={disabled}
            placeholder="Or paste an image link (optional)"
            className="input w-full text-[13px] px-3 py-2"
          />
        </div>
      ) : null}
    </div>
  )
}

export default function Marketplace() {
  const { confirm, confirmDialog } = useConfirm()
  const [tab, setTab] = useState('browse') // 'browse' | 'mine'
  const [listings, setListings] = useState<Listing[]>([])
  const [mine, setMine] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [canPost, setCanPost] = useState(false)

  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  const [selected, setSelected] = useState<Listing | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Listing | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [photo, setPhoto] = useState<PhotoState>({ status: 'idle' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  // Bumped whenever the photo is replaced, removed or the form closes, so a
  // pipeline still running for an earlier pick cannot land its result.
  const photoRun = useRef(0)
  const previewUrls = useRef<Set<string>>(new Set())

  const releasePreviews = useCallback((keep?: string | null) => {
    for (const url of previewUrls.current) {
      if (url === keep) continue
      URL.revokeObjectURL(url)
      previewUrls.current.delete(url)
    }
  }, [])
  useEffect(() => () => releasePreviews(), [releasePreviews])

  useEffect(() => {
    track('marketplace_viewed')
  }, [])

  const loadBrowse = useCallback(
    (opts: BrowseOpts = {}) => {
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
          const d = data as { listings?: Listing[]; hasMore?: boolean; canPost?: boolean }
          setListings(Array.isArray(d?.listings) ? d.listings : [])
          setHasMore(Boolean(d?.hasMore))
          setCanPost(Boolean(d?.canPost))
        })
        .catch((e) => setError(errorText(e, 'Could not load the marketplace.')))
        .finally(() => setLoading(false))
    },
    [category, query, page],
  )

  const loadMine = useCallback(() => {
    authRequest('/api/marketplace/mine')
      .then((data) => {
        const d = data as { listings?: Listing[] }
        setMine(Array.isArray(d?.listings) ? d.listings : [])
      })
      .catch(() => setMine([]))
  }, [])

  useEffect(() => {
    let active = true
    authRequest('/api/marketplace')
      .then((data) => {
        if (!active) return
        const d = data as { listings?: Listing[]; hasMore?: boolean; canPost?: boolean }
        setListings(Array.isArray(d?.listings) ? d.listings : [])
        setHasMore(Boolean(d?.hasMore))
        setCanPost(Boolean(d?.canPost))
      })
      .catch((e) => {
        if (active) setError(errorText(e, 'Could not load the marketplace.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    loadMine()
    return () => {
      active = false
    }
  }, [loadMine])

  function applyFilter(nextCat: string, nextQuery: string) {
    setCategory(nextCat)
    setQuery(nextQuery)
    setPage(0)
    loadBrowse({ category: nextCat, query: nextQuery, page: 0 })
  }

  function changePage(delta: number) {
    const next = Math.max(0, page + delta)
    setPage(next)
    loadBrowse({ page: next })
  }

  function openListing(listing: Listing) {
    authRequest(`/api/marketplace/${listing.id}`)
      .then((data) => {
        const d = data as { listing?: Listing }
        setSelected(d?.listing || null)
      })
      .catch(() => {})
  }

  // ── Compose / edit form ───────────────────────────────────────────────────

  function resetPhoto() {
    photoRun.current += 1
    releasePreviews()
    setPhoto({ status: 'idle' })
  }

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    resetPhoto()
    setFormError('')
    setShowForm(true)
    setTab('browse')
  }

  function openEdit(listing: Listing) {
    setEditing(listing)
    setForm(formFromListing(listing))
    resetPhoto()
    setFormError('')
    setShowForm(true)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  function closeForm() {
    setShowForm(false)
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError('')
    resetPhoto()
  }

  async function pickPhoto(file: Blob) {
    const run = ++photoRun.current
    const previewUrl = URL.createObjectURL(file)
    previewUrls.current.add(previewUrl)
    releasePreviews(previewUrl)
    setForm((f) => ({ ...f, imageUrl: '' }))
    setFormError('')
    setPhoto({ status: 'working', step: 'preparing', previewUrl })
    try {
      const ready = await uploadListingPhoto(file, {
        listingId: editing?.id,
        onStep: (step) => {
          if (photoRun.current === run) setPhoto({ status: 'working', step, previewUrl })
        },
      })
      if (photoRun.current !== run) {
        // Replaced or closed while uploading: the object is swept server-side later.
        URL.revokeObjectURL(ready.previewUrl)
        return
      }
      previewUrls.current.add(ready.previewUrl)
      releasePreviews(ready.previewUrl)
      setPhoto({ status: 'ready', photo: ready })
    } catch (err) {
      if (photoRun.current !== run) return
      const retryable = err instanceof PhotoUploadError ? err.retryable : true
      setPhoto({ status: 'error', message: errorText(err, 'Could not upload the photo.'), retryable, previewUrl, file })
    }
  }

  function retryPhoto() {
    if (photo.status === 'error' && photo.file) void pickPhoto(photo.file)
  }

  function removePhoto() {
    resetPhoto()
    setForm((f) => ({ ...f, imageUrl: '' }))
  }

  async function submitForm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError('')
    const title = form.title.trim()
    if (!title) {
      setFormError('A title is required.')
      return
    }
    const priceCents = parsePriceInput(form.price)
    if (priceCents === undefined) {
      setFormError('Enter a price like 25 or 12.50, or leave it blank for free.')
      return
    }
    if (photo.status === 'working') return
    if (photo.status === 'error') {
      setFormError(`Retry the photo upload or remove the photo before you ${editing ? 'save' : 'post'}.`)
      return
    }
    setSubmitting(true)
    try {
      let ready = photo.status === 'ready' ? photo.photo : null
      if (ready && !isReceiptUsable(ready)) {
        // The form sat open past the receipt's life: upload the same bytes again.
        const run = ++photoRun.current
        const previewUrl = ready.previewUrl
        setPhoto({ status: 'working', step: 'authorizing', previewUrl })
        ready = await reuploadListingPhoto(ready, {
          listingId: editing?.id,
          onStep: (step) => {
            if (photoRun.current === run) setPhoto({ status: 'working', step, previewUrl })
          },
        })
        if (photoRun.current !== run) return
        setPhoto({ status: 'ready', photo: ready })
      }
      const imageUrl = form.imageUrl.trim()
      const description = form.description.trim()
      if (editing) {
        const patch: Record<string, unknown> = {}
        if (title !== (editing.title || '')) patch.title = title
        if (description !== (editing.description || '')) patch.description = description
        if (form.category !== categoryFor(editing.category).slug) patch.category = form.category
        if (priceCents !== (editing.priceCents ?? null)) patch.priceCents = priceCents
        if (ready) patch.imageUploadReceipt = ready.receipt
        else if (imageUrl !== (editing.imageUrl || '')) patch.imageUrl = imageUrl
        if (Object.keys(patch).length === 0) {
          closeForm()
          return
        }
        const data = (await authRequest(`/api/marketplace/${editing.id}`, { method: 'PATCH', body: JSON.stringify(patch) })) as {
          listing?: Listing
        }
        if (data?.listing && selected?.id === editing.id) setSelected({ ...selected, ...data.listing })
      } else {
        const body: Record<string, unknown> = { title, description, category: form.category, priceCents }
        if (ready) body.imageUploadReceipt = ready.receipt
        else if (imageUrl) body.imageUrl = imageUrl
        await authRequest('/api/marketplace', { method: 'POST', body: JSON.stringify(body) })
      }
      closeForm()
      loadMine()
      loadBrowse({ page: 0 })
      setPage(0)
    } catch (err) {
      setFormError(errorText(err, editing ? 'Could not save your listing.' : 'Could not post your listing.'))
    } finally {
      setSubmitting(false)
    }
  }

  // ── Listing actions ───────────────────────────────────────────────────────

  async function markSold(listing: Listing) {
    await authRequest(`/api/marketplace/${listing.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'sold' }) }).catch(() => {})
    loadMine()
    loadBrowse({})
  }

  async function deleteListing(listing: Listing) {
    if (!(await confirm({ title: `Delete "${listing.title}"?`, confirmLabel: 'Delete', tone: 'danger' }))) return
    setMine((prev) => prev.filter((l) => l.id !== listing.id))
    if (selected?.id === listing.id) setSelected(null)
    await authRequest(`/api/marketplace/${listing.id}`, { method: 'DELETE' }).catch(() => loadMine())
    loadBrowse({})
  }

  function reportListing(listing: Listing) {
    const reason = window.prompt('Why are you reporting this listing? (optional)') ?? ''
    authRequest(`/api/marketplace/${listing.id}/report`, { method: 'POST', body: JSON.stringify({ reason }) })
      .then(() => window.alert('Thanks - our team will review it.'))
      .catch(() => {})
  }

  function listingCard(listing: Listing, context: 'browse' | 'mine') {
    return (
      <article key={listing.id} className="card p-0 overflow-hidden flex flex-col" data-listing-id={listing.id} data-listing-status={listing.status || 'active'}>
        <button type="button" onClick={() => openListing(listing)} className="text-left flex flex-col">
          <ListingImage listing={listing} className="aspect-[1.35] w-full" />
          <div className="p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[15px] font-bold text-[var(--color-txt-0)]">{formatPrice(listing.priceCents)}</span>
              {listing.status === 'sold' ? (
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-error)]/15 text-[var(--color-error)]">Sold</span>
              ) : null}
            </div>
            <h3 className="text-[13px] font-medium text-[var(--color-txt-1)] mt-1 line-clamp-2 break-words">{listing.title}</h3>
            <div className="text-[11px] text-[var(--color-txt-3)] mt-1">{labelForCategory(listing.category)}</div>
          </div>
        </button>
        {context === 'mine' ? (
          <div className="flex flex-wrap gap-3 px-3 pb-3 pt-2 mt-auto border-t border-[var(--color-border)]">
            <button type="button" onClick={() => openEdit(listing)} className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)] inline-flex items-center gap-1">
              <Icon name="edit" size={12} /> Edit
            </button>
            {listing.status !== 'sold' ? (
              <button type="button" onClick={() => markSold(listing)} className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)]">
                Mark sold
              </button>
            ) : null}
            <button type="button" onClick={() => deleteListing(listing)} className="text-[12px] text-[var(--color-error)] hover:underline">
              Delete
            </button>
          </div>
        ) : null}
      </article>
    )
  }

  const formOpen = showForm && (canPost || Boolean(editing))
  const busy = submitting || photo.status === 'working'

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8 pb-24">
      {confirmDialog}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Marketplace</h1>
          <p className="text-[14px] text-[var(--color-txt-2)] mt-1">Buy and sell with other students. Contact is shared on each listing.</p>
        </div>
        {canPost ? (
          <button type="button" onClick={() => (showForm ? closeForm() : openCreate())} className="btn btn-primary px-4 py-2.5 text-[13px] w-fit">
            <Icon name={showForm ? 'close' : 'plus'} size={16} />
            {showForm ? 'Close' : 'Post a listing'}
          </button>
        ) : (
          <span className="text-[12px] text-[var(--color-txt-3)]">Link Purdue in setup to post.</span>
        )}
      </div>

      {formOpen ? (
        <form ref={formRef} onSubmit={submitForm} className="card p-5 mb-6 space-y-3 scroll-mt-24" data-listing-form={editing ? 'edit' : 'create'}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-[var(--color-txt-0)] m-0">{editing ? 'Edit listing' : 'Post a listing'}</h2>
            {editing ? (
              <button type="button" onClick={closeForm} className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]">
                Cancel
              </button>
            ) : null}
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="sr-only" htmlFor="listing-title">
                Title
              </label>
              <input
                id="listing-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                maxLength={120}
                placeholder="What are you selling?"
                disabled={submitting}
                className="input w-full text-[13px] px-3 py-2"
              />
            </div>
            <div>
              <label className="sr-only" htmlFor="listing-price">
                Price in dollars
              </label>
              <input
                id="listing-price"
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                inputMode="decimal"
                placeholder="Price in $ (blank for free)"
                disabled={submitting}
                className="input w-full text-[13px] px-3 py-2"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Category">
            {MARKETPLACE_CATEGORIES.map((c) => (
              <button
                key={c.slug}
                type="button"
                aria-pressed={form.category === c.slug}
                onClick={() => setForm((f) => ({ ...f, category: c.slug }))}
                disabled={submitting}
                className={`text-[12px] px-3 py-1.5 rounded-full border inline-flex items-center gap-1.5 ${
                  form.category === c.slug
                    ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                    : 'border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:bg-[var(--color-stat)]'
                }`}
              >
                <Icon name={c.icon} size={12} /> {c.label}
              </button>
            ))}
          </div>
          <div>
            <label className="sr-only" htmlFor="listing-description">
              Description
            </label>
            <textarea
              id="listing-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              maxLength={2000}
              rows={3}
              placeholder="Description (condition, pickup, anything a buyer should know)"
              disabled={submitting}
              className="input w-full text-[13px] px-3 py-2 resize-y"
            />
          </div>
          <PhotoField
            photo={photo}
            currentUrl={form.imageUrl.trim()}
            disabled={submitting}
            verb={editing ? 'save' : 'post'}
            linkValue={form.imageUrl}
            onPick={(file) => void pickPhoto(file)}
            onRetry={retryPhoto}
            onRemove={removePhoto}
            onLinkChange={(value) => setForm((f) => ({ ...f, imageUrl: value }))}
          />
          {formError ? (
            <p className="text-[12px] text-[var(--color-error)]" data-form-error>
              {formError}
            </p>
          ) : null}
          <button type="submit" disabled={busy} className="btn btn-primary px-4 py-2.5 text-[13px] disabled:opacity-60">
            {submitting ? (editing ? 'Saving…' : 'Posting…') : editing ? 'Save changes' : 'Post listing'}
          </button>
        </form>
      ) : null}

      {/* Detail panel */}
      {selected ? (
        <div className="card p-5 mb-6 border-[var(--color-accent)]/30" data-listing-detail={selected.id}>
          <ListingImage listing={selected} className={`w-full rounded-xl mb-4 ${listingImage(selected) ? 'h-56 sm:h-72' : 'h-28'}`} iconSize={44} />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)]">{labelForCategory(selected.category)}</span>
              <h2 className="text-[18px] font-semibold text-[var(--color-txt-0)] mt-1.5 break-words">
                {selected.title} <span className="text-[var(--color-txt-2)] font-normal">&middot; {formatPrice(selected.priceCents)}</span>
              </h2>
            </div>
            <button type="button" onClick={() => setSelected(null)} aria-label="Close listing" className="text-[var(--color-txt-3)] hover:text-[var(--color-txt-0)]">
              <Icon name="close" size={18} />
            </button>
          </div>
          {selected.description ? <p className="text-[13px] text-[var(--color-txt-1)] mt-2 whitespace-pre-wrap">{selected.description}</p> : null}
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] text-[13px]">
            <div className="text-[var(--color-txt-2)]">
              Contact: <span className="text-[var(--color-txt-0)] font-medium">{selected.sellerName}</span>
            </div>
            {selected.sellerEmail ? (
              <a href={`mailto:${selected.sellerEmail}`} className="text-[var(--color-accent)] hover:underline">
                {selected.sellerEmail}
              </a>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-4 mt-3">
            {selected.isMine ? (
              <button type="button" onClick={() => openEdit(selected)} className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)] inline-flex items-center gap-1">
                <Icon name="edit" size={12} /> Edit listing
              </button>
            ) : (
              <button type="button" onClick={() => reportListing(selected)} className="text-[12px] text-[var(--color-txt-3)] hover:text-[var(--color-error)]">
                Report listing
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        {['browse', 'mine'].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`text-[13px] px-3 py-1.5 rounded-lg border ${
              tab === t ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]' : 'border-[var(--color-border-2)] text-[var(--color-txt-1)]'
            }`}
          >
            {t === 'browse' ? 'Browse' : 'My listings'}
          </button>
        ))}
      </div>

      {tab === 'browse' ? (
        <>
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <div className="flex flex-wrap gap-2">
              {['all', ...MARKETPLACE_CATEGORIES.map((c) => c.slug)].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => applyFilter(c, query)}
                  className={`text-[12px] px-3 py-1.5 rounded-full border ${
                    category === c
                      ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                      : 'border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:bg-[var(--color-stat)]'
                  }`}
                >
                  {c === 'all' ? 'All' : labelForCategory(c)}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                applyFilter(category, query)
              }}
              className="sm:ml-auto"
            >
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="input text-[13px] px-3 py-2 w-full sm:w-[200px]" />
            </form>
          </div>

          {error ? <div className="card p-4 mb-4 text-[13px] text-[var(--color-error)]">{error}</div> : null}

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
                <button type="button" onClick={() => changePage(-1)} disabled={page === 0} className="text-[13px] px-3 py-2 rounded-lg border border-[var(--color-border-2)] disabled:opacity-40">
                  Prev
                </button>
                <span className="text-[12px] text-[var(--color-txt-3)]">Page {page + 1}</span>
                <button type="button" onClick={() => changePage(1)} disabled={!hasMore} className="text-[13px] px-3 py-2 rounded-lg border border-[var(--color-border-2)] disabled:opacity-40">
                  Next
                </button>
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
