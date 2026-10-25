import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { linkifyText, stripHtml } from '../lib/linkifyText'
import AiMarkdown from '../components/AiMarkdown'
import Icon from '../components/Icons'
import { localIsoDate } from '../lib/localDate'
import { aiCacheKey, readAiCache, writeAiCache } from '../lib/aiInsightCache'
import {
  activeSourceFilter,
  eventSourceCounts,
  hasEnded,
  isOngoing,
  isDowntownEvent,
  listedTime,
  listingLink,
  matchesSourceFilter,
  runsFromEarlierDay,
  untilLabel,
  type CampusEventFields,
  type SourceFilter,
} from '../lib/campusEvents'
import { CAMPUS_EVENTS_CALENDAR, useMyCalendar } from '../lib/queries/userData'
import PageTitle from '../components/PageTitle'
import EventSourceFilter from '../components/EventSourceFilter'

// Rows from the student's own calendar, and the shared campus events (issue
// #30) the server adds while its feed is on, marked `shared` with their
// source (lib/campusEvents).
type EventItem = CampusEventFields & {
  id: string
  category?: string
  title?: string
  location?: string
  description?: string
  freeFood?: boolean
}

// Category labels for the row badge, the details badge and the filter pills.
// Every event row sits on the Events line (one route per card), so a category
// is a label, not a colour. The page asks for campus_event, event and deadline
// (CAMPUS_EVENTS_CALENDAR); any other category the calendar sends still reads
// as itself, singular (CALENDAR_CATEGORY_LABELS on the server has the plural
// names). Every exam and assignment used to wear an "Event" badge while its
// pill read "Exam" or "Assignment".
const CATEGORY_LABEL: Record<string, string> = {
  campus_event: 'Campus Event',
  event: 'Event',
  deadline: 'Deadline',
  exam: 'Exam',
  assignment: 'Assignment',
  quiz: 'Quiz',
  project: 'Project',
  lab: 'Lab',
  class: 'Class',
  resource: 'Resource',
}

// An item without a category counts, filters and reads as an Event, and so
// does a downtown listing (issue #30): the server lists it as a campus_event,
// and its badge beside "Downtown" must not say a museum night is a campus event.
function categoryOf(item: EventItem) {
  if (isDowntownEvent(item)) return 'event'
  return item.category || 'event'
}

// An unknown category reads as its own words ("career_fair" as "Career fair").
function categoryLabel(category: string) {
  const known = CATEGORY_LABEL[category]
  if (known) return known
  const words = category.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : CATEGORY_LABEL.event
}

function formatDate(dateString: string) {
  const date = new Date(dateString)
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const isToday = date.toDateString() === now.toDateString()
  const isTomorrow = date.toDateString() === tomorrow.toDateString()

  if (isToday) return 'Today'
  if (isTomorrow) return 'Tomorrow'

  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(dateString: string) {
  const date = new Date(dateString)
  if (date.getHours() === 0 && date.getMinutes() === 0) return 'All day'
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// Midnight of the local calendar day, so two times compare by date, not by
// elapsed hours.
function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// Counts calendar days, as the Today and Tomorrow date lines do. Rounding up
// elapsed 24-hour periods made an event three hours away read "In Tomorrow"
// under a "Today" date line, and every later event one day too far.
// Math.round absorbs the 23 and 25 hour days at a clock change.
function getRelativeTime(dateString: string) {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / (1000 * 60 * 60 * 24))

  if (diffMs < 0) return 'Event has passed'
  if (diffDays === 0) {
    const hours = Math.round(diffMs / (1000 * 60 * 60))
    if (hours < 1) return 'In under an hour'
    return `In ${hours} hour${hours === 1 ? '' : 's'}`
  }
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays <= 7) return `In ${diffDays} days`
  if (diffDays <= 14) return 'In 1-2 weeks'
  return `In ${Math.ceil(diffDays / 7)} weeks`
}

// The clock line of a row: its start time, or until when it runs for a row
// still on from an earlier day (lib/campusEvents).
function timeLine(item: EventItem) {
  if (!runsFromEarlierDay(item)) return formatTime(item.startTime)
  const until = untilLabel(item)
  return until.charAt(0).toUpperCase() + until.slice(1)
}

// The details card's relative time: a row on right now says until when.
function relativeLine(item: EventItem) {
  return isOngoing(item) ? `On now · ${untilLabel(item)}` : getRelativeTime(item.startTime)
}

// Where the listed events come from: the shared rows are the campus calendars'.
function sourcesLine(items: EventItem[], hasNoSources: boolean) {
  if (!items.some((item) => item.shared)) return 'from your calendar'
  return hasNoSources ? 'from campus calendars' : 'from your calendar and campus calendars'
}

function isToday(dateString: string) {
  return new Date(dateString).toDateString() === new Date().toDateString()
}

// The departures-row date block: short weekday over the day of the month.
function dateBlock(dateString: string) {
  const date = new Date(dateString)
  return { day: date.toLocaleDateString(undefined, { weekday: 'short' }), date: date.getDate() }
}

// Keyed by user (issue #219) and the local calendar day; lib/localDate explains
// why not toISOString(). Null (no user yet) skips the cache.
function getRecsCacheKey(userId: string | undefined) {
  return userId ? aiCacheKey('event-recs', userId, localIsoDate()) : null
}

// Shown when the assistant fails without saying why (no response, or a body
// with no message). The chat panel says the same.
const ASSISTANT_UNREACHABLE = "Couldn't reach the assistant right now. Try again in a moment."

type AssistantAnswer = { reply: string } | { error: string }

// The picks from an /api/assistant response, or the message to show instead.
// Get Picks used to read only `reply`, so the hourly limit's 429 and the 502
// when Groq fails put the button back with nothing said. A 200 marked
// busy or offline carries a status line, not picks, so it is shown as the
// message and never cached as the day's picks.
async function readAssistantAnswer(res: Response): Promise<AssistantAnswer> {
  const data = (await res.json().catch(() => null)) as { reply?: unknown; source?: unknown; error?: unknown } | null
  const reply = typeof data?.reply === 'string' ? data.reply : ''
  if (res.ok && reply && data?.source !== 'busy' && data?.source !== 'offline') return { reply }
  // The limiter sends `error` as a string; the app's error handler sends { message }.
  const error = data?.error as string | { message?: unknown } | null | undefined
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
  return { error: message || reply || ASSISTANT_UNREACHABLE }
}

export default function Events() {
  const { user, onboarding } = useAuth()
  const userId = user?.id as string | undefined
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  // The same calendar window Free Food reads, one cache entry for both (#327).
  const calendarQuery = useMyCalendar<EventItem>(CAMPUS_EVENTS_CALENDAR)
  const items = useMemo<EventItem[]>(() => calendarQuery.data?.items ?? [], [calendarQuery.data])
  const loading = calendarQuery.isPending
  // isPending turns false once the retries are spent, so a failed read fell
  // through to "No events found" and told the student their calendar was
  // empty. With no earlier answer to show, the page says it failed.
  const loadFailed = calendarQuery.isError && !calendarQuery.data
  const [showPast, setShowPast] = useState(false)
  const [freeFoodOnly, setFreeFoodOnly] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [selectedItem, setSelectedItem] = useState<EventItem | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  const [eventRecs, setEventRecs] = useState<string | null>(() => {
    return readAiCache(getRecsCacheKey(userId))?.text ?? null
  })
  const [recsLoading, setRecsLoading] = useState(false)
  const [recsError, setRecsError] = useState('')
  // Recommendations that land after sign-out unmounted the page must not write
  // the cache back once sign-out has cleared it (issue #219).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const generateRecs = async () => {
    setRecsLoading(true)
    setRecsError('')
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: 'Pick 2-3 upcoming campus events I should attend based on my free time this week. One "-" bullet each: the event name in bold, then the day and time, then one sentence on why it fits my schedule. No intro line, no closing line.',
          }],
        }),
      })
      const answer = await readAssistantAnswer(res)
      if (!mountedRef.current) return
      if ('error' in answer) {
        setRecsError(answer.error)
        return
      }
      setEventRecs(answer.reply)
      writeAiCache(getRecsCacheKey(userId), answer.reply)
    } catch {
      if (mountedRef.current) setRecsError(ASSISTANT_UNREACHABLE)
    } finally {
      setRecsLoading(false)
    }
  }

  // Below lg the details card stacks under the whole list, a screen or more
  // below the row, so a tap on a phone seemed to do nothing. Bring the
  // card into view there; from lg it sits beside the list and is already in
  // view. No `behavior`: the page's CSS scroll-behavior is smooth, and auto
  // when the student asks for reduced motion.
  const selectEvent = (item: EventItem) => {
    setSelectedItem(item)
    const wide = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches
    if (!wide) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start' }))
  }

  // Purdue's calendars, IU's or the student's own, counted like the category
  // pills over every row.
  const sourceCounts = useMemo(() => eventSourceCounts(items), [items])
  const source = activeSourceFilter(sourceFilter, sourceCounts)

  const filteredItems = useMemo(() => {
    let filtered = items

    if (selectedCategories.length > 0) {
      filtered = filtered.filter(item => selectedCategories.includes(categoryOf(item)))
    }

    if (source !== 'all') {
      filtered = filtered.filter(item => matchesSourceFilter(item, source))
    }

    // A row stays listed until it is over, so an exhibit open for weeks shows.
    if (!showPast) {
      filtered = filtered.filter(item => !hasEnded(item))
    }

    if (freeFoodOnly) {
      filtered = filtered.filter(item => item.freeFood)
    }

    return filtered.sort((a, b) => new Date(listedTime(a)).getTime() - new Date(listedTime(b)).getTime())
  }, [items, selectedCategories, source, showPast, freeFoodOnly])

  const groupedItems = useMemo(() => {
    const groups: Record<string, EventItem[]> = {}
    for (const item of filteredItems) {
      const dateKey = formatDate(listedTime(item))
      if (!groups[dateKey]) groups[dateKey] = []
      groups[dateKey].push(item)
    }
    return groups
  }, [filteredItems])

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of items) {
      const cat = categoryOf(item)
      counts[cat] = (counts[cat] || 0) + 1
    }
    return Object.entries(counts).map(([id, count]) => ({
      id,
      label: categoryLabel(id),
      count
    }))
  }, [items])

  const toggleCategory = (catId: string) => {
    setSelectedCategories(prev => 
      prev.includes(catId) 
        ? prev.filter(c => c !== catId)
        : [...prev, catId]
    )
  }

  const hasNoSources = onboarding?.linkedSourceCount === 0
  const selectedListing = selectedItem ? listingLink(selectedItem) : null

  return (
    <div className="page">
      <PageTitle>Campus Events</PageTitle>
      <header className="page-head">
        <div>
          <h1 className="page-title">Campus Events</h1>
          <p className="page-sub tnum">
            {loadFailed
              ? 'Upcoming events from your calendar'
              : `${filteredItems.length} upcoming events ${sourcesLine(items, hasNoSources)}`}
          </p>
        </div>
        {/* Filter toggles as one row of plates, the same height as the
            Refresh btn-sm (44px on phones, 34px up), as on Assignments. On
            phones Refresh is a square so the row fits; its name stays "Refresh". */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFreeFoodOnly((v) => !v)}
            aria-pressed={freeFoodOnly}
            className={`pill md:min-h-[34px] whitespace-nowrap ${freeFoodOnly ? 'pill-active' : ''}`}
            title="Show only events with free food"
          >
            <span aria-hidden="true" className="flex">
              <Icon name="coffee" size={14} />
            </span>
            Free food
          </button>
          <label className="pill cursor-pointer gap-2 select-none whitespace-nowrap md:min-h-[34px]">
            <input
              type="checkbox"
              checked={showPast}
              onChange={(e) => setShowPast(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-[var(--color-txt-0)]"
            />
            Show past events
          </label>
          <button onClick={() => void calendarQuery.refetch()} className="btn btn-ghost btn-sm max-md:px-0">
            <Icon name="refresh" size={14} />
            <span className="max-md:sr-only">Refresh</span>
          </button>
        </div>
      </header>

      {hasNoSources && (
        <section className="card card-pad r-evt mb-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <span className="route-badge">
              <Icon name="calendar" size={18} />
            </span>
            <div className="flex-1 min-w-[200px]">
              <div className="card-title">
                Connect your Brightspace calendar
              </div>
              <p className="card-sub text-[13px] max-w-[640px]">
                Import campus events, career fairs, workshops, and more from Brightspace.
              </p>
            </div>
            <Link to="/setup" className="btn btn-primary w-fit">
              <Icon name="calendar" size={15} />
              Connect Brightspace
            </Link>
          </div>
        </section>
      )}

      <EventSourceFilter counts={sourceCounts} value={source} onChange={setSourceFilter} />

      {categoryCounts.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          <button
            onClick={() => setSelectedCategories([])}
            aria-pressed={selectedCategories.length === 0}
            className={`pill whitespace-nowrap tnum ${selectedCategories.length === 0 ? 'pill-active' : ''}`}
          >
            All ({items.length})
          </button>
          {categoryCounts.map(cat => {
            const isActive = selectedCategories.includes(cat.id)
            return (
              <button
                key={cat.id}
                onClick={() => toggleCategory(cat.id)}
                aria-pressed={isActive}
                className={`pill whitespace-nowrap tnum ${isActive ? 'pill-active' : ''}`}
              >
                {cat.label} ({cat.count})
              </button>
            )
          })}
        </div>
      )}

      {/* AI Event Recommendations */}
      {!hasNoSources && !loading && items.length > 0 && (
        <section className="card card-pad r-ai mb-6">
          <div className="card-head mb-2">
            <span className="route-badge">
              <Icon name="sparkles" size={18} />
            </span>
            <div>
              <div className="card-title lowercase first-letter:uppercase">Recommended for You</div>
            </div>
            <button
              onClick={() => void generateRecs()}
              disabled={recsLoading}
              className="head-link disabled:opacity-40"
            >
              {recsLoading ? 'Thinking…' : eventRecs ? 'Refresh' : 'Get Picks'}
            </button>
          </div>
          {recsError && (
            <p role="alert" className="text-[13px] text-[var(--color-error)] mb-2">
              {recsError}
            </p>
          )}
          {recsLoading && !eventRecs ? (
            <div className="flex items-center gap-2 text-[14px] text-[var(--color-txt-2)]">
              <div className="w-3.5 h-3.5 border-2 border-[var(--color-txt-2)] border-t-transparent rounded-full animate-spin shrink-0" />
              Finding events that fit your schedule…
            </div>
          ) : eventRecs ? (
            <AiMarkdown className="text-[14px] text-[var(--color-txt-1)]">{eventRecs}</AiMarkdown>
          ) : (
            <p className="text-[13px] text-[var(--color-txt-2)]">
              AI picks campus events that fit your free time. Tap &ldquo;Get Picks&rdquo; to try it.
            </p>
          )}
        </section>
      )}

      {loading ? (
        <div className="card card-pad text-[14px] text-[var(--color-txt-2)]">
          Loading events...
        </div>
      ) : loadFailed ? (
        <div className="card card-pad" role="alert">
          <div className="empty row">
            <span className="ico">
              <Icon name="alert" size={18} />
            </span>
            <div>
              <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">Could not load your calendar</div>
              <p className="text-[13px] mt-0.5">
                Your events are not shown. Check your connection and try again.
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
      ) : filteredItems.length === 0 ? (
        <div className="card card-pad">
          <div className="empty row">
            <span className="ico">
              <Icon name="calendar" size={18} />
            </span>
            <div>
              <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No events found</div>
              <p className="text-[13px] mt-0.5">
                {hasNoSources
                  ? 'Connect your Brightspace calendar to see campus events.'
                  : selectedCategories.length > 0
                    ? 'Try selecting different categories or showing past events.'
                    : 'No upcoming campus events in your calendar.'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-4 lg:gap-6 items-start">
          <section className="card card-pad r-evt min-w-0">
            {Object.entries(groupedItems).map(([date, dateItems], groupIdx) => (
              <div key={date} className={groupIdx > 0 ? 'mt-2' : ''}>
                <div className="eyebrow bare">
                  {date}
                </div>
                <ol className="dep">
                  {dateItems.map(item => {
                    const isSelected = selectedItem?.id === item.id
                    const past = hasEnded(item)
                    const listedAt = listedTime(item)
                    const block = dateBlock(listedAt)
                    const listing = listingLink(item)

                    return (
                      <li key={item.id} className={isToday(listedAt) ? 'urgent' : undefined}>
                        <button
                          onClick={() => selectEvent(item)}
                          className={`-mx-3 w-[calc(100%+24px)] px-3 rounded-[var(--radius-md)] transition-colors ${
                            isSelected
                              ? 'bg-[var(--route-tint)] shadow-[inset_3px_0_0_var(--route)]'
                              : 'hover:bg-[var(--color-surface-hover)]'
                          } ${past ? 'opacity-60' : ''}`}
                        >
                          <span className="when" aria-hidden="true">
                            <span>{block.day}</span>
                            <b>{block.date}</b>
                          </span>
                          <span className="body">
                            <span className="ttl line-clamp-2">
                              {item.title}
                            </span>
                            <span className="meta flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-1.5">
                              {item.freeFood && (
                                <span
                                  className="badge"
                                  title="This event mentions free food"
                                >
                                  <span aria-hidden="true" className="flex">
                                    <Icon name="coffee" size={12} />
                                  </span>
                                  Free food
                                </span>
                              )}
                              {/* On the selected row's route tint the label keeps a surface plate. */}
                              <span className={`badge badge-route ${isSelected ? 'bg-[var(--color-surface)]' : ''}`}>
                                {categoryLabel(categoryOf(item))}
                              </span>
                              {item.shared && (
                                <span className="badge" title={listing ? `Listed on ${listing.host}` : undefined}>
                                  {item.sourceLabel || 'Campus calendar'}
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1">
                                <Icon name="clock" size={12} />
                                {timeLine(item)}
                              </span>
                              {item.location && (
                                <span className="inline-flex items-center gap-1 min-w-0 max-w-full truncate">
                                  <Icon name="mapPin" size={12} />
                                  {item.location.split(' (')[0].slice(0, 30)}
                                </span>
                              )}
                            </span>
                          </span>
                          <span className="end">
                            <Icon name="chevronRight" size={18} />
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ))}
          </section>

          {/* On phones and tablets this column stacks under the whole list, so
              the empty placeholder only shows from lg; a selected event still
              shows. As on Assignments. selectEvent scrolls it into view there,
              and scroll-mt keeps it clear of the fixed top bar. */}
          <div ref={detailRef} className={`lg:sticky lg:top-24 min-w-0 scroll-mt-24 ${selectedItem ? '' : 'hidden lg:block'}`}>
            {selectedItem ? (
              <div className="card card-pad r-evt min-w-0 overflow-hidden">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="badge badge-route">
                      {categoryLabel(categoryOf(selectedItem))}
                    </span>
                    {selectedItem.shared && <span className="badge">{selectedItem.sourceLabel || 'Campus calendar'}</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedItem(null)}
                    aria-label="Close event details"
                    className="btn btn-ghost btn-sm px-2 text-[var(--color-txt-2)]"
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>
                
                <h3 className="text-[20px] leading-tight text-[var(--color-txt-0)] mb-4 break-words">
                  {selectedItem.title}
                </h3>
                
                <div className="space-y-3 mb-5">
                  <div className="flex items-center gap-3 text-[14px]">
                    <span className="ico">
                      <Icon name="calendar" size={15} />
                    </span>
                    <div>
                      <div className="text-[var(--color-txt-0)] font-display font-bold">{formatDate(listedTime(selectedItem))}</div>
                      <div className="text-[var(--color-txt-2)] text-[12.5px] tnum">{timeLine(selectedItem)}</div>
                    </div>
                  </div>
                  
                  {selectedItem.location && (
                    <div className="flex items-start gap-3 text-[14px] min-w-0">
                      <span className="ico">
                        <Icon name="mapPin" size={15} />
                      </span>
                      <div className="text-[var(--color-txt-1)] min-w-0 pt-1 break-words [overflow-wrap:anywhere]">
                        {/^https?:\/\//i.test(selectedItem.location.trim()) ? (
                          <a
                            href={selectedItem.location.trim()}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--color-accent)] hover:underline break-all"
                          >
                            {selectedItem.location.trim().length > 72
                              ? `${selectedItem.location.trim().slice(0, 72)}…`
                              : selectedItem.location.trim()}
                          </a>
                        ) : (
                          selectedItem.location
                        )}
                      </div>
                    </div>
                  )}
                  
                  <div className="flex items-center gap-3 text-[14px]">
                    <span className="ico">
                      <Icon name="clock" size={15} />
                    </span>
                    <div className={`tnum ${hasEnded(selectedItem) ? 'text-[var(--color-txt-3)]' : 'text-[var(--color-txt-1)]'}`}>
                      {relativeLine(selectedItem)}
                    </div>
                  </div>

                  {/* A shared campus event links out to its listing (issue #30). */}
                  {selectedListing && (
                    <div className="flex items-center gap-3 text-[14px] min-w-0">
                      <span className="ico">
                        <Icon name="external" size={15} />
                      </span>
                      <a
                        href={selectedListing.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--color-accent)] hover:underline min-w-0 break-words [overflow-wrap:anywhere]"
                      >
                        View on {selectedListing.host}
                      </a>
                    </div>
                  )}
                </div>
                
                {selectedItem.description && (
                  <div className="pt-4 border-t border-[var(--color-border)] min-w-0">
                    <div className="eyebrow mb-2.5">
                      Details
                    </div>
                    <div className="text-[14px] text-[var(--color-txt-1)] leading-relaxed min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                      {(() => {
                        const full = stripHtml(selectedItem.description)
                        const truncated = full.length > 800
                        const chunk = truncated ? full.slice(0, 800) : full
                        return (
                          <>
                            {linkifyText(chunk, { maxDisplayLength: 96 })}
                            {truncated ? '…' : ''}
                          </>
                        )
                      })()}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="card card-pad">
                <div className="empty">
                  <span className="ico">
                    <Icon name="users" size={18} />
                  </span>
                  <p>Select an event to view details</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
