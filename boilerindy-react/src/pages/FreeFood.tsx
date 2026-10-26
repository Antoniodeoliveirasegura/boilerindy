import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { linkifyText, stripHtml } from '../lib/linkifyText'
import Icon from '../components/Icons'
import ShareButton from '../components/ShareButton'
import { eventLinkParam, linkedEventId, shareUrl } from '../lib/shareLinks'
import { PAGE_PREVIEWS } from '../lib/pagePreviews'
import {
  activeSourceFilter,
  eventSourceCounts,
  followedEventCount,
  hasEnded,
  listedTime,
  listingLink,
  matchesSourceFilter,
  runsFromEarlierDay,
  untilLabel,
  type CampusEventFields,
  type SourceFilter,
} from '../lib/campusEvents'
import { usePublicFreeFood } from '../lib/queries/publicData'
import { CAMPUS_EVENTS_CALENDAR, useMyCalendar } from '../lib/queries/userData'
import { useEntrance } from '../hooks/useEntrance'
import PageTitle from '../components/PageTitle'
import EventSourceFilter from '../components/EventSourceFilter'

// Dedicated Free Food feed (issue #46): campus events flagged by the server's
// keyword matcher (item.freeFood). Reuses the same /api/me/calendar source as
// the Events page, then narrows to free-food events. The shared campus events
// (issue #30) carry the free food their source or the ingest found, and say
// where they came from, with a link out to the listing. Signed-out visitors
// can open the page too (the public preview, issue #366): they get the shared
// rows with free food alone, from GET /api/campus-events/free-food.
//
// Every visitor can share the list, and each shared row (docs/share-links.md).
// A shared row's link (?event=) opens the list on that row; a student's own
// calendar rows get no Share, since a friend could never see them.

type CalendarItem = CampusEventFields & {
  id: string
  title?: string
  location?: string | null
  description?: string | null
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

// The clock line of a row: its start time, or until when it runs for a row
// still on from an earlier day (lib/campusEvents).
function timeLine(item: CalendarItem) {
  if (!runsFromEarlierDay(item)) return formatTime(item.startTime)
  const until = untilLabel(item)
  return until.charAt(0).toUpperCase() + until.slice(1)
}

// Where the listed events come from: the shared rows are the campus calendars',
// and signed out they are all there is.
function sourcesLine(items: CalendarItem[], signedIn: boolean, hasNoSources: boolean) {
  if (!signedIn) return 'on campus calendars'
  if (!items.some((item) => item.shared)) return 'on your calendar'
  return hasNoSources ? 'on campus calendars' : 'on your calendar and campus calendars'
}

function isToday(dateString: string) {
  return new Date(dateString).toDateString() === new Date().toDateString()
}

// The departures-row date block: short weekday over the day of the month.
function dateBlock(dateString: string) {
  const date = new Date(dateString)
  return { day: date.toLocaleDateString(undefined, { weekday: 'short' }), date: date.getDate() }
}

// The share sheet's line for one event: what and when. A message stays in a
// chat for days, so the day is spelled out where the row says "Today".
function eventShareText(item: CalendarItem) {
  const day = new Date(item.startTime).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = formatTime(item.startTime)
  const when = runsFromEarlierDay(item) ? untilLabel(item) : time === 'All day' ? day : `${day}, ${time}`
  return `Free food at ${item.title || 'a campus event'}, ${when}, on BoilerIndy`
}

export default function FreeFood() {
  // One read or the other, once auth has settled: a calendar read while a
  // cold load re-mints a signed-in student's cookie would 401 and bounce them
  // to /login, and a visitor has no calendar to read.
  const { user, loading: authLoading, onboarding } = useAuth()
  const signedIn = !authLoading && Boolean(user)
  // The same calendar window the Events page reads, one cache entry for both (#327).
  const calendarQuery = useMyCalendar<CalendarItem>(CAMPUS_EVENTS_CALENDAR, { enabled: signedIn })
  const publicQuery = usePublicFreeFood({ enabled: !authLoading && !user })
  const feed = signedIn ? calendarQuery : publicQuery
  const items = useMemo<CalendarItem[]>(() => feed.data?.items ?? [], [feed.data])
  const loading = authLoading || feed.isPending
  // isPending turns false once the retries are spent, so a failed read fell
  // through to "No free-food events right now". With no earlier answer
  // to show, the page says it failed and offers a retry.
  const loadFailed = feed.isError && !feed.data

  // Listed until each event is over, as on Events.
  const allFreeFood = useMemo(
    () =>
      items
        .filter((item) => item.freeFood && !hasEnded(item))
        .sort((a, b) => new Date(listedTime(a)).getTime() - new Date(listedTime(b)).getTime()),
    [items],
  )
  // The source pills count the free-food list, not the whole calendar. Signed
  // out every row is a campus calendar's, so there is no My calendar pill, and
  // no "Clubs I follow" either (issue #16): a visitor follows no club, and the
  // public read marks none.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const sourceCounts = useMemo(
    () => eventSourceCounts(allFreeFood).filter((count) => signedIn || count.id !== 'mine'),
    [allFreeFood, signedIn],
  )
  const followedCount = useMemo(() => (signedIn ? followedEventCount(allFreeFood) : null), [allFreeFood, signedIn])
  const source = activeSourceFilter(sourceFilter, sourceCounts, followedCount)
  const freeFoodItems = useMemo(
    () => (source === 'all' ? allFreeFood : allFreeFood.filter((item) => matchesSourceFilter(item, source))),
    [allFreeFood, source],
  )

  const grouped = useMemo(() => {
    const groups: Record<string, CalendarItem[]> = {}
    for (const item of freeFoodItems) {
      const key = formatDate(listedTime(item))
      if (!groups[key]) groups[key] = []
      groups[key].push(item)
    }
    return groups
  }, [freeFoodItems])

  // The day groups rise in when the events land and when a source pill swaps
  // them (hooks/useEntrance).
  const daysRef = useEntrance(!loading && !loadFailed, sourceFilter)

  // The event a shared link names (?event=): its row is marked and scrolled to
  // once the list is in, and a link to one no longer listed (over, or taken
  // down by its calendar) says so above the rest.
  const [searchParams] = useSearchParams()
  const linkedId = linkedEventId(searchParams.get('event'))
  const linkedListed = linkedId !== null && allFreeFood.some((item) => item.id === linkedId)
  const linkedRowRef = useRef<HTMLDivElement | null>(null)
  const scrolledTo = useRef<string | null>(null)
  useEffect(() => {
    if (!linkedListed || scrolledTo.current === linkedId) return
    scrolledTo.current = linkedId
    linkedRowRef.current?.scrollIntoView?.({ block: 'center' })
  }, [linkedId, linkedListed])

  // Signed out, onboarding is the empty default (no linked source), and the
  // card's link to /setup would only bounce a visitor to sign in.
  const hasNoSources = signedIn && onboarding?.linkedSourceCount === 0

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
          {/* No count until the list is in: "0 upcoming events" while it loads
              reads as none, and would be the first thing a visitor from a
              shared link sees. */}
          <p className="page-sub">
            {loading || loadFailed
              ? `Upcoming events ${signedIn ? 'on your calendar' : 'on campus calendars'} that mention free food - pizza, snacks, refreshments, and more.`
              : `${freeFoodItems.length} upcoming event${freeFoodItems.length === 1 ? '' : 's'} ${sourcesLine(items, signedIn, hasNoSources)} that mention free food - pizza, snacks, refreshments, and more.`}
          </p>
        </div>
        {/* The whole list, never the event a link opened it on. */}
        <div className="flex flex-wrap items-center gap-2">
          <ShareButton
            page="free-food"
            getUrl={() => shareUrl('free-food', window.location.href, { event: null })}
            title={PAGE_PREVIEWS['free-food'].title}
            text="Free food at campus events, on BoilerIndy"
          />
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

      {linkedId && !loading && !loadFailed && !linkedListed && (
        <div className="card card-pad mb-4" role="status" data-linked-event-missing>
          <div className="empty row">
            <span className="ico">
              <Icon name="clock" size={18} />
            </span>
            <div>
              <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">That event is not listed any more</div>
              <p className="text-[13px] mt-0.5">
                It may be over, or its calendar took it down.
                {freeFoodItems.length > 0 && ' The rest of the free food coming up is below.'}
              </p>
            </div>
          </div>
        </div>
      )}

      <EventSourceFilter counts={sourceCounts} value={source} onChange={setSourceFilter} followedCount={followedCount} />

      {loading ? (
        <div className="card card-pad text-[14px] text-[var(--color-txt-2)]">Loading free-food events…</div>
      ) : loadFailed ? (
        <div className="card card-pad" role="alert">
          <div className="empty row">
            <span className="ico">
              <Icon name="alert" size={18} />
            </span>
            <div>
              <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">
                {signedIn ? 'Could not load your calendar' : 'Could not load campus events'}
              </div>
              <p className="text-[13px] mt-0.5">
                Free-food events are not shown. Check your connection and try again.
              </p>
              <button
                type="button"
                onClick={() => void feed.refetch()}
                disabled={feed.isFetching}
                className="btn btn-secondary btn-sm mt-3"
              >
                {feed.isFetching ? 'Trying again…' : 'Try again'}
              </button>
            </div>
          </div>
        </div>
      ) : freeFoodItems.length === 0 && source === 'following' ? (
        <div className="card card-pad" data-following-empty>
          <div className="empty row">
            <span className="ico">
              <Icon name="coffee" size={18} />
            </span>
            <div>
              <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No free food from clubs you follow</div>
              <p className="text-[13px] mt-0.5">
                When a club you follow lists an event with free food, it shows up here.{' '}
                <Link to="/clubs" className="font-display font-bold text-[var(--color-accent)] hover:underline underline-offset-[3px]">
                  Find clubs to follow
                </Link>
                .
              </p>
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
                When an upcoming event mentions free food, it will appear here automatically.
                {/* Events needs an account, so a visitor gets no link to it. */}
                {signedIn && (
                  <>
                    {' '}
                    <Link to="/events" className="font-display font-bold text-[var(--color-accent)] hover:underline underline-offset-[3px]">Browse all events</Link>.
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <section ref={daysRef} className="card card-pad">
          {Object.entries(grouped).map(([date, dateItems], groupIdx) => (
            <div key={date} className={groupIdx > 0 ? 'mt-2' : ''}>
              <div className="eyebrow bare">
                {date}
              </div>
              <ol className="dep">
                {dateItems.map((item) => {
                  const listedAt = listedTime(item)
                  const block = dateBlock(listedAt)
                  const listing = listingLink(item)
                  const eventParam = item.shared ? eventLinkParam(item.id) : null
                  const linked = item.id === linkedId
                  return (
                    <li key={item.id} className={isToday(listedAt) ? 'urgent' : undefined}>
                      {/* No end column: the Free food badge leads the meta
                          line, as on Events, so the title keeps the width.
                          The row a shared link opened on is tinted, with
                          its text where every other row's is. */}
                      <div
                        ref={linked ? linkedRowRef : undefined}
                        className={`dep-row items-start grid-cols-[48px_minmax(0,1fr)]${
                          linked ? ' -mx-3 rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] px-3' : ''
                        }`}
                        data-linked-event={linked ? 'true' : undefined}
                      >
                        <span className="when" aria-hidden="true">
                          <span>{block.day}</span>
                          <b>{block.date}</b>
                        </span>
                        <div className="body">
                          <div className="ttl line-clamp-2">
                            {item.title}
                          </div>
                          <div className="meta flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-1.5">
                            {linked && <span className="badge bg-[var(--color-surface)] text-[var(--color-accent)]">Shared with you</span>}
                            <span className="badge badge-route">
                              Free food
                            </span>
                            {item.shared && <span className="badge">{item.sourceLabel || 'Campus calendar'}</span>}
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
                          </div>
                          {item.description && (
                            <p className="text-[13px] text-[var(--color-txt-2)] mt-2 line-clamp-2 [overflow-wrap:anywhere]">
                              {linkifyText(stripHtml(item.description).slice(0, 200), { maxDisplayLength: 60 })}
                            </p>
                          )}
                          {(listing || eventParam) && (
                            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                              {listing && (
                                <a
                                  href={listing.href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-[13px] text-[var(--color-accent)] hover:underline [overflow-wrap:anywhere]"
                                >
                                  <Icon name="external" size={12} />
                                  View on {listing.host}
                                </a>
                              )}
                              {eventParam && (
                                <ShareButton
                                  page="free-food"
                                  kind="event"
                                  inline
                                  label={`Share ${item.title || 'this event'}`}
                                  getUrl={() => shareUrl('free-food', window.location.href, { event: eventParam })}
                                  title={PAGE_PREVIEWS['free-food'].title}
                                  text={eventShareText(item)}
                                />
                              )}
                            </div>
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
