import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { linkifyText, stripHtml } from '../lib/linkifyText'
import Icon from '../components/Icons'
import { CAMPUS_EVENTS_CALENDAR, useMyCalendar } from '../lib/queries/userData'
import PageTitle from '../components/PageTitle'

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

function isToday(dateString: string) {
  return new Date(dateString).toDateString() === new Date().toDateString()
}

// The departures-row date block: short weekday over the day of the month.
function dateBlock(dateString: string) {
  const date = new Date(dateString)
  return { day: date.toLocaleDateString(undefined, { weekday: 'short' }), date: date.getDate() }
}

export default function FreeFood() {
  const { onboarding } = useAuth()
  // The same calendar window the Events page reads, one cache entry for both (#327).
  const calendarQuery = useMyCalendar<CalendarItem>(CAMPUS_EVENTS_CALENDAR)
  const items = useMemo<CalendarItem[]>(() => calendarQuery.data?.items ?? [], [calendarQuery.data])
  const loading = calendarQuery.isPending
  // isPending turns false once the retries are spent, so a failed read fell
  // through to "No free-food events right now". With no earlier answer
  // to show, the page says it failed and offers a retry.
  const loadFailed = calendarQuery.isError && !calendarQuery.data

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
    <div className="page r-din">
      <PageTitle>Free Food</PageTitle>
      <header className="page-head">
        <div>
          <div className="flex items-center gap-3">
            <span className="route-badge lg" aria-hidden="true">
              <Icon name="coffee" size={22} />
            </span>
            <h1 className="page-title">Free Food</h1>
          </div>
          <p className="page-sub">
            {loadFailed
              ? 'Upcoming events on your calendar that mention free food - pizza, snacks, refreshments, and more.'
              : `${freeFoodItems.length} upcoming event${freeFoodItems.length === 1 ? '' : 's'} on your calendar that mention free food - pizza, snacks, refreshments, and more.`}
          </p>
        </div>
      </header>

      {hasNoSources && (
        <section className="card card-pad mb-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <span className="route-badge">
              <Icon name="calendar" size={18} />
            </span>
            <div className="flex-1 min-w-[200px]">
              <div className="card-title">Connect a calendar source</div>
              <p className="card-sub text-[13px] max-w-[640px]">
                Import campus events from Brightspace so free-food events can show up here.
              </p>
            </div>
            <Link to="/setup" className="btn btn-primary w-fit">
              <Icon name="calendar" size={15} />
              Connect source
            </Link>
          </div>
        </section>
      )}

      {loading ? (
        <div className="card card-pad text-[14px] text-[var(--color-txt-2)]">Loading free-food events…</div>
      ) : loadFailed ? (
        <div className="card card-pad" role="alert">
          <div className="empty row">
            <span className="ico">
              <Icon name="alert" size={18} />
            </span>
            <div>
              <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">Could not load your calendar</div>
              <p className="text-[13px] mt-0.5">
                Free-food events are not shown. Check your connection and try again.
              </p>
              <button
                type="button"
                onClick={() => void calendarQuery.refetch()}
                disabled={calendarQuery.isFetching}
                className="btn btn-secondary btn-sm mt-3"
              >
                {calendarQuery.isFetching ? 'Trying again…' : 'Try again'}
              </button>
            </div>
          </div>
        </div>
      ) : freeFoodItems.length === 0 ? (
        <div className="card card-pad">
          <div className="empty row">
            <span className="ico">
              <Icon name="coffee" size={18} />
            </span>
            <div>
              <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No free-food events right now</div>
              <p className="text-[13px] mt-0.5">
                When an upcoming event mentions free food, it will appear here automatically.{' '}
                <Link to="/events" className="font-display font-bold text-[var(--color-accent)] hover:underline underline-offset-[3px]">Browse all events</Link>.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <section className="card card-pad">
          {Object.entries(grouped).map(([date, dateItems], groupIdx) => (
            <div key={date} className={groupIdx > 0 ? 'mt-2' : ''}>
              <div className="eyebrow bare">
                {date}
              </div>
              <ol className="dep">
                {dateItems.map((item) => {
                  const block = dateBlock(item.startTime)
                  return (
                    <li key={item.id} className={isToday(item.startTime) ? 'urgent' : undefined}>
                      {/* No end column: the Free food badge leads the meta
                          line, as on Events, so the title keeps the width. */}
                      <div className="dep-row items-start grid-cols-[48px_minmax(0,1fr)]">
                        <span className="when" aria-hidden="true">
                          <span>{block.day}</span>
                          <b>{block.date}</b>
                        </span>
                        <div className="body">
                          <div className="ttl line-clamp-2">
                            {item.title}
                          </div>
                          <div className="meta flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-1.5">
                            <span className="badge badge-route">
                              Free food
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Icon name="clock" size={12} />
                              {formatTime(item.startTime)}
                            </span>
                            {item.location && (
                              <span className="inline-flex items-center gap-1 min-w-0 max-w-full truncate">
                                <Icon name="mapPin" size={12} />
                                {item.location.split(' (')[0].slice(0, 30)}
                              </span>
                            )}
                          </div>
                          {item.description && (
                            <p className="text-[13px] text-[var(--color-txt-2)] mt-2 line-clamp-2 [overflow-wrap:anywhere]">
                              {linkifyText(stripHtml(item.description).slice(0, 200), { maxDisplayLength: 60 })}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
