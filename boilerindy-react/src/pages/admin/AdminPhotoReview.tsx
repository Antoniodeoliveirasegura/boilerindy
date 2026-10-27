import { useEffect, useState } from 'react'
import Icon from '../../components/Icons'
import PageTitle from '../../components/PageTitle'
import { useConfirm } from '../../hooks/useConfirm'
import { decideListingPhotos, listPhotoReview, type PhotoReviewListing } from '../../lib/adminApi'
import { labelForCategory } from '../../lib/marketplace'
import { AlertBanner, EmptyState, PageHeader } from './adminShared'
import { ageLabel, formatDateTime, REVIEW_WINDOW_MS } from './adminHelpers'

// The photo queue (issue #504): marketplace listings whose photos wait for an
// admin before other students see them, the longest waiting first. Approve
// shows the photos to everyone; reject clears them from the listing, which
// stays up without photos while its seller is told an admin removed them.
// Photos only wait while MARKETPLACE_PHOTO_REVIEW is on, but listings held
// before it went off stay here until decided. A decision carries the version
// the queue showed, so a listing the seller edited since answers 409 and the
// queue is read again.

type Decision = 'approve' | 'reject'

export default function AdminPhotoReview() {
  const [listings, setListings] = useState<PhotoReviewListing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [reads, setReads] = useState(0)
  const { confirm, confirmDialog } = useConfirm()

  // State only changes once the request settles (readAgain sets loading), and
  // a list that arrives after a newer read started is dropped.
  useEffect(() => {
    let current = true
    listPhotoReview()
      .then((data) => {
        if (!current) return
        setListings((data as { listings?: PhotoReviewListing[] }).listings || [])
        setNow(Date.now())
      })
      .catch((e: unknown) => {
        if (!current) return
        setListings([])
        setError(e instanceof Error ? e.message : 'Could not load the photo queue.')
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [reads])

  function readAgain() {
    setLoading(true)
    setReads((n) => n + 1)
  }

  async function decide(listing: PhotoReviewListing, decision: Decision) {
    if (decision === 'reject') {
      const ok = await confirm({
        title: 'Reject these photos?',
        message:
          'They are removed from the listing, which stays up without photos. The seller is told an admin removed them and can add new ones.',
        confirmLabel: 'Reject photos',
        tone: 'danger',
        icon: 'trash',
      })
      if (!ok) return
    }
    setBusyId(listing.id)
    setError('')
    setSuccess('')
    try {
      await decideListingPhotos(listing.id, decision, listing.updatedAt)
      setListings((prev) => prev.filter((l) => l.id !== listing.id))
      setSuccess(decision === 'approve' ? 'Photos approved. Every student can see them now.' : 'Photos rejected and removed from the listing.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the decision.')
      // 409: the seller edited the listing since the queue loaded; 404: it left
      // the queue (another admin decided, or it is gone). Either way, read again.
      const status = (e as { status?: number })?.status
      if (status === 409 || status === 404) readAgain()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageTitle>Admin photo review</PageTitle>
      <PageHeader
        title="Photo review"
        description="New marketplace photos wait here before other students see them, the longest waiting first. Approve them to show them to everyone, or reject them to take them off the listing, which stays up without photos. Aim to review each listing within a day."
      />

      {error && <AlertBanner type="error" message={error} onDismiss={() => setError('')} />}
      {success && <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />}

      {loading ? (
        <div className="card card-pad text-[13.5px] text-[var(--color-txt-2)]">Loading photos…</div>
      ) : listings.length === 0 ? (
        <EmptyState
          icon="image"
          title="Nothing to review"
          description="No photos are waiting. While photo review is on, new listing photos show up here before other students see them."
        />
      ) : (
        <ul className="card divide-y divide-[var(--color-border)]" aria-label="Listings with photos to review">
          {listings.map((listing) => {
            const title = listing.title?.trim() || '(untitled)'
            const overdue = now - new Date(listing.updatedAt).getTime() > REVIEW_WINDOW_MS
            const busy = busyId === listing.id
            return (
              <li key={listing.id} className="px-4 py-4 sm:px-5" data-review-listing={listing.id}>
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="eyebrow text-[10.5px]">{labelForCategory(listing.category) || 'Marketplace listing'}</span>
                      {listing.status === 'sold' && <span className="badge">Sold</span>}
                      {listing.hidden && <span className="badge">Hidden by reports</span>}
                    </div>
                    <div className="font-display font-bold text-[15px] leading-snug text-[var(--color-txt-0)] mt-2 break-words">{title}</div>
                    <div className="text-[12.5px] text-[var(--color-txt-2)] mt-0.5">
                      Posted by {listing.seller?.displayName || 'a student with no name'}
                    </div>
                    {listing.description ? (
                      <p className="text-[13px] leading-snug text-[var(--color-txt-1)] mt-2 line-clamp-3 whitespace-pre-wrap break-words">{listing.description}</p>
                    ) : null}
                    <div className={`text-[12.5px] mt-1.5 tnum ${overdue ? 'font-semibold text-[var(--color-error)]' : 'text-[var(--color-txt-3)]'}`}>
                      Waiting since {formatDateTime(listing.updatedAt)} ({ageLabel(listing.updatedAt, now)})
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button type="button" onClick={() => decide(listing, 'approve')} disabled={busy} className="btn btn-secondary btn-sm">
                      <Icon name="check" size={14} />
                      Approve
                    </button>
                    <button type="button" onClick={() => decide(listing, 'reject')} disabled={busy} className="btn btn-danger btn-sm">
                      <Icon name="trash" size={14} />
                      Reject
                    </button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Photos of ${title}`}>
                  {listing.images.map((url, i) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]"
                    >
                      <img
                        src={url}
                        alt={`${title}, ${i + 1} of ${listing.images.length}`}
                        loading="lazy"
                        decoding="async"
                        className="h-28 w-28 sm:h-32 sm:w-32 object-cover bg-[var(--color-stat)]"
                      />
                    </a>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {confirmDialog}
    </div>
  )
}
