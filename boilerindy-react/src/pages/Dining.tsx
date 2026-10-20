import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import AiMarkdown from '../components/AiMarkdown'
import Icon from '../components/Icons'
import ShareButton from '../components/ShareButton'
import { useAuth } from '../context/AuthContext'
import { track } from '../lib/usageStats'
import { shareUrl } from '../lib/shareLinks'
import { PAGE_PREVIEWS } from '../lib/pagePreviews'
import { authRequest } from '../lib/authApi'
import { normalizeItemName, favoritesOnTodaysMenu } from '../lib/diningFavorites'
import { writeFailureMessage } from '../lib/writeFailure'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, refreshDining, useDining, useDiningUpcoming } from '../lib/queries/publicData'
import {
  ALL_MEALS,
  DIET_FILTERS,
  DIET_LABEL_NOTE,
  OFFICIAL_HOURS_URL,
  OFFICIAL_MENU_URL,
  SHORT_DAY,
  WEEKDAY_ORDER,
  diningDirectionsUrl,
  comingUpLine,
  emptyMenuState,
  favoritesComingUp,
  feedNotice,
  filterStations,
  headerBlurb,
  headlinersFor,
  locationMenus,
  readDietFilters,
  readDiningView,
  snapshotWeekday,
  splitStations,
  statusDotClass,
  statusLine,
  weeklyHoursCell,
  writeDietFilters,
  writeDiningView,
  type DiningLocation,
  type DiningSnapshot,
  type DiningView,
  type MenuItem,
  type Station,
} from '../lib/dining'
import DishDialog from '../components/DishDialog'
import CampusCenterVendors from '../components/CampusCenterVendors'
import { campusCenterVendorsFor } from '../lib/campusCenterVendors'
import { defaultMeal, mealLabel } from '../../../src/diningMeals.mjs'
import PageTitle from '../components/PageTitle'

// Campus Dining (issue #119): the live Nutrislice snapshot from /api/dining,
// nothing else. Every hour shown comes from the feed; when the feed is down
// the page says so instead of inventing hours, and a retail food court is
// presented as one rather than as a hall with a missing menu.
//
// Signed-out visitors can open it too (the public preview, issue #366). They
// get the menus and hours; the stars, the favorites card and the AI pick need
// an account, so they are hidden and never call the per-user API, where a 401
// would send the visitor to /login.

const UNAVAILABLE_MESSAGE = 'Live menus are temporarily unavailable.'
// Shown when the assistant fails without saying why (no response, or a body
// with no message). The chat panel says the same.
const ASSISTANT_UNREACHABLE = "Couldn't reach the assistant right now. Try again in a moment."

type AssistantAnswer = { reply: string } | { error: string }

// The pick from an /api/assistant response, or the message to show instead.
// What should I eat? read only `reply`, so the hourly limit's 429 and the 502
// when Groq fails put the button back with nothing said (R60). A 200 marked
// busy or offline carries a status line, not a pick, so it is the message.
async function readAssistantAnswer(res: Response): Promise<AssistantAnswer> {
  const data = (await res.json().catch(() => null)) as { reply?: unknown; source?: unknown; error?: unknown } | null
  const reply = typeof data?.reply === 'string' ? data.reply : ''
  if (res.ok && reply && data?.source !== 'busy' && data?.source !== 'offline') return { reply }
  // The limiter sends `error` as a string; the app's error handler sends { message }.
  const error = data?.error as string | { message?: unknown } | null | undefined
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
  return { error: message || reply || ASSISTANT_UNREACHABLE }
}

// The server answered (a 5xx with ok: false, say) versus nothing answered at all.
function diningErrorMessage(error: unknown): string {
  return error instanceof ApiError ? UNAVAILABLE_MESSAGE : 'Could not reach the dining server.'
}

const STATION_ICONS = ['dining', 'grid', 'star', 'coffee', 'moon', 'book', 'building', 'users', 'navigation', 'bus']
const STATION_CAP = 10

function StationCard({
  station,
  index,
  favorites,
  onToggleFavorite,
  onOpenItem,
}: {
  station: Station
  index: number
  favorites: Set<string>
  /** Absent signed out: the stars need an account. */
  onToggleFavorite?: (name: string) => void
  /** Opens a dish's details (issue #468); `trigger` gets focus back on close. */
  onOpenItem?: (item: MenuItem, station: string, trigger: HTMLElement) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const overflow = station.items.length > STATION_CAP
  const visible = expanded ? station.items : station.items.slice(0, STATION_CAP)
  // A station with any photo gives every row a 40 px leading slot, the photo
  // or the usual square, so the names line up (issue #468).
  const withThumbs = station.items.some((item) => item.thumb)

  return (
    <div className="card card-pad r-din flex flex-col" data-dining-station={station.name}>
      <div className="flex items-center gap-2.5 mb-2">
        <span className="route-badge sm">
          <Icon name={STATION_ICONS[index % STATION_ICONS.length]} size={14} />
        </span>
        <span className="eyebrow bare leading-tight text-[var(--color-txt-0)]">{station.name}</span>
      </div>
      <div>
        {visible.map((item, idx) => {
          const isFav = favorites.has(normalizeItemName(item.name))
          return (
            <div
              key={`${item.name}-${idx}`}
              className="py-2.5 border-t border-[var(--color-border)] first:border-t-0"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="flex items-start gap-2.5 min-w-0">
                  {withThumbs ? (
                    <span aria-hidden="true" className="grid place-items-center w-10 h-10 shrink-0 -my-0.5">
                      {item.thumb ? (
                        <img
                          src={item.thumb}
                          alt=""
                          width={40}
                          height={40}
                          loading="lazy"
                          decoding="async"
                          className="w-10 h-10 rounded-[var(--radius-sm)] object-cover bg-[var(--color-stat)]"
                        />
                      ) : (
                        <span className="w-2 h-2 rounded-[2px] bg-[var(--route)]" />
                      )}
                    </span>
                  ) : (
                    <span aria-hidden="true" className="mt-[6px] w-2 h-2 shrink-0 rounded-[2px] bg-[var(--route)]" />
                  )}
                  {onOpenItem ? (
                    <button
                      type="button"
                      onClick={(e) => onOpenItem(item, station.name, e.currentTarget)}
                      className="text-left font-display font-semibold text-[14px] leading-snug text-[var(--color-txt-0)] hover:underline underline-offset-[3px] decoration-[var(--color-border-3)]"
                      data-dining-dish={item.name}
                    >
                      {item.name}
                    </button>
                  ) : (
                    <span className="font-display font-semibold text-[14px] leading-snug text-[var(--color-txt-0)]">{item.name}</span>
                  )}
                </span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {item.calories != null && (
                    <span className="text-[12px] text-[var(--color-txt-3)] whitespace-nowrap tnum">{item.calories} cal</span>
                  )}
                  {onToggleFavorite && (
                    <button
                      type="button"
                      onClick={() => onToggleFavorite(item.name)}
                      aria-pressed={isFav}
                      aria-label={isFav ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`}
                      title={isFav ? 'Remove favorite' : 'Add to favorites'}
                      className="grid place-items-center w-11 h-11 -my-3 -mr-2.5 md:w-8 md:h-8 md:-my-1.5 md:-mr-1.5 rounded-[var(--radius-md)] transition-colors hover:bg-[var(--color-bg-2)]"
                    >
                      <Icon
                        name="star"
                        size={15}
                        className={isFav ? 'text-[var(--color-txt-0)] fill-current' : 'text-[var(--color-txt-3)]'}
                      />
                    </button>
                  )}
                </div>
              </div>
              {item.icons && item.icons.length > 0 && (
                <div className={`flex flex-wrap gap-1 mt-1.5 ${withThumbs ? 'pl-[50px]' : 'pl-[18px]'}`}>
                  {item.icons.slice(0, 4).map((ic) => (
                    <span key={ic} className="text-[11px] leading-none px-1.5 py-[4px] rounded-[var(--radius-sm)] bg-[var(--color-stat)] text-[var(--color-txt-2)]">
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
          className="btn btn-ghost btn-sm self-start -ml-3 mt-1 text-[var(--color-txt-2)]"
        >
          {expanded ? '↑ Show less' : `+ ${station.items.length - STATION_CAP} more`}
        </button>
      )}
    </div>
  )
}

type StationListProps = {
  stations: Station[]
  /** Where the icon rotation starts, so the every-day cards do not repeat the specials' icons. */
  firstIndex?: number
  favorites: Set<string>
  onToggleFavorite?: (name: string) => void
  onOpenItem?: (item: MenuItem, station: string, trigger: HTMLElement) => void
}

function StationGrid({ stations, firstIndex = 0, favorites, onToggleFavorite, onOpenItem }: StationListProps) {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4 items-start">
      {stations.map((station, i) => (
        <StationCard
          key={station.name}
          station={station}
          index={firstIndex + i}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
          onOpenItem={onOpenItem}
        />
      ))}
    </div>
  )
}

// The stations that serve the same food all week (issue #466), collapsed
// under the day's specials. Open from the start when a meal has nothing else,
// like a weekend breakfast of grill options only.
function EverydayStations({ defaultOpen, ...list }: StationListProps & { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  const count = list.stations.length
  return (
    <section className="mt-5" data-dining-everyday>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-2)] bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-2)]"
      >
        <Icon name="chevronRight" size={16} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {/* The count wraps under the title on a phone; the title stays on one line. */}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="whitespace-nowrap font-display font-bold text-[14.5px] text-[var(--color-txt-0)]">Every day</span>{' '}
          <span className="text-[12.5px] text-[var(--color-txt-2)]">
            {count} station{count === 1 ? '' : 's'} with the same food all week
          </span>
        </span>
      </button>
      <div id={panelId} hidden={!open} className="mt-4">
        <StationGrid {...list} />
      </div>
    </section>
  )
}

export default function Dining() {
  // Gate every per-user call on a settled session, not on `user` alone: while
  // a signed-in student's cookie is re-minted on a cold load, a favorites read
  // would 401 and authRequest would bounce them to /login.
  const { user, loading: authLoading } = useAuth()
  const userId = authLoading ? null : ((user?.id as string | undefined) ?? null)
  const signedIn = userId !== null

  // Once auth settles, so a signed-in cold load records the view after
  // UsageListener has switched tracking on (signed out it records nothing).
  useEffect(() => {
    if (authLoading) return
    track('dining_viewed')
  }, [authLoading])

  // The snapshot comes through the shared query cache (issue #251): a return
  // visit paints the last menus at once, and Home's dining widget reads the
  // same entry. Refresh bypasses every cache with ?refresh=1 and writes the
  // answer back into it.
  const queryClient = useQueryClient()
  const diningQuery = useDining()
  // What is coming up (issue #469): the headliner photos and favorites to come.
  const upcomingQuery = useDiningUpcoming()
  const [refreshing, setRefreshing] = useState(false)
  // Why the last Refresh click failed, shown until a later fetch (a refetch on
  // focus, the next Refresh) lands newer data than the failure.
  const [refreshFailure, setRefreshFailure] = useState<{ message: string; at: number } | null>(null)
  const refreshError = refreshFailure && diningQuery.dataUpdatedAt <= refreshFailure.at ? refreshFailure.message : ''
  const live = useMemo<DiningSnapshot | null>(() => {
    const d = diningQuery.data
    return d?.ok && Array.isArray(d.locations) ? d : null
  }, [diningQuery.data])
  const loading = diningQuery.isPending
  const loadError =
    refreshError ||
    (diningQuery.isError ? diningErrorMessage(diningQuery.error) : diningQuery.data && !live ? UNAVAILABLE_MESSAGE : '')

  // The hall and meal on screen live in the address (?hall=tower-dining&meal=dinner),
  // as the route does on /transit: a shared link opens the same menu, and
  // coming Back to the page keeps it. Replace, not push, so each pill is not
  // a Back step of its own. Nothing is written until a student picks, so a
  // plain /dining still opens on Tower Dining and the meal being served.
  const [searchParams, setSearchParams] = useSearchParams()
  const view = readDiningView(searchParams)
  const showView = useCallback(
    (next: DiningView) => setSearchParams((prev) => writeDiningView(prev, next), { replace: true }),
    [setSearchParams],
  )

  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  // Why the last AI pick failed (R60).
  const [aiError, setAiError] = useState('')

  // Favorites (issue #49): a Set of normalized item names. Loaded once per
  // signed-in user; failures leave it empty so the page still works.
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set())
  // Why the last star toggle did not save. Favorites have no device-only copy,
  // so every failure rolls the star back and says so (issue #202).
  const [favoriteError, setFavoriteError] = useState('')

  // A sign-out (in another tab, say) no longer unmounts the page, so drop the
  // last user's favorites when the user changes. Adjusted during render rather
  // than in an effect, like the location default below.
  const [favoritesUserId, setFavoritesUserId] = useState(userId)
  if (favoritesUserId !== userId) {
    setFavoritesUserId(userId)
    setFavorites(new Set())
    setFavoriteError('')
  }

  useEffect(() => {
    if (!userId) return
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
  }, [userId])

  const toggleFavorite = useCallback(
    (rawName: string) => {
      // Signed out the stars are hidden; refuse anyway, since the server
      // spends the write budget before it answers 401.
      if (!userId) return
      const key = normalizeItemName(rawName)
      if (!key) return
      const adding = !favorites.has(key)
      setFavoriteError('')
      setFavorites((prev) => {
        const next = new Set(prev)
        if (adding) next.add(key)
        else next.delete(key)
        return next
      })
      // Persist optimistically; roll back the toggle if the request fails and
      // show why: the server's message for the 300-favorite cap (409) or the
      // user-write limiter (429), a generic line otherwise.
      authRequest('/api/me/dining/favorites', {
        method: adding ? 'POST' : 'DELETE',
        body: JSON.stringify({ itemName: key }),
      }).catch((err: unknown) => {
        setFavorites((prev) => {
          const next = new Set(prev)
          if (adding) next.delete(key)
          else next.add(key)
          return next
        })
        setFavoriteError(
          writeFailureMessage(
            err,
            adding ? 'Could not save that favorite. Please try again.' : 'Could not remove that favorite. Please try again.',
          ),
        )
      })
    },
    [favorites, userId],
  )

  const askWhatToEat = () => {
    if (!signedIn) return
    setAiLoading(true)
    setAiError('')
    fetch('/api/assistant', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: "Based on what's currently being served at open dining locations on campus, give me a quick meal recommendation. Name the specific location in bold and the actual dishes being served there today, plus a short reason. 2-3 sentences, no bullets, no headings.",
        }],
      }),
    })
      .then(readAssistantAnswer)
      .then((answer) => {
        if ('error' in answer) setAiError(answer.error)
        else setAiSuggestion(answer.reply)
      })
      .catch(() => setAiError(ASSISTANT_UNREACHABLE))
      .finally(() => setAiLoading(false))
  }

  async function refreshMenu() {
    setRefreshing(true)
    setRefreshFailure(null)
    try {
      await refreshDining(queryClient)
    } catch (error) {
      setRefreshFailure({ message: diningErrorMessage(error), at: Date.now() })
    } finally {
      setRefreshing(false)
    }
  }

  const locations = useMemo<DiningLocation[]>(() => (loading ? [] : live?.locations || []), [live, loading])
  const weekday = snapshotWeekday(live)

  const favoritesToday = useMemo(() => favoritesOnTodaysMenu(favorites, live?.locations || []), [favorites, live])
  const comingUp = useMemo(
    () => favoritesComingUp(favorites, upcomingQuery.data, upcomingQuery.data?.today, normalizeItemName),
    [favorites, upcomingQuery.data],
  )

  // The hall the address names, else Tower Dining, else the first listed; a
  // hall that leaves the feed falls back the same way.
  const selected =
    locations.find((l) => l.slug === view.hall) ?? locations.find((l) => l.slug === 'tower-dining') ?? locations[0]
  const withHours = locations.filter((l) => l.weekly_hours)
  const empty = selected ? emptyMenuState(selected) : null
  // The food court's vendors stand in for its menu (issue #477).
  const campusVendors = selected?.kind === 'retail' ? campusCenterVendorsFor(selected) : []

  // Meal tabs (issue #466): the meal in the address when this hall posts it,
  // else the one being served now on campus time (defaultMeal). Picking
  // another hall keeps the meal in the address, so coming back to a hall
  // finds the meal picked there, and a hall with no such meal opens on its
  // own. A snapshot from before per-meal menus has one ALL_MEALS view and no
  // tabs.
  const menus = selected ? locationMenus(selected) : []
  const mealOptions = menus.map((m) => m.meal)
  const activeMeal = view.meal && mealOptions.includes(view.meal) ? view.meal : defaultMeal(mealOptions)
  const activeMenu = menus.find((m) => m.meal === activeMeal) ?? menus[0]
  // What a shared link opens (docs/share-links.md): this hall and this meal,
  // whether the address has them yet or not.
  const sharedMeal = activeMenu && activeMenu.meal !== ALL_MEALS ? activeMenu.meal : null

  // Diet filters (issue #468), remembered on this device. A dish shows when it
  // carries every chosen label; stations left empty are hidden.
  const [dietFilters, setDietFilters] = useState<string[]>(() => readDietFilters())
  const toggleDietFilter = (label: string) => {
    const next = dietFilters.includes(label) ? dietFilters.filter((f) => f !== label) : [...dietFilters, label]
    setDietFilters(next)
    writeDietFilters(next)
  }
  const split = splitStations(activeMenu?.stations ?? [])
  const specials = filterStations(split.specials, dietFilters)
  const everyday = filterStations(split.everyday, dietFilters)
  const filteredOut = Boolean(activeMenu) && specials.length === 0 && everyday.length === 0

  // Today's headline dishes for the meal on screen (issue #469), only for the
  // snapshot of today. A headliner on the menu opens its details.
  const headliners = activeMenu && live?.date === upcomingQuery.data?.today ? headlinersFor(upcomingQuery.data, live?.date, activeMenu.meal) : []
  const menuItemNamed = (name: string): { item: MenuItem; station: string } | null => {
    const key = normalizeItemName(name)
    for (const station of activeMenu?.stations ?? []) {
      const item = station.items.find((it) => normalizeItemName(it.name) === key)
      if (item) return { item, station: station.name }
    }
    return null
  }

  // The dish whose details are open (issue #468).
  const [openDish, setOpenDish] = useState<{ item: MenuItem; station: string; trigger: HTMLElement } | null>(null)
  const openItem = useCallback((item: MenuItem, station: string, trigger: HTMLElement) => setOpenDish({ item, station, trigger }), [])
  const closeDish = useCallback(() => setOpenDish(null), [])

  return (
    <div className="page">
      <PageTitle>Campus Dining</PageTitle>
      <header className="page-head">
        <div>
          <h1 className="page-title">Campus Dining</h1>
          <p className="page-sub tnum">
            {live?.date ? `Menu for ${weekday}, ${live.date}` : "Today's menu"}
            {live?.cached && !live?.stale ? ' · cached' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The AI pick posts /api/assistant, which needs a session. */}
          {signedIn && (
            <button
              type="button"
              onClick={askWhatToEat}
              disabled={aiLoading || loading}
              title="AI meal recommendation"
              className="btn btn-secondary r-ai whitespace-nowrap"
            >
              <Icon name="sparkles" size={15} className="text-[var(--route-text)]" />
              {aiLoading ? 'Thinking…' : 'What should I eat?'}
            </button>
          )}
          {/* The hall and meal on screen, for a friend signed in or not. The
              menu, never whether the hall is open: the feed's hours are
              unreliable (docs/dining.md, "Weekend hours"). */}
          <ShareButton
            page="dining"
            getUrl={() => shareUrl('dining', window.location.href, { hall: selected?.slug, meal: sharedMeal })}
            title={PAGE_PREVIEWS.dining.title}
            text={
              selected
                ? `${sharedMeal ? `${mealLabel(sharedMeal)} at ` : ''}${selected.name}, on BoilerIndy`
                : "Today's campus dining menu, on BoilerIndy"
            }
          />
          <button
            type="button"
            onClick={() => void refreshMenu()}
            disabled={refreshing || loading}
            title="Force-refresh menu"
            aria-label="Refresh menus"
            className="btn btn-secondary w-11 md:w-10 px-0"
          >
            <Icon name="refresh" size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      {loadError && (
        <div
          className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-border-2)] bg-[var(--color-stat)] px-4 py-3 text-[13.5px] text-[var(--color-txt-1)]"
          data-dining-error
        >
          {loadError} Nutrislice, which publishes the campus menus, is not answering. Try again in a few minutes.
        </div>
      )}

      {live?.stale && !loadError && (
        <div
          className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-border-2)] bg-[var(--color-stat)] px-4 py-3 text-[13.5px] text-[var(--color-txt-1)]"
          data-dining-stale
        >
          Nutrislice is not answering right now, so this is the last menu we fetched{live.date ? ` (${live.date})` : ''}. Hours and open
          status are still live.
        </div>
      )}

      {/* Your favorites on today's menu (issue #49) */}
      {signedIn && favoritesToday.length > 0 && (
        <div className="card card-pad r-din mb-4 animate-fade-in-up" data-dining-favorites>
          <div className="card-head mb-2">
            <span className="route-badge">
              <Icon name="star" size={18} className="fill-current" />
            </span>
            <span className="card-title">Your favorites on today&apos;s menu</span>
          </div>
          <div>
            {favoritesToday.map((fav) => (
              <div key={fav.name} className="flex items-center justify-between gap-3 py-2 border-t border-[var(--color-border)] first:border-t-0">
                <span className="font-display font-semibold text-[14px] text-[var(--color-txt-0)]">{fav.name}</span>
                <span className="text-[12.5px] text-[var(--color-txt-2)] text-right">{fav.locations.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Favorites coming up (issue #469): the next time each starred dish is on. */}
      {signedIn && comingUp.length > 0 && upcomingQuery.data?.today && (
        <div className="card card-pad r-din mb-4 animate-fade-in-up" data-dining-coming-up>
          <div className="card-head mb-2">
            <span className="route-badge">
              <Icon name="calendar" size={18} />
            </span>
            <span className="card-title">Favorites coming up</span>
          </div>
          <div>
            {comingUp.slice(0, 6).map((entry) => (
              <div key={entry.name} className="flex items-center justify-between gap-3 py-2 border-t border-[var(--color-border)] first:border-t-0">
                <span className="font-display font-semibold text-[14px] text-[var(--color-txt-0)]">
                  {comingUpLine(entry, upcomingQuery.data!.today!)}
                </span>
                <span className="text-[12.5px] text-[var(--color-txt-2)] text-right shrink-0">
                  {mealLabel(entry.meal)}, {entry.location}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-[var(--color-txt-3)]">
            Menus more than a week out are drafts and can still change.
          </p>
        </div>
      )}

      {/* AI Suggestion */}
      {signedIn && aiSuggestion && (
        <div className="card card-pad r-ai mb-4 animate-fade-in-up">
          <div className="flex items-start gap-3">
            <span className="route-badge sm mt-0.5">
              <Icon name="sparkles" size={14} />
            </span>
            <div className="flex-1 min-w-0">
              <AiMarkdown className="text-[14px] text-[var(--color-txt-1)]">{aiSuggestion}</AiMarkdown>
            </div>
            <button onClick={() => setAiSuggestion(null)} className="icon-btn -mr-2.5 -mt-2.5 shrink-0" aria-label="Dismiss suggestion">
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
      )}

      {signedIn && aiError && (
        <div
          role="alert"
          className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-border-2)] bg-[var(--color-stat)] px-4 py-3 text-[13.5px] text-[var(--color-txt-1)]"
          data-dining-ai-error
        >
          {aiError}
        </div>
      )}

      {loading ? (
        /* Skeleton */
        <div>
          <div className="flex gap-2 mb-5">
            <div className="skeleton h-10 w-36" />
            <div className="skeleton h-10 w-32" />
          </div>
          <div className="card card-pad mb-4">
            <div className="flex items-center gap-3.5">
              <div className="skeleton w-10 h-10 shrink-0" />
              <div className="space-y-2 flex-1">
                <div className="skeleton h-5 w-40" />
                <div className="skeleton h-3.5 w-52" />
              </div>
              <div className="skeleton h-10 w-32 hidden sm:block" />
            </div>
          </div>
          <div className="grid md:grid-cols-3 gap-4">
            {[0, 1, 2].map((col) => (
              <div key={col} className="card card-pad space-y-3">
                <div className="skeleton h-3 w-24" />
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className="skeleton h-5" />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* The scroller clips on every side (overflow-x auto makes overflow-y
              clip too), so it pads 6px around the pills for the 5px focus ring,
              which lost its top edge, and on wider screens the first pill's left
              edge (R65). The negative top margin and the smaller bottom margin
              keep the pills where they were. */}
          {locations.length > 0 && (
            <div className="flex gap-2 -mt-1.5 mb-[18px] overflow-x-auto pt-1.5 pb-1.5 -mx-4 px-4 sm:-mx-1.5 sm:px-1.5 scrollbar-hide">
              {locations.map((loc) => {
                const isSelected = selected && loc.id === selected.id
                return (
                  <button
                    key={loc.id}
                    type="button"
                    onClick={() => showView({ hall: loc.slug, meal: view.meal })}
                    aria-pressed={Boolean(isSelected)}
                    data-dining-location={loc.slug}
                    className={`pill shrink-0 whitespace-nowrap gap-2.5 md:min-h-[40px] px-4 text-[13.5px] ${isSelected ? 'pill-active' : ''}`}
                  >
                    {/* On the inverted active pill the dot keeps a surface
                        halo, so it still reads on ink (light) and white (dark). */}
                    <span
                      className={`status-dot shrink-0 ${statusDotClass(loc)} ${
                        isSelected ? 'shadow-[0_0_0_2px_var(--color-surface)]' : ''
                      }`}
                    />
                    <span>{loc.name}</span>
                  </button>
                )
              })}
            </div>
          )}

          {selected && empty && (
            <div className="mb-6" data-dining-selected={selected.slug}>
              {/* Location header */}
              <div className="card card-pad r-din mb-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3.5 min-w-0">
                    <span className="route-badge lg">
                      <Icon name="dining" size={22} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <h2 className="text-[24px] leading-tight text-[var(--color-txt-0)]">{selected.name}</h2>
                        {selected.kind === 'retail' && <span className="badge">Food court</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className={`status-dot shrink-0 ${statusDotClass(selected)}`} />
                        <span className="font-display font-semibold text-[13.5px] text-[var(--color-txt-1)]" data-dining-status>
                          {statusLine(selected)}
                        </span>
                      </div>
                      <div className="chip tint mt-3 whitespace-normal leading-snug py-1.5" data-dining-blurb>
                        <Icon name="clock" size={13} className="shrink-0" />
                        {headerBlurb(selected, weekday)}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <a
                      href={diningDirectionsUrl(selected)}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-primary w-fit shrink-0 no-underline"
                    >
                      <Icon name="mapPin" size={16} />
                      Get Directions
                    </a>
                    {/* The official menu, always one tap away: the feed this
                        page reads is a deactivated site's API (issue #467). */}
                    {selected.kind !== 'retail' && (
                      <a
                        href={OFFICIAL_MENU_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary w-fit shrink-0 no-underline"
                        data-dining-official-menu
                      >
                        Official menu
                        <Icon name="arrowUpRight" size={15} />
                      </a>
                    )}
                  </div>
                </div>
              </div>

              {feedNotice(selected) && (
                <div
                  role="status"
                  className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-border-2)] bg-[var(--color-stat)] px-4 py-3 text-[13.5px] text-[var(--color-txt-1)]"
                  data-dining-feed-stale
                >
                  {feedNotice(selected)}{' '}
                  <a href={OFFICIAL_MENU_URL} target="_blank" rel="noopener noreferrer" className="prose-link">
                    Official menu at IU Indy Eats
                  </a>
                </div>
              )}

              {signedIn && favoriteError && (
                <div
                  role="alert"
                  className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-border-2)] bg-[var(--color-stat)] px-4 py-3 text-[13.5px] text-[var(--color-txt-1)]"
                  data-dining-favorite-error
                >
                  {favoriteError}
                </div>
              )}

              {/* The meal's stations, the food court's vendors, or the honest reason there are none */}
              {!activeMenu && campusVendors.length > 0 ? (
                <CampusCenterVendors name={selected.name} vendors={campusVendors} />
              ) : !activeMenu ? (
                <div className="empty bg-[var(--color-surface)] p-5" data-dining-empty={empty.kind}>
                  <span className="ico">
                    <Icon name={empty.icon} size={18} />
                  </span>
                  <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">{empty.title}</p>
                  <p className="max-w-md -mt-1">{empty.body}</p>
                </div>
              ) : (
                <>
                  {/* One pill per posted meal, defaulting to the one being served. */}
                  {activeMenu.meal !== ALL_MEALS && (
                    <div role="group" aria-label="Meal" className="flex flex-wrap gap-2 mb-4" data-dining-meals>
                      {mealOptions.map((meal) => (
                        <button
                          key={meal}
                          type="button"
                          onClick={() => showView({ hall: selected.slug, meal })}
                          aria-pressed={meal === activeMenu.meal}
                          data-dining-meal={meal}
                          className={`pill md:min-h-[36px] px-4 text-[13.5px] ${meal === activeMenu.meal ? 'pill-active' : ''}`}
                        >
                          {mealLabel(meal)}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Today's headline dishes for this meal, with their photos (issue #469). */}
                  {headliners.length > 0 && (
                    <section className="mb-4" aria-label="Today's headliners" data-dining-headliners>
                      <p className="eyebrow bare mb-2">Today&apos;s headliners</p>
                      <div className="flex gap-3 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
                        {headliners.map((dish) => {
                          const onMenu = menuItemNamed(dish.name)
                          const inner = (
                            <>
                              {dish.image ? (
                                <img
                                  src={dish.image}
                                  alt=""
                                  width={176}
                                  height={132}
                                  loading="lazy"
                                  decoding="async"
                                  className="block w-full aspect-[4/3] object-cover rounded-[var(--radius-md)] bg-[var(--color-stat)]"
                                />
                              ) : (
                                <span className="grid place-items-center w-full aspect-[4/3] rounded-[var(--radius-md)] bg-[var(--color-stat)] text-[var(--color-txt-3)]">
                                  <Icon name="dining" size={22} />
                                </span>
                              )}
                              <span className="mt-1.5 block font-display font-semibold text-[13.5px] leading-snug text-[var(--color-txt-0)]">
                                {dish.name}
                              </span>
                            </>
                          )
                          return onMenu ? (
                            <button
                              key={dish.name}
                              type="button"
                              onClick={(e) => openItem(onMenu.item, onMenu.station, e.currentTarget)}
                              className="w-[176px] shrink-0 self-start text-left"
                              data-dining-headliner={dish.name}
                            >
                              {inner}
                            </button>
                          ) : (
                            <div key={dish.name} className="w-[176px] shrink-0 self-start" data-dining-headliner={dish.name}>
                              {inner}
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}
                  {/* Diet filters, with the allergen caveat always beside them (issue #468). */}
                  <div className="mb-4" data-dining-diet>
                    <div role="group" aria-label="Diet labels" className="flex flex-wrap items-center gap-2">
                      {DIET_FILTERS.map((label) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => toggleDietFilter(label)}
                          aria-pressed={dietFilters.includes(label)}
                          data-dining-diet-filter={label}
                          className={`pill ${dietFilters.includes(label) ? 'pill-active' : ''}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-[12px] leading-snug text-[var(--color-txt-2)] max-w-2xl" data-dining-diet-note>
                      {DIET_LABEL_NOTE}
                    </p>
                  </div>
                  {filteredOut && (
                    <div className="empty bg-[var(--color-surface)] p-5" data-dining-no-match>
                      <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">
                        Nothing on this menu is labelled {dietFilters.join(' and ')}.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setDietFilters([])
                          writeDietFilters([])
                        }}
                        className="btn btn-secondary btn-sm"
                      >
                        Clear filters
                      </button>
                    </div>
                  )}
                  {specials.length > 0 && everyday.length > 0 && (
                    <p className="eyebrow bare mb-3" data-dining-specials-label>
                      Today&apos;s specials
                    </p>
                  )}
                  {specials.length > 0 && (
                    <StationGrid
                      stations={specials}
                      favorites={favorites}
                      onToggleFavorite={signedIn ? toggleFavorite : undefined}
                      onOpenItem={openItem}
                    />
                  )}
                  {everyday.length > 0 && (
                    // Keyed by location and meal, so another tab starts collapsed again.
                    <EverydayStations
                      key={`${selected.id}:${activeMenu.meal}`}
                      stations={everyday}
                      firstIndex={specials.length}
                      defaultOpen={specials.length === 0}
                      favorites={favorites}
                      onToggleFavorite={signedIn ? toggleFavorite : undefined}
                      onOpenItem={openItem}
                    />
                  )}
                </>
              )}
            </div>
          )}

          {/* Weekly hours for every location, straight from the feed */}
          <div className="card card-pad r-din" data-dining-hours>
            <div className="card-head">
              <span className="route-badge">
                <Icon name="clock" size={18} />
              </span>
              <div className="card-title">Weekly Hours of Operation</div>
            </div>

            {withHours.length > 0 ? (
              <div className="divide-y divide-[var(--color-border)]">
                {withHours.map((loc) => (
                  <div key={loc.id} className="py-4 first:pt-1 last:pb-0" data-dining-hours-for={loc.slug}>
                    {/* Phones give the status its own line under the name, without
                        the separator: wrapped on a 320px phone it started its line
                        with a stray dot (R66). 18px is the dot plus the gap. */}
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mb-3">
                      <span className={`status-dot shrink-0 ${statusDotClass(loc)}`} />
                      <span className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">{loc.name}</span>
                      <span className="max-sm:basis-full max-sm:pl-[18px] text-[12.5px] text-[var(--color-txt-2)]">
                        <span className="max-sm:hidden">· </span>
                        {statusLine(loc)}
                      </span>
                    </div>
                    {/* A week strip: a 4px rule per day, amber for the campus
                        day. Phones list the days as rows with the rule on the left. */}
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-4 sm:gap-x-2 sm:gap-y-3 md:grid-cols-7">
                      {WEEKDAY_ORDER.map((day) => {
                        // Closed, or "Not listed" for a day the feed flags
                        // closed that has a menu (issue #465), in the muted style.
                        const cell = weeklyHoursCell(loc.weekly_hours?.[day])
                        const isToday = day === weekday
                        return (
                          <div
                            key={day}
                            data-hours-today={isToday ? 'true' : undefined}
                            className={`flex items-baseline justify-between gap-3 border-l-4 pl-3 py-1.5 sm:flex-col sm:items-start sm:justify-start sm:gap-1.5 sm:border-l-0 sm:border-t-4 sm:pl-0 sm:pt-2 sm:pb-0 ${
                              isToday ? 'border-[var(--color-gold)]' : 'border-[var(--color-bg-3)]'
                            }`}
                          >
                            <div className={`eyebrow bare ${isToday ? 'text-[var(--color-txt-0)]' : ''}`}>
                              {SHORT_DAY[day]}
                            </div>
                            <div
                              className={`font-display text-[13px] md:max-lg:text-[12.5px] leading-snug tnum text-balance ${
                                cell.muted ? 'font-semibold text-[var(--color-txt-3)]' : 'font-bold text-[var(--color-txt-0)]'
                              }`}
                            >
                              {cell.label}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
                {/* The feed's hours are unverified: identical placeholder
                    weekday hours for both halls, and weekends flagged closed
                    while Tower serves (issue #465). */}
                <p className="pt-4 text-[12.5px] leading-snug text-[var(--color-txt-2)]" data-dining-hours-note>
                  These hours come from the campus menu feed and may not be current.{' '}
                  <a href={OFFICIAL_HOURS_URL} target="_blank" rel="noopener noreferrer" className="prose-link">
                    Official hours at IU Indy Eats
                  </a>
                </p>
              </div>
            ) : (
              <div className="empty row">
                <span className="ico">
                  <Icon name="clock" size={18} />
                </span>
                <p data-dining-no-hours>
                  Hours are not posted right now. They come from the same live feed as the menus, so they will reappear when it does.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      <DishDialog
        item={openDish?.item ?? null}
        station={openDish?.station}
        date={live?.date ?? null}
        isFavorite={openDish ? favorites.has(normalizeItemName(openDish.item.name)) : false}
        onToggleFavorite={signedIn ? toggleFavorite : undefined}
        onClose={closeDish}
        returnFocusTo={openDish?.trigger ?? null}
      />
    </div>
  )
}
