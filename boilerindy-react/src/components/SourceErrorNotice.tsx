import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { authRequest } from '../lib/authApi'
import Icon from './Icons'

type Source = { id: string; label: string; sourceType?: string; status?: string; lastError?: string | null }

// Issue #12: a Brightspace or Purdue feed that stopped syncing (expired link,
// deleted calendar) used to show only as a status badge on the Connect page.
// This puts it where students actually look, with the way back. Renders
// nothing while loading, on a request failure, or when every source is fine.
export default function SourceErrorNotice({ className = '' }: { className?: string }) {
  const [broken, setBroken] = useState<Source[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = (await authRequest('/api/me/sources')) as { sources?: Source[] }
        if (alive) setBroken((res?.sources || []).filter((s) => s.status === 'error'))
      } catch {
        // The page works without the notice.
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  if (broken.length === 0) return null

  return (
    <div
      role="status"
      data-testid="source-error-notice"
      className={`card p-4 flex items-start gap-3 text-[13px] bg-[var(--color-error)]/10 border-[var(--color-error)]/20 text-[var(--color-txt-1)] ${className}`}
    >
      <Icon name="alert" size={16} className="shrink-0 mt-0.5 text-[var(--color-error)]" />
      <div className="min-w-0">
        {broken.map((s) => (
          <p key={s.id}>
            <span className="font-medium text-[var(--color-txt-0)]">{s.label}</span> stopped syncing
            {s.lastError ? `: ${s.lastError}` : '.'}
          </p>
        ))}
        <Link to="/setup" className="inline-block mt-1.5 font-medium text-[var(--color-accent)] hover:underline">
          Reconnect it in Calendar sources
        </Link>
      </div>
    </div>
  )
}
