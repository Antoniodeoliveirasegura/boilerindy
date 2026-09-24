import type { ReactNode } from 'react'
import Icon from './Icons'

// Inline status banner with the live region a screen reader needs (issue
// #221). An error is `role="alert"` (announced at once); a success or info
// message is `role="status"` (announced when the reader is idle). The classes
// are the ones the Login banners used, so swapping a banner for this component
// changes nothing on screen.
type StatusBannerProps = {
  tone: 'error' | 'success' | 'info'
  children: ReactNode
  /** Spacing and layout classes for the site (`mb-4`, `mt-3`, ...). */
  className?: string
  /** Icon from the Icons set; defaults per tone, `null` renders none. */
  icon?: string | null
}

const TONE_CLASSES: Record<StatusBannerProps['tone'], string> = {
  error: 'bg-[var(--color-error)]/10 border-[var(--color-error)]/25 text-[var(--color-error)]',
  success: 'bg-[var(--color-success)]/10 border-[var(--color-success)]/25 text-[var(--color-success)]',
  info: 'bg-[var(--color-stat)] border-[var(--color-border)] text-[var(--color-txt-1)]',
}

const TONE_ICONS: Record<StatusBannerProps['tone'], string> = {
  error: 'close',
  success: 'check',
  info: 'info',
}

export default function StatusBanner({ tone, children, className = '', icon }: StatusBannerProps) {
  const iconName = icon === undefined ? TONE_ICONS[tone] : icon
  const live = tone === 'error' ? { role: 'alert' as const } : { role: 'status' as const, 'aria-live': 'polite' as const }
  return (
    <div
      {...live}
      className={`flex items-start gap-2.5 border rounded-xl px-3.5 py-2.5 text-[13px] ${TONE_CLASSES[tone]} ${className}`}
    >
      {iconName && <Icon name={iconName} size={16} className="shrink-0 mt-0.5" />}
      <span className="min-w-0">{children}</span>
    </div>
  )
}
