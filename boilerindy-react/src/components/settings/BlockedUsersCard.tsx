import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import StatusBanner from '../StatusBanner'
import { authRequest } from '../../lib/authApi'
import { invalidateUserQueries, useMyBlocks } from '../../lib/queries/userData'
import { writeFailureMessage } from '../../lib/writeFailure'

// Blocked users card on Settings (issue #192): everyone the student blocked,
// newest first, each with Unblock. A block works both ways, so the two stop
// seeing each other's posts, matches and requests; unblocking lifts that but
// does not bring back a connection the block ended (docs/moderation.md).
// Blocks other people made take effect and are never listed here.

const LABEL_CLASS = 'text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4'

export default function BlockedUsersCard() {
  const queryClient = useQueryClient()
  const blocks = useMyBlocks()
  const [unblocking, setUnblocking] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function unblock(userId: string) {
    setUnblocking(userId)
    setError('')
    try {
      await authRequest(`/api/me/blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' })
      // Refetches this list, and whatever else the block was hiding.
      await invalidateUserQueries(queryClient)
    } catch (err) {
      setError(writeFailureMessage(err, 'Could not unblock them. Please try again.'))
    } finally {
      setUnblocking(null)
    }
  }

  const rows = blocks.data

  return (
    <div className="card p-5" data-testid="blocked-users-card">
      <div className={LABEL_CLASS}>Blocked users</div>
      <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">
        You and the people you block stop seeing each other&apos;s posts, matches and requests.
      </p>
      {error ? (
        <StatusBanner tone="error" className="mt-3">
          {error}
        </StatusBanner>
      ) : null}
      {rows ? (
        rows.length === 0 ? (
          <p className="text-[13px] text-[var(--color-txt-2)] mt-3">You have not blocked anyone.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-border)]">
            {rows.map((row) => (
              <li key={row.userId} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0 truncate text-[13px] font-medium text-[var(--color-txt-0)]">{row.displayName}</span>
                <button
                  type="button"
                  onClick={() => void unblock(row.userId)}
                  disabled={unblocking !== null}
                  aria-label={`Unblock ${row.displayName}`}
                  className="btn btn-secondary text-[12px] px-3 py-1.5 shrink-0 disabled:opacity-50"
                >
                  {unblocking === row.userId ? 'Unblocking…' : 'Unblock'}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : blocks.isError ? (
        <StatusBanner tone="error" className="mt-3">
          Could not load your blocked users. Please try again later.
        </StatusBanner>
      ) : (
        <p className="text-[13px] text-[var(--color-txt-3)] mt-3">Loading…</p>
      )}
    </div>
  )
}
