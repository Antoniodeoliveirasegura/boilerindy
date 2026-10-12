import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/Icons'
import { useConfirm } from '../../hooks/useConfirm'
import {
  closeReport,
  getLiveContent,
  listReports,
  takeDownContent,
  takeDownHiddenListing,
  type ContentReport,
  type DeletedContentType,
  type ReportStatus,
  type ReportTargetType,
} from '../../lib/adminApi'
import { reportReasonLabel } from '../../lib/reportReasons'
import { AlertBanner, EmptyState, PageHeader } from './adminShared'
import { DANGER_BTN, formatDateTime } from './adminHelpers'
import PageTitle from '../../components/PageTitle'

// The report queue (issue #192): everything students reported, newest first.
// An admin opens the reported content, takes it down if it breaks the rules
// (through the type's own route, so it lands in Deleted content and can be
// restored), then resolves the report, or dismisses one that needs nothing.
// Replies and users have no takedown here: their text is shown inline, and a
// reply's post or a user's content is reported and taken down on its own.

const STATUSES: { key: ReportStatus; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'dismissed', label: 'Dismissed' },
]

const TYPE_LABELS: Record<ReportTargetType, string> = {
  board_post: 'Board post',
  board_reply: 'Board reply',
  lost_found: 'Lost & Found item',
  guide: 'Guide recommendation',
  study_group: 'Study group',
  marketplace: 'Marketplace listing',
  user: 'User',
}

// Report target types that have a live-content preview and a takedown route.
const CONTENT_TYPES: Partial<Record<ReportTargetType, DeletedContentType>> = {
  board_post: 'board',
  lost_found: 'lost-found',
  guide: 'guide',
  study_group: 'study-groups',
  marketplace: 'marketplace',
}

// The queue promises a review within a day (docs/moderation.md).
const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000

type LiveRow = { id: string; [key: string]: unknown }
type Preview = { reportId: string; item: LiveRow | null }

function firstString(row: LiveRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function ageLabel(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function targetTitle(report: ContentReport): string {
  if (!report.target) return '(no longer in the database)'
  const title = report.target.title.trim()
  if (!title) return '(untitled)'
  return report.targetType === 'board_reply' ? title : clip(title, 120)
}

export default function AdminReports() {
  const [status, setStatus] = useState<ReportStatus>('open')
  const [reports, setReports] = useState<ContentReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // A lookup that resolves after the admin opened another report is dropped.
  const previewSeq = useRef(0)
  const { confirm, confirmDialog } = useConfirm()

  // State only changes once the request settles (selectStatus resets it), and a
  // list that arrives after the admin switched tabs again is dropped.
  useEffect(() => {
    let current = true
    listReports(status)
      .then((data) => {
        if (!current) return
        setReports((data as { reports?: ContentReport[] }).reports || [])
        setNow(Date.now())
      })
      .catch((e: unknown) => {
        if (!current) return
        setReports([])
        setError(e instanceof Error ? e.message : 'Could not load the reports.')
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [status])

  function selectStatus(next: ReportStatus) {
    if (next === status) return
    setLoading(true)
    setError('')
    setSuccess('')
    setPreview(null)
    setStatus(next)
  }

  async function handleClose(report: ContentReport, next: 'resolved' | 'dismissed') {
    setBusyId(report.id)
    setError('')
    setSuccess('')
    try {
      await closeReport(report.id, next)
      setReports((prev) => prev.filter((r) => r.id !== report.id))
      setSuccess(next === 'resolved' ? 'Report resolved.' : 'Report dismissed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the report.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleOpen(report: ContentReport) {
    const type = CONTENT_TYPES[report.targetType]
    if (!type) return
    if (preview?.reportId === report.id) {
      previewSeq.current += 1
      setPreview(null)
      return
    }
    const seq = ++previewSeq.current
    setBusyId(report.id)
    setError('')
    try {
      const data = (await getLiveContent(type, report.targetId)) as { item?: LiveRow }
      if (seq !== previewSeq.current) return
      setPreview({ reportId: report.id, item: data?.item || null })
    } catch (e) {
      if (seq !== previewSeq.current) return
      // The admin content route only serves live rows: a 404 means it is gone.
      if ((e as { status?: number })?.status === 404) setPreview({ reportId: report.id, item: null })
      else setError(e instanceof Error ? e.message : 'Could not open the content.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleTakeDown(report: ContentReport) {
    const type = CONTENT_TYPES[report.targetType]
    if (!type) return
    const ok = await confirm({
      title: `Take this ${TYPE_LABELS[report.targetType].toLowerCase()} down?`,
      message: 'It will be hidden from everyone, as if its author deleted it. You can restore it from Deleted content. The report stays open until you resolve it.',
      confirmLabel: 'Take down',
      tone: 'danger',
      icon: 'trash',
    })
    if (!ok) return
    setBusyId(report.id)
    setError('')
    setSuccess('')
    try {
      // Listings go through the admin takedown, which any live listing accepts.
      if (report.targetType === 'marketplace') await takeDownHiddenListing(report.targetId)
      else await takeDownContent(type, report.targetId)
      setReports((prev) =>
        prev.map((r) => (r.id === report.id && r.target ? { ...r, target: { ...r.target, deleted: true } } : r)),
      )
      if (preview?.reportId === report.id) setPreview({ reportId: report.id, item: null })
      setSuccess('Taken down - it now appears in Deleted content. Resolve the report when you are done.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not take the content down.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageTitle>Admin reports</PageTitle>
      <PageHeader
        title="Reports"
        description="What students reported on the board, Lost & Found, the guide, study groups, the marketplace and their profiles, newest first. Open the content, take it down if it breaks the rules, then resolve the report; dismiss one that needs nothing. Aim to review each report within a day."
      />

      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Report status">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => selectStatus(s.key)}
            aria-pressed={status === s.key}
            className={`pill ${status === s.key ? 'pill-active' : ''}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && <AlertBanner type="error" message={error} onDismiss={() => setError('')} />}
      {success && <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />}

      {loading ? (
        <div className="card card-pad text-[13.5px] text-[var(--color-txt-2)]">Loading reports…</div>
      ) : reports.length === 0 ? (
        <EmptyState
          icon="flag"
          title="Nothing here"
          description={status === 'open' ? 'No open reports. New ones show up here as students file them.' : `No ${status} reports.`}
        />
      ) : (
        <ul className="card divide-y divide-[var(--color-border)]" aria-label={`${STATUSES.find((s) => s.key === status)?.label} reports`}>
          {reports.map((report) => {
            const contentType = CONTENT_TYPES[report.targetType]
            const overdue = report.status === 'open' && now - new Date(report.createdAt).getTime() > REVIEW_WINDOW_MS
            const open = preview?.reportId === report.id
            return (
              <li key={report.id} className="px-4 py-4 sm:px-5">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="eyebrow text-[10.5px]">{TYPE_LABELS[report.targetType] ?? report.targetType}</span>
                      {report.target?.deleted && (
                        <span className="badge">Taken down</span>
                      )}
                      {report.target?.hidden && !report.target.deleted && (
                        <span className="badge">Hidden by reports</span>
                      )}
                    </div>
                    <div className="font-display font-bold text-[15px] leading-snug text-[var(--color-txt-0)] mt-2 break-words">{targetTitle(report)}</div>
                    {report.target?.authorId && report.targetType !== 'user' && (
                      <div className="text-[12.5px] text-[var(--color-txt-2)] mt-0.5">
                        Posted by {report.target.authorName || 'a student with no name'}
                      </div>
                    )}
                    <div className="text-[13.5px] leading-snug text-[var(--color-txt-1)] mt-2.5">
                      <span className="font-semibold text-[var(--color-txt-0)]">{reportReasonLabel(report.reason)}</span>
                      {report.details ? <span className="text-[var(--color-txt-2)]">: {report.details}</span> : null}
                    </div>
                    <div className={`text-[12.5px] mt-1.5 tnum ${overdue ? 'font-semibold text-[var(--color-error)]' : 'text-[var(--color-txt-3)]'}`}>
                      Reported by {report.reporter.displayName || 'a student with no name'}, {ageLabel(report.createdAt, now)} (
                      {formatDateTime(report.createdAt)})
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {contentType && (
                      <button
                        type="button"
                        onClick={() => handleOpen(report)}
                        disabled={busyId === report.id}
                        aria-expanded={open}
                        className="btn btn-secondary btn-sm disabled:opacity-50"
                      >
                        <Icon name="eye" size={14} />
                        {open ? 'Close' : 'Open'}
                      </button>
                    )}
                    {contentType && report.target && !report.target.deleted && (
                      <button
                        type="button"
                        onClick={() => handleTakeDown(report)}
                        disabled={busyId === report.id}
                        className={`${DANGER_BTN} disabled:opacity-50`}
                      >
                        <Icon name="trash" size={14} />
                        Take down
                      </button>
                    )}
                    {report.status === 'open' && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleClose(report, 'resolved')}
                          disabled={busyId === report.id}
                          className="btn btn-secondary btn-sm disabled:opacity-50"
                        >
                          <Icon name="check" size={14} />
                          Resolve
                        </button>
                        <button
                          type="button"
                          onClick={() => handleClose(report, 'dismissed')}
                          disabled={busyId === report.id}
                          className="btn btn-ghost btn-sm disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {open && (
                  <div
                    className="mt-3.5 rounded-r-md border-l-[3px] border-[var(--color-border-3)] bg-[var(--color-stat)] px-3.5 py-3 text-[13px] leading-snug"
                    aria-live="polite"
                  >
                    {preview?.item ? (
                      <>
                        <div className="font-display font-bold text-[var(--color-txt-0)] break-words">
                          {clip(firstString(preview.item, ['title', 'body', 'name']) || '(untitled)', 200)}
                        </div>
                        {firstString(preview.item, ['description', 'body', 'location']) && (
                          <div className="text-[var(--color-txt-1)] mt-1 whitespace-pre-wrap break-words">
                            {clip(firstString(preview.item, ['description', 'body', 'location']), 1000)}
                          </div>
                        )}
                        <div className="text-[11.5px] text-[var(--color-txt-3)] mt-2 font-mono break-all">Id {preview.item.id}</div>
                      </>
                    ) : (
                      <div className="text-[var(--color-txt-2)]">It is no longer live: it was taken down or deleted.</div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {confirmDialog}
    </div>
  )
}
