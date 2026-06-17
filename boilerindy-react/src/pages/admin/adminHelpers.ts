// Non-component shared values for the admin console. Kept out of
// adminShared.jsx so that file exports only components — Fast Refresh
// (react-refresh/only-export-components) requires component-only modules.

export type StatusMeta = { label: string; cls: string }

export const LEAD_STATUS_META: Record<string, StatusMeta> = {
  new: { label: 'New', cls: 'text-sky-700 bg-sky-500/15 border-sky-500/30 dark:text-sky-300' },
  contacted: { label: 'Contacted', cls: 'text-amber-700 bg-amber-500/15 border-amber-500/30 dark:text-amber-300' },
  closed: { label: 'Closed', cls: 'text-[var(--color-txt-2)] bg-[var(--color-bg-2)] border-[var(--color-border)]' },
}

export const CAMPAIGN_STATUS_META: Record<string, StatusMeta> = {
  draft: { label: 'Draft', cls: 'text-[var(--color-txt-2)] bg-[var(--color-bg-2)] border-[var(--color-border)]' },
  pending_review: { label: 'Pending review', cls: 'text-[var(--color-gold-dark)] bg-[var(--color-gold)]/20 border-[var(--color-gold)]/40' },
  active: { label: 'Live', cls: 'text-emerald-700 bg-emerald-500/15 border-emerald-500/30 dark:text-emerald-300' },
  paused: { label: 'Paused', cls: 'text-amber-700 bg-amber-500/15 border-amber-500/30 dark:text-amber-300' },
  ended: { label: 'Ended', cls: 'text-[var(--color-txt-3)] bg-[var(--color-bg-2)] border-[var(--color-border)]' },
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
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

export function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$'
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}
