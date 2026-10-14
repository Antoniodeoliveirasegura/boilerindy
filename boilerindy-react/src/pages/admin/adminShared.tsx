import type { ReactNode } from 'react'
import Icon from '../../components/Icons'
import type { StatusMeta } from './adminHelpers'

export function StatusBadge({
  status,
  metaMap,
}: {
  status: string
  metaMap: Record<string, StatusMeta>
}) {
  const meta = metaMap[status] || { label: status, cls: '' }
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>
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
    <header className="page-head">
      <div>
        <h1 className="page-title compact">{title}</h1>
        {description && <p className="page-sub max-w-[68ch] text-[14px]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
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
      ? 'border-[var(--color-success)]/45 bg-[var(--color-success)]/8 text-[var(--color-success)]'
      : 'border-[var(--color-error)]/45 bg-[var(--color-error)]/8 text-[var(--color-error)]'
  return (
    <div
      role="alert"
      className={`rounded-lg border-[1.5px] px-3.5 py-2.5 mb-5 text-[13.5px] leading-snug flex items-center justify-between gap-3 ${cls}`}
    >
      <span className="min-w-0 break-words">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 -my-1 min-h-[32px] max-md:-my-2.5 max-md:min-h-[44px] px-1.5 font-display font-bold text-[12.5px] text-current underline underline-offset-2 border-0 bg-transparent cursor-pointer rounded-sm"
        >
          Dismiss
        </button>
      )}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  icon = 'check',
}: {
  title: ReactNode
  description?: ReactNode
  /** Decorative icon in the empty state's stat square. */
  icon?: string
}) {
  return (
    <div className="empty row gap-3.5 px-5 py-5">
      <span className="ico">
        <Icon name={icon} size={18} />
      </span>
      <div className="min-w-0">
        <div className="font-display font-bold text-[15px] leading-snug text-[var(--color-txt-0)]">{title}</div>
        <div className="mt-0.5 text-[13.5px] leading-snug text-[var(--color-txt-2)]">{description}</div>
      </div>
    </div>
  )
}
