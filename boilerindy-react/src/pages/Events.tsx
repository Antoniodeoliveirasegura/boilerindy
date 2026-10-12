import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { linkifyText, stripHtml } from '../lib/linkifyText'
import AiMarkdown from '../components/AiMarkdown'
import Icon from '../components/Icons'
import { localIsoDate } from '../lib/localDate'
import { aiCacheKey, readAiCache, writeAiCache } from '../lib/aiInsightCache'
import { CAMPUS_EVENTS_CALENDAR, useMyCalendar } from '../lib/queries/userData'
import PageTitle from '../components/PageTitle'

type EventItem = {
  id: string
  category?: string
  title?: string
  startTime: string
  location?: string
  description?: string
  freeFood?: boolean
}

// Category labels. Every event row sits on the Events line (one route per
// card), so a category is a label, not a colour.
const categoryConfig: Record<string, { label: string }> = {
  campus_event: { label: 'Campus Event' },
  event: { label: 'Event' },
  deadline: { label: 'Deadline' },
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

function getRelativeTime(dateString: string) {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffDays < 0) return 'Past'
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays <= 7) return `${diffDays} days`
  if (diffDays <= 14) return '1-2 weeks'
  return `${Math.ceil(diffDays / 7)} weeks`
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

// Keyed by user (issue #219) and the local calendar day; lib/localDate explains
// why not toISOString(). Null (no user yet) skips the cache.
function getRecsCacheKey(userId: string | undefined) {
  return userId ? aiCacheKey('event-recs', userId, localIsoDate()) : null
}

export default function Events() {
  const { user, onboarding } = useAuth()
  const userId = user?.id as string | undefined
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  // The same calendar window Free Food reads, one cache entry for both (#327).
  const calendarQuery = useMyCalendar<EventItem>(CAMPUS_EVENTS_CALENDAR)
  const items = useMemo<EventItem[]>(() => calendarQuery.data?.items ?? [], [calendarQuery.data])
  const loading = calendarQuery.isPending
  const [showPast, setShowPast] = useState(false)
  const [freeFoodOnly, setFreeFoodOnly] = useState(false)
  const [selectedItem, setSelectedItem] = useState<EventItem | null>(null)

  const [eventRecs, setEventRecs] = useState<string | null>(() => {
    return readAiCache(getRecsCacheKey(userId))?.text ?? null
  })
  const [recsLoading, setRecsLoading] = useState(false)
  // Recommendations that land after sign-out unmounted the page must not write
  // the cache back once sign-out has cleared it (issue #219).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const generateRecs = () => {
    setRecsLoading(true)
    fetch('/api/assistant', {
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
      .then((r) => r.json())
      .then((d) => {
        if (d.reply && mountedRef.current) {
          setEventRecs(d.reply)
          writeAiCache(getRecsCacheKey(userId), d.reply)
        }
      })
      .catch(() => {})
      .finally(() => setRecsLoading(false))
  }

  const filteredItems = useMemo(() => {
    let filtered = items
    
    if (selectedCategories.length > 0) {
      filtered = filtered.filter(item => selectedCategories.includes(item.category ?? ''))
    }

    if (!showPast) {
      filtered = filtered.filter(item => !isPast(item.startTime))
    }

    if (freeFoodOnly) {
      filtered = filtered.filter(item => item.freeFood)
    }

    return filtered.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  }, [items, selectedCategories, showPast, freeFoodOnly])

  const groupedItems = useMemo(() => {
    const groups: Record<string, EventItem[]> = {}
    for (const item of filteredItems) {
      const dateKey = formatDate(item.startTime)
      if (!groups[dateKey]) groups[dateKey] = []
      groups[dateKey].push(item)
    }
    return groups
  }, [filteredItems])

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of items) {
      const cat = item.category ?? 'event'
      counts[cat] = (counts[cat] || 0) + 1
    }
    return Object.entries(counts).map(([id, count]) => ({
      id,
      label: categoryConfig[id]?.label || id,
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

  return (
    <div className="page">
      <PageTitle>Campus Events</PageTitle>
      <header className="page-head">
        <div>
          <h1 className="page-title">Campus Events</h1>
          <p className="page-sub tnum">
            {filteredItems.length} upcoming events from your calendar
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
            className={`pill min-h-[44px] md:min-h-[34px] whitespace-nowrap ${freeFoodOnly ? 'pill-active' : ''}`}
            title="Show only events with free food"
          >
            <span aria-hidden="true">🍕</span>
            Free food
          </button>
          <label className="pill min-h-[44px] cursor-pointer gap-2 select-none whitespace-nowrap md:min-h-[34px]">
            <input
              type="checkbox"
              checked={showPast}
              onChange={(e) => setShowPast(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-[var(--color-txt-0)]"
            />
            Show past events
          </label>
          <button onClick={() => void calendarQuery.refetch()} className="btn btn-secondary btn-sm max-md:px-0">
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

      {categoryCounts.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          <button
            onClick={() => setSelectedCategories([])}
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
              <div className="card-title">Recommended for You</div>
            </div>
            <button
              onClick={generateRecs}
              disabled={recsLoading}
              className="head-link disabled:opacity-40"
            >
              {recsLoading ? 'Thinking…' : eventRecs ? 'Refresh' : 'Get Picks'}
            </button>
          </div>
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
      ) : filteredItems.length === 0 ? (
        <div className="empty row">
          <span className="ico shrink-0">
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
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-4 lg:gap-6 items-start">
          <section className="card card-pad r-evt min-w-0">
            {Object.entries(groupedItems).map(([date, dateItems], groupIdx) => (
              <div key={date} className={groupIdx > 0 ? 'mt-2' : ''}>
                <div className="eyebrow bare">
                  {date}
                </div>
                <ol className="dep -mx-3">
                  {dateItems.map(item => {
                    const config = categoryConfig[item.category ?? 'event'] || categoryConfig.event
                    const isSelected = selectedItem?.id === item.id
                    const past = isPast(item.startTime)
                    const block = dateBlock(item.startTime)

                    return (
                      <li key={item.id} className={isToday(item.startTime) ? 'urgent' : undefined}>
                        <button
                          onClick={() => setSelectedItem(item)}
                          className={`px-3 rounded-[var(--radius-md)] transition-colors ${
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
                                  <span aria-hidden="true">🍕</span>
                                  Free food
                                </span>
                              )}
                              {/* On the selected row's route tint the label keeps a surface plate. */}
                              <span className={`badge badge-route ${isSelected ? 'bg-[var(--color-surface)]' : ''}`}>
                                {config.label}
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

          <div className="lg:sticky lg:top-24 min-w-0">
            {selectedItem ? (
              <div className="card card-pad r-evt min-w-0 overflow-hidden">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <span className="badge badge-route">
                    {(categoryConfig[selectedItem.category ?? 'event'] || categoryConfig.event).label}
                  </span>
                  <button
                    onClick={() => setSelectedItem(null)}
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
                    <span className="inline-grid place-items-center w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-stat)] text-[var(--color-txt-2)] shrink-0">
                      <Icon name="calendar" size={15} />
                    </span>
                    <div>
                      <div className="text-[var(--color-txt-0)] font-display font-bold">{formatDate(selectedItem.startTime)}</div>
                      <div className="text-[var(--color-txt-2)] text-[12.5px] tnum">{formatTime(selectedItem.startTime)}</div>
                    </div>
                  </div>
                  
                  {selectedItem.location && (
                    <div className="flex items-start gap-3 text-[14px] min-w-0">
                      <span className="inline-grid place-items-center w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-stat)] text-[var(--color-txt-2)] shrink-0">
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
                    <span className="inline-grid place-items-center w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-stat)] text-[var(--color-txt-2)] shrink-0">
                      <Icon name="clock" size={15} />
                    </span>
                    <div className={`tnum ${isPast(selectedItem.startTime) ? 'text-[var(--color-txt-3)]' : 'text-[var(--color-txt-1)]'}`}>
                      {isPast(selectedItem.startTime) ? 'Event has passed' : `In ${getRelativeTime(selectedItem.startTime)}`}
                    </div>
                  </div>
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
              <div className="empty row">
                <span className="ico shrink-0">
                  <Icon name="users" size={18} />
                </span>
                <p className="text-[13px]">Select an event to view details</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
