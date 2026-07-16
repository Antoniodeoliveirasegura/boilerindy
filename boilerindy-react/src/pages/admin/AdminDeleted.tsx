import { useCallback, useEffect, useState } from 'react'
import Icon from '../../components/Icons'
import { useConfirm } from '../../hooks/useConfirm'
import {
  listDeletedItems,
  restoreDeletedItem,
  hardDeleteItem,
  type DeletedContentType,
} from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader } from './adminShared'
import { formatDateTime } from './adminHelpers'

// Admin moderation for soft-deleted content. Users only ever soft-delete (their
// item is hidden); admins come here to Restore it or permanently (hard) delete
// it. Rows are returned raw from the DB, so titles are derived best-effort from
// whichever common field each table happens to use.

const TYPES: { key: DeletedContentType; label: string }[] = [
  { key: 'board', label: 'Board posts' },
  { key: 'marketplace', label: 'Marketplace' },
  { key: 'lost-found', label: 'Lost & Found' },
  { key: 'guide', label: 'Guide' },
  { key: 'deals', label: 'Perks / Deals' },
]

type Row = { id: string; deleted_at?: string; [key: string]: unknown }

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

  return (
    <div>
      <PageHeader
        title="Deleted content"
        description="Content users delete is hidden but kept here. Restore it to make it visible again, or permanently remove it from the database."
      />

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
