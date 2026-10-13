import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Icon from '../Icons'
import StatusBanner from '../StatusBanner'
import { authRequest } from '../../lib/authApi'
import { invalidateUserQueries, useMyBlocks } from '../../lib/queries/userData'
import { writeFailureMessage } from '../../lib/writeFailure'

// Blocked users card on Settings (issue #192): everyone the student blocked,
// newest first, each with Unblock. A block works both ways, so the two stop
// seeing each other's posts, matches and requests; unblocking lifts that but
// does not bring back a connection the block ended (docs/moderation.md).
// Blocks other people made take effect and are never listed here.

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
    <section className="card card-pad r-ink" data-testid="blocked-users-card">
      <header className="card-head">
        <span aria-hidden="true" className="route-badge">
          <Icon name="users" />
        </span>
        <div>
          <h2 className="card-title">Blocked users</h2>
        </div>
      </header>
      <p className="mb-4 text-[14px] leading-relaxed text-[var(--color-txt-1)]">
        You and the people you block stop seeing each other&apos;s posts, matches and requests.
      </p>
      {error ? (
        <StatusBanner tone="error" className="mb-3">
          {error}
        </StatusBanner>
      ) : null}
      {rows ? (
        rows.length === 0 ? (
          <div className="empty row">
            {/* The head badge already shows the people glyph; the empty
                state reads as all clear instead. */}
            <span aria-hidden="true" className="ico">
              <Icon name="check" size={18} />
            </span>
            <p>You have not blocked anyone.</p>
          </div>
        ) : (
          <ul className="-mt-1 divide-y divide-[var(--color-border)]">
            {rows.map((row) => (
              <li
                key={row.userId}
                className="flex min-h-14 items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0 truncate font-display text-[15px] font-bold text-[var(--color-txt-0)]">
                  {row.displayName}
                </span>
                <button
                  type="button"
                  onClick={() => void unblock(row.userId)}
                  disabled={unblocking !== null}
                  aria-label={`Unblock ${row.displayName}`}
                  className="btn btn-secondary btn-sm shrink-0"
                >
                  {unblocking === row.userId ? 'Unblocking…' : 'Unblock'}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : blocks.isError ? (
        <StatusBanner tone="error">
          Could not load your blocked users. Please try again later.
        </StatusBanner>
      ) : (
        <p className="text-[14px] text-[var(--color-txt-3)]">Loading…</p>
      )}
    </section>
  )
}
