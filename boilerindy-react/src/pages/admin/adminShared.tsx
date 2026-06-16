import type { ReactNode } from 'react'
import type { StatusMeta } from './adminHelpers'

export function StatusBadge({
  status,
  metaMap,
}: {
  status: string
  metaMap: Record<string, StatusMeta>
}) {
  const meta = metaMap[status] || { label: status, cls: 'text-[var(--color-txt-2)] bg-[var(--color-bg-2)] border-[var(--color-border)]' }
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-txt-0)] tracking-tight">{title}</h1>
        {description && (
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1 max-w-2xl leading-relaxed">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function AlertBanner({
  type = 'error',
  message,
  onDismiss,
}: {
  type?: 'success' | 'error'
  message?: ReactNode
  onDismiss?: () => void
}) {
  if (!message) return null
  const cls =
    type === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
      : 'border-[var(--color-error)]/30 bg-[var(--color-error)]/8 text-[var(--color-error)]'
  return (
    <div role="alert" className={`rounded-xl border p-3.5 mb-5 text-[13px] flex items-start justify-between gap-3 ${cls}`}>
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-[12px] underline border-0 bg-transparent cursor-pointer shrink-0">
          Dismiss
        </button>
      )}
    </div>
  )
}

export function EmptyState({
  title,
  description,
}: {
  title: ReactNode
  description?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-12 text-center">
      <div className="text-[15px] font-medium text-[var(--color-txt-0)] mb-1">{title}</div>
      <div className="text-[13px] text-[var(--color-txt-2)]">{description}</div>
    </div>
  )
}
