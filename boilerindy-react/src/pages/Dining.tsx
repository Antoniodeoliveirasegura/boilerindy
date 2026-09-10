import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../components/Icons'
import { track } from '../lib/usageStats'
import { authRequest } from '../lib/authApi'
import { normalizeItemName, favoritesOnTodaysMenu } from '../lib/diningFavorites'
import {
  SHORT_DAY,
  WEEKDAY_ORDER,
  diningDirectionsUrl,
  emptyMenuState,
  headerBlurb,
  snapshotWeekday,
  statusLine,
  type DiningLocation,
  type DiningSnapshot,
  type Station,
} from '../lib/dining'

// Campus Dining (issue #119): the live Nutrislice snapshot from /api/dining,
// nothing else. Every hour shown comes from the feed; when the feed is down
// the page says so instead of inventing hours, and a retail food court is
// presented as one rather than as a hall with a missing menu.

const STATION_ICONS = ['dining', 'grid', 'star', 'coffee', 'moon', 'book', 'building', 'users', 'navigation', 'bus']
const STATION_CAP = 10

function StationCard({
  station,
  index,
  favorites,
  onToggleFavorite,
}: {
  station: Station
  index: number
  favorites: Set<string>
  onToggleFavorite: (name: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const overflow = station.items.length > STATION_CAP
  const visible = expanded ? station.items : station.items.slice(0, STATION_CAP)

  return (
    <div className="card p-5 flex flex-col" data-dining-station={station.name}>
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-6 h-6 rounded-lg bg-[var(--color-dining-bg)] flex items-center justify-center flex-shrink-0">
          <Icon name={STATION_ICONS[index % STATION_ICONS.length]} size={12} className="text-[var(--color-dining-color)]" />
        </div>
        <span className="text-[11px] font-semibold text-[var(--color-txt-0)] uppercase tracking-wide leading-tight">{station.name}</span>
      </div>
      <div className="space-y-1.5">
        {visible.map((item, idx) => {
          const isFav = favorites.has(normalizeItemName(item.name))
          return (
            <div
              key={`${item.name}-${idx}`}
              className="text-[13px] bg-[var(--color-stat)] hover:bg-[var(--color-bg-3)] rounded-xl px-3 py-2 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--color-txt-0)] leading-snug">{item.name}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {item.calories != null && (
                    <span className="text-[11px] text-[var(--color-txt-3)] whitespace-nowrap">{item.calories} cal</span>
                  )}
                  <button
                    type="button"
                    onClick={() => onToggleFavorite(item.name)}
                    aria-pressed={isFav}
                    aria-label={isFav ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`}
                    title={isFav ? 'Remove favorite' : 'Add to favorites'}
                    className="leading-none transition-transform hover:scale-110"
                  >
                    <Icon
                      name="star"
                      size={14}
                      className={isFav ? 'text-[var(--color-gold)] fill-current' : 'text-[var(--color-txt-3)] hover:text-[var(--color-gold-muted)]'}
                    />
                  </button>
                </div>
              </div>
              {item.icons && item.icons.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {item.icons.slice(0, 4).map((ic) => (
                    <span key={ic} className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-bg-2)] text-[var(--color-txt-2)]">
                      {ic}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {overflow && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 text-[12px] text-[var(--color-txt-3)] hover:text-[var(--color-txt-1)] transition-colors text-left"
        >
          {expanded ? '↑ Show less' : `+ ${station.items.length - STATION_CAP} more`}
        </button>
      )}
    </div>
  )
}

export default function Dining() {
  useEffect(() => {
    track('dining_viewed')
  }, [])

  const [live, setLive] = useState<DiningSnapshot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)

  // Favorites (issue #49): a Set of normalized item names. Loaded once for the
  // signed-in user; failures leave it empty so the page still works.
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let active = true
    authRequest('/api/me/dining/favorites')
      .then((data) => {
        const d = data as { favorites?: string[] }
        if (active && Array.isArray(d?.favorites)) {
          setFavorites(new Set(d.favorites.map(normalizeItemName).filter(Boolean)))
        }
      })
      .catch(() => {
        /* favorites are optional UI; ignore load failures */
      })
    return () => {
      active = false
    }
  }, [])

  const toggleFavorite = useCallback(
    (rawName: string) => {
      const key = normalizeItemName(rawName)
      if (!key) return
      const adding = !favorites.has(key)
      setFavorites((prev) => {
        const next = new Set(prev)
        if (adding) next.add(key)
        else next.delete(key)
        return next
      })
      // Persist optimistically; roll back the toggle if the request fails.
      authRequest('/api/me/dining/favorites', {
        method: adding ? 'POST' : 'DELETE',
        body: JSON.stringify({ itemName: key }),
      }).catch(() => {
        setFavorites((prev) => {
          const next = new Set(prev)
          if (adding) next.delete(key)
          else next.add(key)
          return next
        })
      })
    },
    [favorites],
  )

  const askWhatToEat = () => {
    setAiLoading(true)
    fetch('/api/assistant', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content:
              "Based on what's currently being served at open dining locations on campus, give me a quick meal recommendation. Mention the specific location, a dish or two, and a short reason. Keep it to 2-3 sentences. No markdown.",
          },
        ],
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.reply) setAiSuggestion(d.reply)
      })
      .catch(() => {})
      .finally(() => setAiLoading(false))
  }

  const applySnapshot = useCallback((data: unknown) => {
    const d = data as DiningSnapshot
    if (d?.ok && Array.isArray(d.locations)) {
      setLive(d)
      setLoadError('')
    } else {
      setLoadError('Live menus are temporarily unavailable.')
    }
  }, [])

  function loadMenu(force = false) {
    if (force) setRefreshing(true)
    else setLoading(true)
    setLoadError('')
    fetch(`/api/dining${force ? '?refresh=1' : ''}`)
      .then((r) => r.json())
      .then(applySnapshot)
      .catch(() => setLoadError('Could not reach the dining server.'))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }

  useEffect(() => {
    // Initial load: `loading` starts true, so only async callbacks set state.
    let cancelled = false
    fetch('/api/dining')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) applySnapshot(data)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not reach the dining server.')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [applySnapshot])

  const locations = useMemo<DiningLocation[]>(() => (loading ? [] : live?.locations || []), [live, loading])
  const weekday = snapshotWeekday(live)

  // Default the selected location once the list loads, keeping any still-valid
  // choice. Adjusting during render (guarded by a locations identity check)
  // avoids the setState-in-effect cascading-render warning.
  const [prevLocations, setPrevLocations] = useState<DiningLocation[] | null>(null)
  if (locations !== prevLocations) {
    setPrevLocations(locations)
    if (locations.length) {
      setSelectedId((prev) => {
        if (prev && locations.some((l) => l.id === prev)) return prev
        const tower = locations.find((l) => l.slug === 'tower-dining')
        return tower?.id || locations[0].id
      })
    }
  }

  const favoritesToday = useMemo(() => favoritesOnTodaysMenu(favorites, live?.locations || []), [favorites, live])

  const selected = locations.find((l) => l.id === selectedId) || locations[0]
  const withHours = locations.filter((l) => l.weekly_hours)
  const empty = selected ? emptyMenuState(selected) : null

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8 pb-24 transition-opacity duration-500 opacity-100">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6 animate-fade-in-up">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Campus Dining</h1>
          <p className="text-[14px] text-[var(--color-txt-2)] mt-1">
            {live?.date ? `Menu for ${weekday}, ${live.date}` : "Today's menu"}
            {live?.cached && !live?.stale ? ' · cached' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selected && !loading && (
            <div
              className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl px-4 py-2.5 shadow-sm"
              data-dining-blurb
            >
              <Icon name="clock" size={14} className="text-[var(--color-txt-3)]" />
              {headerBlurb(selected, weekday)}
            </div>
          )}
          <button
            type="button"
            onClick={askWhatToEat}
            disabled={aiLoading || loading}
            title="AI meal recommendation"
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-[var(--color-gold)]/30 bg-[var(--color-gold)]/8 text-[var(--color-gold-muted)] text-[12px] font-medium shadow-sm hover:bg-[var(--color-gold)]/15 transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            <Icon name="sparkles" size={13} />
            {aiLoading ? 'Thinking…' : 'What should I eat?'}
          </button>
          <button
            type="button"
            onClick={() => loadMenu(true)}
            disabled={refreshing || loading}
            title="Force-refresh menu"
            aria-label="Refresh menus"
            className="flex items-center justify-center w-10 h-10 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm hover:bg-[var(--color-bg-3)] transition-colors disabled:opacity-40"
          >
            <Icon name="refresh" size={14} className={`text-[var(--color-txt-2)] ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {loadError && (
        <div
          className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-stat)] px-4 py-3 text-[13px] text-[var(--color-txt-2)]"
          data-dining-error
        >
          {loadError} Nutrislice, which publishes the campus menus, is not answering. Try again in a few minutes.
        </div>
      )}

      {live?.stale && !loadError && (
        <div
          className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-stat)] px-4 py-3 text-[13px] text-[var(--color-txt-2)]"
          data-dining-stale
        >
          Nutrislice is not answering right now, so this is the last menu we fetched{live.date ? ` (${live.date})` : ''}. Hours and open
          status are still live.
        </div>
      )}

      {/* Your favorites on today's menu (issue #49) */}
      {favoritesToday.length > 0 && (
        <div className="card p-4 mb-4 border-[var(--color-gold)]/20 bg-[var(--color-gold)]/5 animate-fade-in-up" data-dining-favorites>
          <div className="flex items-center gap-2 mb-2.5">
            <Icon name="star" size={14} className="text-[var(--color-gold)] fill-current" />
            <span className="text-[13px] font-semibold text-[var(--color-txt-0)]">Your favorites on today&apos;s menu</span>
          </div>
          <div className="space-y-1.5">
            {favoritesToday.map((fav) => (
              <div key={fav.name} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-[var(--color-txt-0)]">{fav.name}</span>
                <span className="text-[12px] text-[var(--color-txt-2)] text-right">{fav.locations.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Suggestion */}
      {aiSuggestion && (
        <div className="card p-4 mb-4 border-[var(--color-gold)]/20 bg-[var(--color-gold)]/5 animate-fade-in-up">
          <div className="flex items-start gap-2.5">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center shrink-0 mt-0.5">
              <Icon name="sparkles" size={12} className="text-[var(--color-gold-dark)]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">{aiSuggestion}</p>
            </div>
            <button onClick={() => setAiSuggestion(null)} className="text-[var(--color-txt-3)] hover:text-[var(--color-txt-1)] shrink-0" aria-label="Dismiss suggestion">
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
      )}

      {loading ? (
        /* Skeleton */
        <div className="animate-pulse">
          <div className="flex gap-2 mb-6">
            <div className="h-11 w-36 rounded-xl bg-[var(--color-stat)]" />
            <div className="h-11 w-32 rounded-xl bg-[var(--color-stat)]" />
          </div>
          <div className="card p-6 mb-6">
            <div className="flex items-center justify-between mb-6">
              <div className="space-y-2">
                <div className="h-5 w-40 rounded-lg bg-[var(--color-stat)]" />
                <div className="h-3.5 w-52 rounded-lg bg-[var(--color-stat)]" />
              </div>
              <div className="h-9 w-28 rounded-xl bg-[var(--color-stat)]" />
            </div>
            <div className="grid md:grid-cols-3 gap-6">
              {[0, 1, 2].map((col) => (
                <div key={col} className="space-y-2">
                  <div className="h-3 w-20 rounded bg-[var(--color-stat)] mb-3" />
                  {[0, 1, 2, 3].map((row) => (
                    <div key={row} className="h-9 rounded-xl bg-[var(--color-stat)]" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {locations.length > 0 && (
            <div className="flex gap-2 mb-6 overflow-x-auto pb-1 -mx-1 px-1 animate-fade-in-up stagger-1">
              {locations.map((loc) => {
                const isSelected = selected && loc.id === selected.id
                return (
                  <button
                    key={loc.id}
                    type="button"
                    onClick={() => setSelectedId(loc.id)}
                    aria-pressed={Boolean(isSelected)}
                    data-dining-location={loc.slug}
                    className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border whitespace-nowrap transition-all duration-300 ${
                      isSelected
                        ? 'bg-[var(--color-surface)] border-[var(--color-border-2)] shadow-md'
                        : 'bg-transparent border-transparent hover:bg-[var(--color-surface)] hover:border-[var(--color-border)]'
                    }`}
                  >
                    <div className={`status-dot ${loc.is_open ? 'status-open' : 'status-closed'}`} />
                    <span className={`text-[13px] font-medium ${isSelected ? 'text-[var(--color-txt-0)]' : 'text-[var(--color-txt-1)]'}`}>{loc.name}</span>
                  </button>
                )
              })}
            </div>
          )}

          {selected && empty && (
            <div className="mb-6 animate-fade-in-up stagger-2" data-dining-selected={selected.slug}>
              {/* Location header */}
              <div className="card p-5 mb-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-xl font-semibold text-[var(--color-txt-0)]">{selected.name}</h2>
                      {selected.kind === 'retail' && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-stat)] text-[var(--color-txt-2)]">
                          Food court
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className={`status-dot ${selected.is_open ? 'status-open' : 'status-closed'}`} />
                      <span className="text-[13px] text-[var(--color-txt-2)]" data-dining-status>
                        {statusLine(selected)}
                      </span>
                    </div>
                  </div>
                  <a
                    href={diningDirectionsUrl(selected)}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary text-[12px] px-4 py-2.5 w-fit no-underline"
                  >
                    <Icon name="mapPin" size={14} />
                    Get Directions
                  </a>
                </div>
              </div>

              {/* Station grid, or the honest reason there is none */}
              {(selected.stations || []).length === 0 ? (
                <div className="card p-10 flex flex-col items-center gap-3 text-center" data-dining-empty={empty.kind}>
                  <div className="w-10 h-10 rounded-xl bg-[var(--color-stat)] flex items-center justify-center">
                    <Icon name={empty.icon} size={18} className="text-[var(--color-txt-3)]" />
                  </div>
                  <p className="text-[14px] font-medium text-[var(--color-txt-0)]">{empty.title}</p>
                  <p className="text-[13px] text-[var(--color-txt-2)] max-w-md">{empty.body}</p>
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {(selected.stations || []).map((station, i) => (
                    <StationCard key={station.name} station={station} index={i} favorites={favorites} onToggleFavorite={toggleFavorite} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Weekly hours for every location, straight from the feed */}
          <div className="card p-6 animate-fade-in-up stagger-3" data-dining-hours>
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-5">Weekly Hours of Operation</div>

            {withHours.length > 0 ? (
              <div className="space-y-6">
                {withHours.map((loc) => (
                  <div key={loc.id} data-dining-hours-for={loc.slug}>
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className={`status-dot ${loc.is_open ? 'status-open' : 'status-closed'}`} />
                      <span className="text-[14px] font-semibold text-[var(--color-txt-0)]">{loc.name}</span>
                      <span className="text-[12px] text-[var(--color-txt-2)]">· {statusLine(loc)}</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                      {WEEKDAY_ORDER.map((day) => {
                        const hrs = loc.weekly_hours?.[day] || 'Not posted'
                        const isToday = day === weekday
                        const isClosed = /closed/i.test(hrs)
                        return (
                          <div
                            key={day}
                            data-hours-today={isToday ? 'true' : undefined}
                            className={`rounded-xl p-3 text-center transition-all ${
                              isToday
                                ? 'bg-gradient-to-br from-[var(--color-dining-bg)] to-[var(--color-dining-bg)]/50 border border-[var(--color-dining-color)]/15 ring-1 ring-[var(--color-dining-color)]/10'
                                : 'bg-[var(--color-stat)]'
                            }`}
                          >
                            <div
                              className={`text-[11px] font-semibold uppercase tracking-wider mb-1.5 ${
                                isToday ? 'text-[var(--color-dining-color)]' : 'text-[var(--color-txt-3)]'
                              }`}
                            >
                              {SHORT_DAY[day]}
                              {isToday && <span className="ml-1 inline-flex w-1.5 h-1.5 rounded-full bg-[var(--color-success)] align-middle" />}
                            </div>
                            <div
                              className={`text-[12px] leading-snug ${
                                isClosed ? 'text-[var(--color-txt-3)]' : isToday ? 'text-[var(--color-dining-color)] font-medium' : 'text-[var(--color-txt-1)]'
                              }`}
                            >
                              {isClosed ? 'Closed' : hrs}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-[var(--color-txt-2)]" data-dining-no-hours>
                Hours are not posted right now. They come from the same live feed as the menus, so they will reappear when it does.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
