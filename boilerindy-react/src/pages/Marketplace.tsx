import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icons'
import { authRequest, type ApiRequestError } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { useConfirm } from '../hooks/useConfirm'
import { useEntrance } from '../hooks/useEntrance'
import { useReportAndBlock } from '../hooks/useReportAndBlock'
import {
  FORM_DEFAULT_CATEGORY,
  MARKETPLACE_CATEGORIES,
  MAX_LISTING_PHOTOS,
  PRICE_MODES,
  categoryFor,
  centsToInput,
  formatPrice,
  labelForCategory,
  listingImage,
  listingImages,
  ownerPhotoNote,
  parseImageLinks,
  parsePriceInput,
  photosAwaitReview,
  priceModeOf,
  type Listing,
  type PriceMode,
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
import PageTitle from '../components/PageTitle'

// Student Marketplace (issue #32, Phase 1). No payments / no messaging - contact
// is the seller's name + Purdue email, shown on the detail panel. Listing photos
// (#171) go straight to Supabase Storage from the browser and are attached by a
// signed receipt; a listing carries up to six ordered photos with the first as
// the cover, and a price is a set amount, Free, or Best offer (#177). Cards and
// the detail gallery render photos the way the mobile app does. Photos that
// wait for an admin (#504) reach other students as a placeholder, and their
// owner gets a note.

const EMPTY_FORM = { title: '', description: '', category: FORM_DEFAULT_CATEGORY, price: '', priceMode: 'fixed' as PriceMode, imageLinks: '' }
type FormState = typeof EMPTY_FORM
type BrowseOpts = { category?: string; query?: string; page?: number }
type PhotoRef = { url: string } | { receipt: string }

type PhotoState =
  | { status: 'idle' }
  | { status: 'working'; step: PhotoStep; previewUrl: string | null }
  | { status: 'ready'; photo: ReadyPhoto }
  | { status: 'error'; message: string; retryable: boolean; previewUrl: string | null; file: Blob | null }

const STEP_TEXT: Record<PhotoStep, string> = {
  preparing: 'Preparing photo',
  authorizing: 'Getting upload permission',
  uploading: 'Uploading',
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

function formFromListing(listing: Listing): FormState {
  const priceMode = priceModeOf(listing)
  return {
    title: listing.title || '',
    description: listing.description || '',
    category: categoryFor(listing.category).slug,
    price: priceMode === 'fixed' ? centsToInput(listing.priceCents) : '',
    priceMode,
    imageLinks: listingImages(listing).join('\n'),
  }
}

/** What the API stores for a price: Free is zero, Best offer is null, a set price is cents or unspecified. */
function priceCentsFor(priceMode: PriceMode, price: string): number | null | undefined {
  if (priceMode === 'free') return 0
  if (priceMode === 'best_offer') return null
  return parsePriceInput(price)
}

function photoPreview(photo: PhotoState): string | null {
  if (photo.status === 'ready') return photo.photo.previewUrl
  if (photo.status === 'working' || photo.status === 'error') return photo.previewUrl
  return null
}

/**
 * Category tile with the cover on top, so a slow or broken URL shows the tile.
 * Photos that wait for an admin (#504) come with no URLs for other students:
 * the tile then says so instead of passing for a listing without photos.
 */
function ListingImage({ listing, className }: { listing: Listing; className: string }) {
  const url = listingImage(listing)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const cat = categoryFor(listing.category)
  const showImage = Boolean(url) && failedUrl !== url
  const underReview = photosAwaitReview(listing)
  return (
    <div
      className={`relative flex flex-col items-center justify-center gap-2 overflow-hidden bg-[var(--color-stat)] ${className}`}
      data-listing-image={showImage ? 'photo' : underReview ? 'pending' : 'placeholder'}
    >
      <span className="route-badge lg" aria-hidden="true">
        <Icon name={underReview ? 'clock' : cat.icon} size={22} />
      </span>
      {underReview ? <span className="px-2 text-center text-[12px] font-semibold leading-tight text-[var(--color-txt-2)]">Photos under review</span> : null}
      {showImage && url ? (
        <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailedUrl(url)} className="absolute inset-0 w-full h-full object-cover" />
      ) : null}
    </div>
  )
}

/** Every photo of a listing, cover first, the way the app's detail screen shows them. */
function ListingGallery({ listing }: { listing: Listing }) {
  const images = listingImages(listing)
  if (images.length === 0) return <ListingImage listing={listing} className="w-full rounded-[var(--radius-lg)] mb-4 h-32" />
  const title = listing.title || 'Listing'
  return (
    <div className="flex gap-3 overflow-x-auto mb-4 -mx-1 px-1 pb-1" data-listing-gallery={images.length}>
      {images.map((url, i) => (
        <img
          key={url}
          src={url}
          alt={`${title} photo ${i + 1}`}
          loading={i === 0 ? 'eager' : 'lazy'}
          decoding="async"
          className={`rounded-[var(--radius-lg)] object-cover bg-[var(--color-stat)] shrink-0 ${images.length === 1 ? 'w-full h-56 sm:h-72' : 'h-48 sm:h-64 max-w-[85%]'}`}
        />
      ))}
    </div>
  )
}

/** The owner's note about their own listing's photos (#504): waiting for an admin, or removed by one. */
function PhotoNote({ listing, className = '' }: { listing: Listing; className?: string }) {
  const note = ownerPhotoNote(listing)
  if (!note) return null
  const pending = listing.photosPending === true
  return (
    <div
      className={`text-[12.5px] flex items-start gap-1.5 ${pending ? 'text-[var(--color-txt-2)]' : 'text-[var(--color-error)]'} ${className}`}
      data-photos-note={pending ? 'pending' : 'rejected'}
    >
      <Icon name={pending ? 'clock' : 'info'} size={13} className="mt-0.5 shrink-0" />
      <span>{note}</span>
    </div>
  )
}

type PhotoFieldProps = {
  photo: PhotoState
  disabled: boolean
  verb: 'post' | 'save'
  links: string
  onPick: (file: File) => void
  onRetry: () => void
  onRemove: () => void
  onLinksChange: (value: string) => void
}

function PhotoField({ photo, disabled, verb, links, onPick, onRetry, onRemove, onLinksChange }: PhotoFieldProps) {
  const busy = photo.status === 'working'
  const linkUrls = parseImageLinks(links)
  const preview = photoPreview(photo) || linkUrls[0] || ''
  const hasPicked = photo.status !== 'idle'
  const count = linkUrls.length + (photo.status === 'ready' ? 1 : 0)

  let message: string
  let messageTone = 'text-[var(--color-txt-2)]'
  if (photo.status === 'working') {
    message = `${STEP_TEXT[photo.step]}…`
  } else if (photo.status === 'ready') {
    message = `Photo ready (${formatBytes(photo.photo.byteSize)}). It is the cover when you ${verb}.`
    messageTone = 'text-[var(--color-success)]'
  } else if (photo.status === 'error') {
    message = photo.message
    messageTone = 'text-[var(--color-error)]'
  } else if (linkUrls.length) {
    message = `${linkUrls.length} photo${linkUrls.length === 1 ? '' : 's'} from links. Upload one to make it the cover.`
  } else {
    message = `Photos are resized to ${PHOTO_MAX_EDGE} px and converted to JPEG in your browser before upload.`
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border-2)] p-3 sm:p-4" data-photo-status={photo.status} data-photo-count={count}>
      <div className="flex items-start gap-4">
        <div className="relative w-24 h-24 rounded-[var(--radius-md)] overflow-hidden bg-[var(--color-stat)] flex items-center justify-center shrink-0">
          {preview ? <img src={preview} alt="" className="w-full h-full object-cover" data-photo-preview /> : <Icon name="image" size={26} className="text-[var(--color-txt-3)]" />}
          {busy ? (
            <div className="absolute inset-0 bg-[var(--color-ink)]/60 flex items-center justify-center">
              <Icon name="refresh" size={18} className="text-[var(--color-ink-txt)] animate-spin" />
            </div>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="text-[13px] font-semibold text-[var(--color-txt-1)]">Photos (up to {MAX_LISTING_PHOTOS}, the first is the cover)</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="listing-photo"
              type="file"
              accept={PHOTO_ACCEPT}
              className="peer sr-only"
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
              className={`btn btn-secondary btn-sm cursor-pointer peer-focus-visible:outline-3 peer-focus-visible:outline-[var(--color-gold)] peer-focus-visible:outline-offset-2 peer-focus-visible:shadow-[0_0_0_2px_var(--color-txt-0)] ${disabled || busy ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <Icon name="camera" size={14} /> {hasPicked ? 'Change photo' : 'Upload a photo'}
            </label>
            {photo.status === 'error' && photo.retryable ? (
              <button type="button" onClick={onRetry} disabled={disabled} className="btn btn-secondary btn-sm">
                <Icon name="refresh" size={14} /> Retry
              </button>
            ) : null}
            {hasPicked && !busy ? (
              <button type="button" onClick={onRemove} disabled={disabled} className="btn btn-ghost btn-sm text-[var(--color-error)] hover:text-[var(--color-error)]">
                <Icon name="trash" size={14} /> Remove
              </button>
            ) : null}
          </div>
          <p className={`text-[12.5px] m-0 min-h-[1rem] ${messageTone}`} aria-live="polite" data-photo-message>
            {message}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <label className="sr-only" htmlFor="listing-image-links">
          Image links
        </label>
        <textarea
          id="listing-image-links"
          value={links}
          onChange={(e) => onLinksChange(e.target.value)}
          disabled={disabled}
          rows={2}
          placeholder={`Image links, one per line (optional, up to ${MAX_LISTING_PHOTOS})`}
          className="input text-[14px] resize-y"
        />
      </div>
    </div>
  )
}

export default function Marketplace() {
  const { confirm, confirmDialog } = useConfirm()
  // Report listing and Block author on another seller's listing (issue #192):
  // the shared report dialog, which files the report in the admin queue and
  // counts it toward the automatic hide (#204).
  const { report, blockAuthor, moderationUi } = useReportAndBlock()
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

  // The cards rise in when a page of listings lands and when the tab swaps
  // the grid (hooks/useEntrance). A category, a search or another page reloads
  // through `loading`; My listings has no loading state of its own.
  const cardsRef = useEntrance<HTMLDivElement>(tab === 'mine' || !loading, tab)

  const [selected, setSelected] = useState<Listing | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Listing | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [photo, setPhoto] = useState<PhotoState>({ status: 'idle' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
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

  // The detail panel and the banner sit above the tabs and the grid, so a card
  // opened from low in the grid showed its detail off screen and the tap seemed
  // to do nothing, and a failed open said nothing at all (R30). Both now scroll
  // into view. No `behavior` here: the root's CSS scroll-behavior animates the
  // scroll and drops to a jump under reduced motion (R76).
  function openListing(listing: Listing) {
    authRequest(`/api/marketplace/${listing.id}`)
      .then((data) => {
        const d = data as { listing?: Listing }
        setSelected(d?.listing || null)
        requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start' }))
      })
      .catch((e) => {
        // A 404 is a listing deleted, hidden or blocked since the grid loaded,
        // so the list is read again to drop its card. loadBrowse clears the
        // banner, so the message is set after it.
        if ((e as ApiRequestError)?.status === 404) loadBrowse({})
        setError(errorText(e, 'Could not open this listing.'))
        requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: 'start' }))
      })
  }

  function closeListing() {
    setSelected(null)
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
    // No `behavior`: an explicit 'smooth' overrode the reduced-motion rule's
    // scroll-behavior: auto, so the scroll animated anyway (R76).
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: 'start' }))
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
  }

  async function submitForm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError('')
    const title = form.title.trim()
    if (!title) {
      setFormError('A title is required.')
      return
    }
    const priceCents = priceCentsFor(form.priceMode, form.price)
    if (priceCents === undefined) {
      setFormError('Enter a price like 25 or 12.50, or leave it blank.')
      return
    }
    const links = parseImageLinks(form.imageLinks)
    if (photo.status === 'working') return
    if (photo.status === 'error') {
      setFormError(`Retry the photo upload or remove the photo before you ${editing ? 'save' : 'post'}.`)
      return
    }
    if (links.length + (photo.status === 'ready' ? 1 : 0) > MAX_LISTING_PHOTOS) {
      setFormError(`Choose up to ${MAX_LISTING_PHOTOS} photos.`)
      return
    }
    setSubmitting(true)
    try {
      // An older deployment would silently drop galleries and price modes.
      const capabilities = (await authRequest('/api/marketplace/capabilities')) as { gallery?: boolean; pricing?: boolean }
      if (!capabilities?.gallery || !capabilities?.pricing) throw new Error('Marketplace update is not ready. Please retry later.')

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
      const photos: PhotoRef[] = [...(ready ? [{ receipt: ready.receipt }] : []), ...links.map((url) => ({ url }))]
      const description = form.description.trim()
      if (editing) {
        const patch: Record<string, unknown> = {}
        if (title !== (editing.title || '')) patch.title = title
        if (description !== (editing.description || '')) patch.description = description
        if (form.category !== categoryFor(editing.category).slug) patch.category = form.category
        if (form.priceMode !== priceModeOf(editing) || priceCents !== (editing.priceCents ?? null)) {
          patch.priceMode = form.priceMode
          patch.priceCents = priceCents
        }
        const currentPhotos = listingImages(editing)
        const photosChanged = Boolean(ready) || links.join('\n') !== currentPhotos.join('\n')
        if (photosChanged) patch.photos = photos
        if (Object.keys(patch).length === 0) {
          closeForm()
          return
        }
        const data = (await authRequest(`/api/marketplace/${editing.id}`, { method: 'PATCH', body: JSON.stringify(patch) })) as { listing?: Listing }
        if (data?.listing && selected?.id === editing.id) setSelected({ ...selected, ...data.listing })
      } else {
        const body: Record<string, unknown> = { title, description, category: form.category, priceMode: form.priceMode, priceCents }
        if (photos.length) body.photos = photos
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
  // A failure shows the server's message in the page banner (#224), and the
  // lists are refetched only after the server accepted the change.

  async function markSold(listing: Listing) {
    if (!(await confirm({ title: `Mark "${listing.title}" as sold?`, confirmLabel: 'Mark sold' }))) return
    setError('')
    try {
      await authRequest(`/api/marketplace/${listing.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'sold' }) })
    } catch (e) {
      setError(errorText(e, 'Could not mark the listing as sold.'))
      return
    }
    loadMine()
    loadBrowse({})
  }

  async function deleteListing(listing: Listing) {
    if (!(await confirm({ title: `Delete "${listing.title}"?`, confirmLabel: 'Delete', tone: 'danger' }))) return
    setError('')
    const index = mine.findIndex((l) => l.id === listing.id)
    const openDetail = selected?.id === listing.id ? selected : null
    setMine((prev) => prev.filter((l) => l.id !== listing.id))
    if (openDetail) setSelected(null)
    try {
      await authRequest(`/api/marketplace/${listing.id}`, { method: 'DELETE' })
    } catch (e) {
      setError(errorText(e, 'Could not delete the listing.'))
      // Put it back where it was rather than refetch over the same bad connection.
      setMine((prev) => (index < 0 || prev.some((l) => l.id === listing.id) ? prev : [...prev.slice(0, index), listing, ...prev.slice(index)]))
      if (openDetail) setSelected((current) => current ?? openDetail)
      return
    }
    loadBrowse({})
  }

  // A blocked seller's listings leave the browse list, this one included, so
  // the detail closes and the list is fetched again.
  async function blockSeller(listing: Listing) {
    if (!(await blockAuthor('marketplace', listing.id))) return
    closeListing()
    loadBrowse({})
  }

  function listingCard(listing: Listing, context: 'browse' | 'mine') {
    return (
      <article key={listing.id} className="card flex flex-col" data-listing-id={listing.id} data-listing-status={listing.status || 'active'}>
        <button type="button" onClick={() => openListing(listing)} className="group flex-1 text-left flex flex-col rounded-[var(--radius-xl)]">
          <ListingImage listing={listing} className="aspect-[4/3] w-full rounded-t-[5px] border-b border-[var(--color-border)]" />
          <div className="px-3 pt-3 pb-3.5 sm:px-4 sm:pt-3.5 sm:pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-display font-extrabold text-[19px] sm:text-[22px] leading-none tracking-[-0.02em] tnum text-[var(--color-txt-0)]">{formatPrice(listing.priceCents, listing.priceMode)}</span>
              {listing.status === 'sold' ? (
                <span className="badge bg-[var(--color-txt-0)] text-[var(--color-surface)]">Sold</span>
              ) : null}
            </div>
            <h3 className="row-title text-[14px] sm:text-[15px] mt-2 line-clamp-2 break-words group-hover:underline underline-offset-[3px] decoration-2">{listing.title}</h3>
            <div className="text-[12.5px] sm:text-[13px] text-[var(--color-txt-2)] mt-1">{labelForCategory(listing.category)}</div>
          </div>
        </button>
        {context === 'mine' && listing.hidden ? (
          <div
            className="px-3 sm:px-4 pb-3 text-[12.5px] text-[var(--color-error)] flex items-start gap-1.5"
            data-listing-hidden="true"
          >
            <Icon name="eyeOff" size={13} className="mt-0.5" />
            <span>
              Hidden after {listing.reportCount ?? 0} report{listing.reportCount === 1 ? '' : 's'}. Only you can see it
              while an admin reviews it.
            </span>
          </div>
        ) : null}
        {context === 'mine' ? <PhotoNote listing={listing} className="px-3 sm:px-4 pb-3" /> : null}
        {context === 'mine' ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 sm:px-4 py-2 sm:py-2.5 mt-auto border-t border-[var(--color-border)]">
            <button type="button" onClick={() => openEdit(listing)} className="inline-flex items-center gap-1 py-1 font-display font-bold text-[13px] text-[var(--color-txt-1)] hover:text-[var(--color-accent)]">
              <Icon name="edit" size={13} /> Edit
            </button>
            {listing.status !== 'sold' ? (
              <button type="button" onClick={() => markSold(listing)} className="py-1 font-display font-bold text-[13px] text-[var(--color-txt-1)] hover:text-[var(--color-accent)]">
                Mark sold
              </button>
            ) : null}
            <button type="button" onClick={() => deleteListing(listing)} className="py-1 font-display font-bold text-[13px] text-[var(--color-error)] hover:underline underline-offset-[3px]">
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
    <div className="page r-ink">
      <PageTitle>Marketplace</PageTitle>
      {confirmDialog}
      {moderationUi}
      <header className="page-head">
        <div>
          <h1 className="page-title">Marketplace</h1>
          <p className="page-sub">Buy and sell with other students. Contact is shared on each listing.</p>
        </div>
        {canPost ? (
          <button type="button" onClick={() => (showForm ? closeForm() : openCreate())} className={`btn w-fit ${showForm ? 'btn-secondary' : 'btn-primary'}`}>
            <Icon name={showForm ? 'close' : 'plus'} size={16} />
            {showForm ? 'Close' : 'Post a listing'}
          </button>
        ) : (
          <span className="text-[13px] text-[var(--color-txt-2)]">
            <Link to="/setup" className="prose-link">
              Link Purdue in setup
            </Link>{' '}
            to post.
          </span>
        )}
      </header>

      {formOpen ? (
        <form ref={formRef} onSubmit={submitForm} className="card card-pad mb-6 space-y-3 scroll-mt-24" data-listing-form={editing ? 'edit' : 'create'}>
          <div className="card-head mb-3.5">
            <span className="route-badge" aria-hidden="true">
              <Icon name={editing ? 'edit' : 'tag'} size={18} />
            </span>
            <h2 className="card-title m-0">{editing ? 'Edit listing' : 'Post a listing'}</h2>
            {editing ? (
              <button type="button" onClick={closeForm} className="head-link">
                Cancel
              </button>
            ) : null}
          </div>
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
              className="input text-[15px]"
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="sr-only" htmlFor="listing-price-mode">
                Pricing
              </label>
              <select
                id="listing-price-mode"
                value={form.priceMode}
                onChange={(e) => setForm((f) => ({ ...f, priceMode: e.target.value as PriceMode }))}
                disabled={submitting}
                className="input text-[15px]"
              >
                {PRICE_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </div>
            {form.priceMode === 'fixed' ? (
              <div>
                <label className="sr-only" htmlFor="listing-price">
                  Price in dollars
                </label>
                <input
                  id="listing-price"
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                  inputMode="decimal"
                  placeholder="Price in $ (blank for unspecified)"
                  disabled={submitting}
                  className="input text-[15px] tnum"
                />
              </div>
            ) : (
              <p className="text-[13px] text-[var(--color-txt-2)] self-center m-0" data-price-hint>
                {form.priceMode === 'free' ? 'Listed as Free.' : 'Buyers will send offers.'}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Category">
            {MARKETPLACE_CATEGORIES.map((c) => (
              <button
                key={c.slug}
                type="button"
                aria-pressed={form.category === c.slug}
                onClick={() => setForm((f) => ({ ...f, category: c.slug }))}
                disabled={submitting}
                className={`pill ${form.category === c.slug ? 'pill-active' : ''}`}
              >
                <Icon name={c.icon} size={13} /> {c.label}
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
              className="input text-[15px] resize-y"
            />
          </div>
          <PhotoField
            photo={photo}
            disabled={submitting}
            verb={editing ? 'save' : 'post'}
            links={form.imageLinks}
            onPick={(file) => void pickPhoto(file)}
            onRetry={retryPhoto}
            onRemove={removePhoto}
            onLinksChange={(value) => setForm((f) => ({ ...f, imageLinks: value }))}
          />
          {formError ? (
            <p className="text-[13px] text-[var(--color-error)]" data-form-error>
              {formError}
            </p>
          ) : null}
          <div className="pt-1">
            <button type="submit" disabled={busy} className="btn btn-primary">
              {submitting ? (editing ? 'Saving…' : 'Posting…') : editing ? 'Save changes' : 'Post listing'}
            </button>
          </div>
        </form>
      ) : null}

      {/* Detail panel */}
      {selected ? (
        <div ref={detailRef} className="card card-pad mb-6 border-[var(--color-accent)]/30 scroll-mt-24" data-listing-detail={selected.id}>
          <ListingGallery listing={selected} />
          <PhotoNote listing={selected} className="mb-3" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="badge">{labelForCategory(selected.category)}</span>
              <h2 className="text-[24px] leading-tight text-[var(--color-txt-0)] mt-2.5 break-words">
                {selected.title} <span className="font-display font-bold text-[var(--color-txt-2)] tnum">&middot; {formatPrice(selected.priceCents, selected.priceMode)}</span>
              </h2>
            </div>
            <button type="button" onClick={closeListing} aria-label="Close listing" className="icon-btn -mr-2 -mt-1 shrink-0">
              <Icon name="close" size={18} />
            </button>
          </div>
          {selected.description ? <p className="text-[15px] text-[var(--color-txt-1)] mt-2.5 whitespace-pre-wrap leading-relaxed">{selected.description}</p> : null}
          <div className="mt-4 pt-4 border-t border-[var(--color-border)] text-[14px]">
            <div className="text-[var(--color-txt-2)]">
              Contact: <span className="text-[var(--color-txt-0)] font-semibold">{selected.sellerName}</span>
            </div>
            {selected.sellerEmail ? (
              <a href={`mailto:${selected.sellerEmail}`} className="font-display font-bold text-[var(--color-accent)] hover:underline underline-offset-[3px] decoration-2">
                {selected.sellerEmail}
              </a>
            ) : null}
          </div>
          <div className="mod-actions mt-3">
            {selected.isMine ? (
              <button type="button" onClick={() => openEdit(selected)} className="py-1 font-bold text-[13px] text-[var(--color-txt-1)] hover:text-[var(--color-accent)]">
                <Icon name="edit" size={13} /> Edit listing
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={(e) => report({ targetType: 'marketplace', targetId: selected.id, targetLabel: 'this listing' }, e.currentTarget)}
                >
                  <Icon name="flag" size={13} /> Report listing
                </button>
                <button type="button" onClick={() => void blockSeller(selected)}>
                  Block author
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* Browse / My listings: the same pill pair as the Board's sort. */}
      <div className="flex gap-2 mb-4">
        {['browse', 'mine'].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`pill ${tab === t ? 'pill-active' : ''}`}
          >
            {t === 'browse' ? 'Browse' : 'My listings'}
          </button>
        ))}
      </div>

      {/* One banner for both tabs: load errors and failed listing actions. */}
      {error ? (
        <div ref={errorRef} role="alert" className="card px-4 py-3 mb-4 border-[var(--color-error)]/40 text-[14px] text-[var(--color-error)] scroll-mt-24">
          {error}
        </div>
      ) : null}

      {tab === 'browse' ? (
        <>
          <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-5">
            <div className="flex gap-2 max-lg:overflow-x-auto scrollbar-hide max-lg:-mx-4 max-lg:px-4 max-md:py-1 md:max-lg:-mx-6 md:max-lg:px-6 lg:flex-wrap max-md:[mask-image:linear-gradient(to_right,#000_88%,transparent)]">
              {['all', ...MARKETPLACE_CATEGORIES.map((c) => c.slug)].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => applyFilter(c, query)}
                  className={`pill shrink-0 ${category === c ? 'pill-active' : ''}`}
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
              className="relative lg:ml-auto"
            >
              <Icon name="search" size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-txt-2)] pointer-events-none" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="input pl-10 lg:w-[240px] lg:min-h-[40px] lg:py-2" />
            </form>
          </div>

          {loading ? (
            <p className="text-[14px] text-[var(--color-txt-2)]">Loading…</p>
          ) : listings.length === 0 ? (
            <div className="empty row">
              <span className="ico">
                <Icon name="tag" size={18} />
              </span>
              <div>
                <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No listings found</p>
                <p className="mt-0.5">Try another category or be the first to post.</p>
              </div>
            </div>
          ) : (
            <>
              <div ref={cardsRef} className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">{listings.map((l) => listingCard(l, 'browse'))}</div>
              <div className="flex items-center justify-between gap-3 mt-5">
                <button type="button" onClick={() => changePage(-1)} disabled={page === 0} className="btn btn-secondary btn-sm">
                  <Icon name="chevronLeft" size={15} />
                  Prev
                </button>
                <span className="font-display font-bold text-[13px] text-[var(--color-txt-2)] tnum">Page {page + 1}</span>
                <button type="button" onClick={() => changePage(1)} disabled={!hasMore} className="btn btn-secondary btn-sm">
                  Next
                  <Icon name="chevronRight" size={15} />
                </button>
              </div>
            </>
          )}
        </>
      ) : mine.length === 0 ? (
        <div className="empty row">
          <span className="ico">
            <Icon name="tag" size={18} />
          </span>
          <div>
            <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">You have no listings</p>
            <p className="mt-0.5">
              {canPost ? (
                'Post one above.'
              ) : (
                <>
                  <Link to="/setup" className="prose-link">
                    Link Purdue in setup
                  </Link>{' '}
                  to post.
                </>
              )}
            </p>
          </div>
        </div>
      ) : (
        <div ref={cardsRef} className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">{mine.map((l) => listingCard(l, 'mine'))}</div>
      )}
    </div>
  )
}
