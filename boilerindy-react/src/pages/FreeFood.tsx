import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { linkifyText, stripHtml } from '../lib/linkifyText'
import Icon from '../components/Icons'

// Dedicated Free Food feed (issue #46): campus events flagged by the server's
// keyword matcher (item.freeFood). Reuses the same /api/me/calendar source as
// the Events page, then narrows to free-food events.

type CalendarItem = {
  id: string
  title?: string
  startTime: string
  location?: string
  description?: string
  freeFood?: boolean
  [key: string]: unknown
}

function formatDate(dateString: string) {
  const date = new Date(dateString)
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (date.toDateString() === now.toDateString()) return 'Today'
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(dateString: string) {
  const date = new Date(dateString)
  if (date.getHours() === 0 && date.getMinutes() === 0) return 'All day'
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function isPast(dateString: string) {
  return new Date(dateString) < new Date()
}

export default function FreeFood() {
  const { onboarding } = useAuth()
  const [items, setItems] = useState<CalendarItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const res = (await authRequest('/api/me/calendar?categories=campus_event,event,deadline&limit=500')) as { items?: CalendarItem[] }
        if (!cancelled) setItems(res.items || [])
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load free-food events:', error)
          setItems([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const freeFoodItems = useMemo(
    () =>
      items
        .filter((item) => item.freeFood && !isPast(item.startTime))
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()),
    [items],
  )

  const grouped = useMemo(() => {
    const groups: Record<string, CalendarItem[]> = {}
    for (const item of freeFoodItems) {
      const key = formatDate(item.startTime)
      if (!groups[key]) groups[key] = []
      groups[key].push(item)
    }
    return groups
  }, [freeFoodItems])

  const hasNoSources = onboarding?.linkedSourceCount === 0

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8 pb-24 transition-opacity duration-500 opacity-100">
      <div className="mb-6 animate-fade-in-up">
        <div className="flex items-center gap-2">
          <span className="text-2xl" aria-hidden="true">🍕</span>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Free Food</h1>
        </div>
        <p className="text-[14px] text-[var(--color-txt-2)] mt-1 max-w-[680px]">
          {freeFoodItems.length} upcoming event{freeFoodItems.length === 1 ? '' : 's'} on your calendar that mention free food — pizza, snacks, refreshments, and more.
        </p>
      </div>

      {hasNoSources && (
        <div className="card p-5 mb-6 border-[var(--color-gold)]/30 bg-[var(--color-gold)]/8 animate-fade-in-up">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="text-[16px] font-semibold text-[var(--color-txt-0)]">Connect a calendar source</div>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1 max-w-[640px]">
                Import campus events from Brightspace so free-food events can show up here.
              </p>
            </div>
            <Link to="/setup" className="btn btn-primary text-[13px] px-5 py-2.5 w-fit">
              <Icon name="calendar" size={15} />
              Connect source
            </Link>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-[var(--color-txt-2)]">Loading free-food events…</div>
      ) : freeFoodItems.length === 0 ? (
        <div className="card p-8 text-center">
          <span className="text-3xl block mb-3" aria-hidden="true">🍕</span>
          <div className="text-[var(--color-txt-1)] font-medium">No free-food events right now</div>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
            When an upcoming event mentions free food, it will appear here automatically.{' '}
            <Link to="/events" className="text-[var(--color-accent)] hover:underline">Browse all events</Link>.
          </p>
        </div>
      ) : (
        <div className="space-y-6 animate-fade-in-up stagger-1">
          {Object.entries(grouped).map(([date, dateItems]) => (
            <div key={date}>
              <div className="text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">
                {date}
              </div>
              <div className="space-y-2">
                {dateItems.map((item) => (
                  <div key={item.id} className="card p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center shrink-0 text-xl" aria-hidden="true">
                        🍕
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium text-[var(--color-txt-0)] text-[14px] line-clamp-2">
                            {item.title}
                          </div>
                          <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                            Free food
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 text-[12px] text-[var(--color-txt-2)]">
                          <span className="flex items-center gap-1">
                            <Icon name="clock" size={12} />
                            {formatTime(item.startTime)}
                          </span>
                          {item.location && (
                            <span className="flex items-center gap-1 truncate">
                              <Icon name="mapPin" size={12} />
                              {item.location.split(' (')[0].slice(0, 30)}
                            </span>
                          )}
                        </div>
                        {item.description && (
                          <p className="text-[12px] text-[var(--color-txt-2)] mt-2 line-clamp-2 [overflow-wrap:anywhere]">
                            {linkifyText(stripHtml(item.description).slice(0, 200), { maxDisplayLength: 60 })}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
