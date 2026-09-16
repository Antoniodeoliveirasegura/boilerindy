import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import Icon from '../../components/Icons'
import { useConfirm } from '../../hooks/useConfirm'
import {
  listDeletedItems,
  restoreDeletedItem,
  hardDeleteItem,
  getLiveContent,
  takeDownContent,
  type DeletedContentType,
} from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader } from './adminShared'
import { formatDateTime } from './adminHelpers'

// Admin moderation for soft-deleted content. Users only ever soft-delete (their
// item is hidden); admins come here to Restore it or permanently (hard) delete
// it. Rows are returned raw from the DB, so titles are derived best-effort from
// whichever common field each table happens to use.
//
// The "Take down by id" panel (issue #195) covers live content: an admin pastes
// an id from a report, previews the row, and soft-deletes it through the type's
// own DELETE route. It then shows up in the deleted list below.

const TYPES: { key: DeletedContentType; label: string }[] = [
  { key: 'board', label: 'Board posts' },
  { key: 'marketplace', label: 'Marketplace' },
  { key: 'lost-found', label: 'Lost & Found' },
  { key: 'guide', label: 'Guide' },
  { key: 'deals', label: 'Perks / Deals' },
  { key: 'study-groups', label: 'Study groups' },
]

type Row = { id: string; deleted_at?: string | null; [key: string]: unknown }

type Preview = { type: DeletedContentType; item: Row; label: string }

const INPUT_CLASS =
  'mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-0)] px-3 py-2.5 text-[13px] text-[var(--color-txt-0)]'

function firstString(row: Row, keys: string[], skip = ''): string {
  for (const key of keys) {
    const value = (row as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() && value !== skip) return value.trim()
  }
  return ''
}

function rowTitle(row: Row): string {
  const text = firstString(row, ['title', 'business_name', 'businessName', 'name', 'body'])
  if (!text) return '(untitled)'
  return text.length > 90 ? `${text.slice(0, 90)}…` : text
}

function rowSubtitle(row: Row): string {
  const text = firstString(row, ['description', 'body', 'location', 'category'], rowTitle(row))
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

export default function AdminDeleted() {
  const [type, setType] = useState<DeletedContentType>('board')
  const [items, setItems] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [lookupType, setLookupType] = useState<DeletedContentType>('board')
  const [lookupId, setLookupId] = useState('')
  const [lookupError, setLookupError] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  // Bumped on every lookup and every edit of the type or id, so a lookup that
  // resolves after the admin changed the field is dropped instead of previewing
  // (and offering to take down) a different item than the one in the field.
  const lookupSeq = useRef(0)
  const { confirm, confirmDialog } = useConfirm()

  const load = useCallback(async (t: DeletedContentType) => {
    setLoading(true)
    setError('')
    try {
      const data = (await listDeletedItems(t)) as { items?: Row[] }
      setItems(data.items || [])
    } catch (e) {
      setItems([])
      setError(e instanceof Error ? e.message : 'Could not load deleted items.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(type)
  }, [type, load])

  async function handleRestore(row: Row) {
    setBusyId(row.id)
    setError('')
    setSuccess('')
    try {
      await restoreDeletedItem(type, row.id)
      setItems((prev) => prev.filter((r) => r.id !== row.id))
      setSuccess('Item restored - it is visible again.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore the item.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleHardDelete(row: Row) {
    const ok = await confirm({
      title: 'Permanently delete this item?',
      message: 'It will be removed from the database for good. This cannot be undone.',
      confirmLabel: 'Delete permanently',
      tone: 'danger',
      icon: 'trash',
    })
    if (!ok) return
    setBusyId(row.id)
    setError('')
    setSuccess('')
    try {
      await hardDeleteItem(type, row.id)
      setItems((prev) => prev.filter((r) => r.id !== row.id))
      setSuccess('Item permanently deleted.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not permanently delete the item.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleLookup(event: FormEvent) {
    event.preventDefault()
    const id = lookupId.trim()
    if (!id) return
    const seq = ++lookupSeq.current
    setLookupBusy(true)
    setLookupError('')
    setPreview(null)
    setSuccess('')
    try {
      const data = (await getLiveContent(lookupType, id)) as { item?: Row; label?: string }
      if (seq !== lookupSeq.current) return
      if (!data?.item) throw new Error('Item not found.')
      setPreview({ type: lookupType, item: data.item, label: data.label || '' })
    } catch (e) {
      if (seq !== lookupSeq.current) return
      setLookupError(e instanceof Error ? e.message : 'Could not find that item.')
    } finally {
      setLookupBusy(false)
    }
  }

  function clearLookupResult() {
    lookupSeq.current += 1
    setPreview(null)
  }

  async function handleTakeDown() {
    if (!preview) return
    const ok = await confirm({
      title: 'Take this item down?',
      message: 'It will be hidden from everyone, as if its author deleted it. You can restore it from the deleted list.',
      confirmLabel: 'Take down',
      tone: 'danger',
      icon: 'trash',
    })
    if (!ok) return
    setLookupBusy(true)
    setLookupError('')
    setSuccess('')
    try {
      await takeDownContent(preview.type, preview.item.id)
      setPreview(null)
      // Keep an id the admin started typing while the takedown was in flight.
      setLookupId((current) => (current.trim() === preview.item.id ? '' : current))
      setSuccess(`${preview.label || 'Item'} taken down - it now appears in the deleted list.`)
      // Show the list the item just landed in; the effect reloads on a type change.
      if (preview.type === type) load(type)
      else setType(preview.type)
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : 'Could not take the item down.')
    } finally {
      setLookupBusy(false)
    }
  }

  const previewAuthor = preview ? firstString(preview.item, ['user_id', 'creator_id']) : ''
  const previewCreated = preview ? firstString(preview.item, ['created_at']) : ''

  return (
    <div>
      <PageHeader
        title="Deleted content"
        description="Content users delete is hidden but kept here. Restore it to make it visible again, or permanently remove it from the database."
      />

      <section className="card p-4 mb-5" aria-labelledby="admin-takedown-heading">
        <h2 id="admin-takedown-heading" className="text-[14px] font-medium text-[var(--color-txt-0)]">
          Take down by id
        </h2>
        <p className="text-[12px] text-[var(--color-txt-2)] mt-1">
          Paste the id of live content from a report. Taking it down hides it the same way a user delete does, so it
          lands in the list below and can be restored.
        </p>
        <form onSubmit={handleLookup} className="mt-3 flex flex-col sm:flex-row sm:items-end gap-3">
          <label className="block sm:w-48">
            <span className="text-[12px] font-medium text-[var(--color-txt-2)]">Content type</span>
            <select
              value={lookupType}
              onChange={(e) => {
                setLookupType(e.target.value as DeletedContentType)
                clearLookupResult()
              }}
              className={INPUT_CLASS}
            >
              {TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block flex-1 min-w-0">
            <span className="text-[12px] font-medium text-[var(--color-txt-2)]">Content id</span>
            <input
              value={lookupId}
              onChange={(e) => {
                setLookupId(e.target.value)
                clearLookupResult()
              }}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono`}
            />
          </label>
          <button
            type="submit"
            disabled={lookupBusy || !lookupId.trim()}
            className="btn btn-secondary text-[12px] px-3 py-2.5 disabled:opacity-50"
          >
            <Icon name="search" size={14} />
            Find
          </button>
        </form>

        {lookupError && (
          <div role="alert" className="text-[12px] text-[var(--color-error)] mt-2">
            {lookupError}
          </div>
        )}

        {preview && (
          <div className="mt-3 rounded-xl border border-[var(--color-border)] p-3 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="min-w-0">
              {preview.label && (
                <div className="text-[11px] text-[var(--color-txt-3)] mb-0.5">{preview.label}</div>
              )}
              <div className="text-[14px] font-medium text-[var(--color-txt-0)] truncate">{rowTitle(preview.item)}</div>
              {rowSubtitle(preview.item) && (
                <div className="text-[12px] text-[var(--color-txt-2)] mt-1 line-clamp-2">{rowSubtitle(preview.item)}</div>
              )}
              <div className="text-[11px] text-[var(--color-txt-3)] mt-1.5 font-mono break-all">Id {preview.item.id}</div>
              <div className="text-[11px] text-[var(--color-txt-3)] mt-0.5 break-all">
                Posted {previewCreated ? formatDateTime(previewCreated) : 'at an unknown time'}
                {previewAuthor ? ` by user ${previewAuthor}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={handleTakeDown}
              disabled={lookupBusy}
              className="inline-flex items-center gap-1.5 shrink-0 text-[12px] px-3 py-2 rounded-xl border border-[var(--color-error)]/40 text-[var(--color-error)] hover:bg-[var(--color-error)]/10 disabled:opacity-50"
            >
              <Icon name="trash" size={14} />
              Take down
            </button>
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-2 mb-5">
        {TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setType(t.key)}
            className={`text-[12px] px-3.5 py-2 rounded-xl border transition-colors ${
              type === t.key
                ? 'bg-[var(--color-accent)]/12 text-[var(--color-accent)] border-[var(--color-accent)]/30 font-medium'
                : 'bg-[var(--color-surface)] text-[var(--color-txt-1)] border-[var(--color-border)] hover:border-[var(--color-accent)]/40'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <AlertBanner type="error" message={error} onDismiss={() => setError('')} />}
      {success && <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />}

      {loading ? (
        <div className="card p-6 text-[13px] text-[var(--color-txt-2)]">Loading deleted items…</div>
      ) : items.length === 0 ? (
        <EmptyState title="Nothing here" description="No deleted items of this type." />
      ) : (
        <div className="space-y-3">
          {items.map((row) => (
            <div
              key={row.id}
              className="card p-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-[var(--color-txt-0)] truncate">{rowTitle(row)}</div>
                {rowSubtitle(row) && (
                  <div className="text-[12px] text-[var(--color-txt-2)] mt-1 line-clamp-2">{rowSubtitle(row)}</div>
                )}
                <div className="text-[11px] text-[var(--color-txt-3)] mt-1.5">
                  Deleted {row.deleted_at ? formatDateTime(row.deleted_at) : 'recently'}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handleRestore(row)}
                  disabled={busyId === row.id}
                  className="btn btn-secondary text-[12px] px-3 py-2 disabled:opacity-50"
                >
                  <Icon name="refresh" size={14} />
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => handleHardDelete(row)}
                  disabled={busyId === row.id}
                  className="inline-flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-xl border border-[var(--color-error)]/40 text-[var(--color-error)] hover:bg-[var(--color-error)]/10 disabled:opacity-50"
                >
                  <Icon name="trash" size={14} />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmDialog}
    </div>
  )
}
