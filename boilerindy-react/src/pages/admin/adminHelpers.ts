// Non-component shared values for the admin console. Kept out of
// adminShared.jsx so that file exports only components - Fast Refresh
// (react-refresh/only-export-components) requires component-only modules.

// cls is added to the shared .badge: badge-signal (amber) only where the admin
// owes an action (a new request, a campaign waiting for review), a route tint
// for the other live states, and the plain stat badge for the settled ones.
export type StatusMeta = { label: string; cls: string }

export const LEAD_STATUS_META: Record<string, StatusMeta> = {
  new: { label: 'New', cls: 'badge-signal' },
  contacted: { label: 'Contacted', cls: 'badge-route r-cls' },
  closed: { label: 'Closed', cls: '' },
}

export const CAMPAIGN_STATUS_META: Record<string, StatusMeta> = {
  draft: { label: 'Draft', cls: '' },
  pending_review: { label: 'Pending review', cls: 'badge-signal' },
  active: { label: 'Live', cls: 'badge-route r-din' },
  paused: { label: 'Paused', cls: 'badge-route r-bus' },
  ended: { label: 'Ended', cls: 'text-[var(--color-txt-3)]' },
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return value
  }
}

/** "just now", "12 min ago", "3 h ago", "2 days ago": how long a queue item has waited. */
export function ageLabel(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** The report and photo queues promise a review within a day (docs/moderation.md). */
export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000

export function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$'
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

// Admin tables: an eyebrow header row on the stat fill, 1px row rules,
// tabular numbers, a hover fill and no zebra striping. The header cells use the
// shared .eyebrow.bare (table-cell restores the cell display it sets to flex).
export const TABLE_HEAD_ROW = 'bg-[var(--color-stat)] border-b border-[var(--color-border-2)]'
export const TABLE_TH = 'eyebrow bare table-cell text-[10.5px] px-4 py-3 whitespace-nowrap'
export const TABLE_ROW =
  'border-t border-[var(--color-border)] first:border-t-0 transition-colors hover:bg-[var(--color-surface-hover)]'
