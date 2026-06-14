import { Link } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { authRequest, shouldSkipSetup } from '../lib/authApi'
import { cleanAiText } from '../lib/linkifyText'
import Icon from '../components/Icons'
import {
  routes as transitRoutes,
  TRANLOC_ROUTE_ALIASES,
  UNKNOWN_ROUTE,
  SCHEDULE_PEERS,
  canonicalFromMap,
  buildTranslocRouteIdMap,
  nearestStopForVehicle,
  getOrderedStopsForRoute,
  haversineMeters,
  isRouteActiveNow,
} from '../lib/transitShared'
import {
  getHomeClassItems,
  isLikelyExamItem,
  isOnlineMeetingNoise,
  shouldExcludeFromSchedule,
} from '../lib/scheduleFilters'
import { useDashboardLayout } from '../hooks/useDashboardLayout'
import { useGradeTracker } from '../hooks/useGradeTracker'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import DashboardWidget from '../components/dashboard/DashboardWidget'
import AddWidgetPicker from '../components/dashboard/AddWidgetPicker'
import SponsoredWidget from '../components/dashboard/SponsoredWidget'

const quickActionTemplates = [
  { path: '/map', label: 'Campus Map', sub: 'Find any building', icon: 'mapPin', color: 'map' },
  { path: '/dining', label: 'Dining', sub: 'See what\'s open', icon: 'dining', color: 'dining' },
  { path: '/transit', label: 'Transit', sub: 'Live bus times', icon: 'bus', color: 'bus' },
  { path: '/events', label: 'Events', sub: '', icon: 'calendar', color: 'events' },
]

// Quick actions widget width -> internal grid columns. At quarter width the
// actions stack into a single vertical column; wider widths fan them out. Full
// class strings keep Tailwind's scanner happy (it can't read computed names).
const QUICK_ACTIONS_GRID_CLASS = {
  quarter: 'grid-cols-1',
  half: 'grid-cols-2',
  'three-quarter': 'grid-cols-2 lg:grid-cols-3',
  full: 'grid-cols-2 lg:grid-cols-4',
}
function quickActionsGridClass(size) {
  return QUICK_ACTIONS_GRID_CLASS[size] || QUICK_ACTIONS_GRID_CLASS.full
}

/** Broader fetch for Home: dues + events (today's event strip still filters to event-like categories). */
const HOME_CALENDAR_CATEGORIES =
  'campus_event,event,deadline,activity,assignment,task,homework,submission,quiz,project,exam,lab,midterm,paper,presentation'

/** User message for /api/assistant — server already attaches schedule & calendar context. */
const WEEK_AHEAD_GEMINI_PROMPT = `Write a concise "Week Ahead" summary for my dashboard using ONLY the class schedule, assignments, deadlines, and events in your context. Do not invent courses, due dates, or events.

Requirements:
- Plain text only. No markdown, no bullets, no numbered lists, no emoji.
- Use 2–4 short paragraphs separated by a blank line between each.
- First paragraph: my weekly class rhythm — each course and which days it meets.
- Next: assignments, exams, or deadlines due this calendar week, or clearly say nothing major is due.
- Last: notable campus or career events this week, or say none scheduled.
- Stay under 160 words. Write in second person ("you"). Be warm and skimmable.`

const homeEventCategory = {
  campus_event: {
    label: 'Campus Event',
    badge: 'bg-pink-50 dark:bg-pink-900/20 text-pink-700 dark:text-pink-400',
    dot: 'bg-pink-500',
  },
  event: {
    label: 'Event',
    badge: 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400',
    dot: 'bg-indigo-500',
  },
  deadline: {
    label: 'Deadline',
    badge: 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
    dot: 'bg-yellow-500',
  },
}

function isSameLocalDay(isoOrDate, now) {
  return new Date(isoOrDate).toDateString() === now.toDateString()
}

/** Event still has time left today (not fully ended). All-day (midnight start) stays for the whole local day. */
function isStillRelevantToday(item, now) {
  const start = new Date(item.startTime)
  const end = item.endTime ? new Date(item.endTime) : null
  const likelyAllDay = start.getHours() === 0 && start.getMinutes() === 0
  if (likelyAllDay && isSameLocalDay(item.startTime, now)) {
    if (end) return end > now
    return true
  }
  if (end) return end > now
  return start >= now
}

function filterTodayRelevantEvents(items, now) {
  return (items || [])
    .filter(
      (item) =>
        item?.startTime &&
        isSameLocalDay(item.startTime, now) &&
        isStillRelevantToday(item, now),
    )
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
}

function formatDashboardEventTime(startTime, endTime) {
  const start = new Date(startTime)
  if (start.getHours() === 0 && start.getMinutes() === 0) return 'All day'
  const startLabel = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (!endTime) return startLabel
  const end = new Date(endTime)
  const endLabel = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${startLabel} – ${endLabel}`
}

const fallbackMenuPreview = {
  entrees: ['Grilled Chicken', 'Pasta Marinara', 'Black Bean Burger', 'Mac & Cheese'],
  sides: ['Caesar Salad', 'Roasted Veggies', 'Garlic Bread'],
}

const colorMap = {
  map: 'bg-[var(--color-map-bg)] text-[var(--color-map-color)]',
  dining: 'bg-[var(--color-dining-bg)] text-[var(--color-dining-color)]',
  bus: 'bg-[var(--color-bus-bg)] text-[var(--color-bus-title)]',
  events: 'bg-[var(--color-events-bg)] text-[var(--color-events-color)]',
}

function getGreeting(now) {
  const hour = now.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function getCurrentDate(now) {
  return now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatTimeRange(startTime, endTime) {
  const start = new Date(startTime)
  const end = endTime ? new Date(endTime) : null
  const startLabel = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const endLabel = end ? end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  return endLabel ? `${startLabel} – ${endLabel}` : startLabel
}

function formatDuration(minutes) {
  if (minutes <= 0) return '0m'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (!hours) return `${mins}m`
  if (!mins) return `${hours}h`
  return `${hours}h ${mins}m`
}

function getMinutesBetween(later, earlier) {
  return Math.max(0, Math.round((later.getTime() - earlier.getTime()) / 60000))
}

function deriveScheduleState(items, now) {
  const safeItems = (items || []).filter(
    (item) => item != null && typeof item === 'object' && item.startTime != null && item.startTime !== '',
  )
  const normalized = safeItems
    .map((item) => ({
      ...item,
      startDate: new Date(item.startTime),
      endDate: item.endTime ? new Date(item.endTime) : new Date(item.startTime),
    }))
    .filter((item) => !Number.isNaN(item.startDate.getTime()))
    .sort((a, b) => a.startDate - b.startDate)

  const currentClass = normalized.find((item) => item.startDate <= now && item.endDate > now && !shouldExcludeFromSchedule(item)) || null
  const futureItems = normalized.filter((item) => item.startDate > now && !shouldExcludeFromSchedule(item))
  const nextClass = futureItems[0] || null

  const displayClass = currentClass || nextClass
  let freeMinutes = 0
  let freeLabel = 'No more classes today'
  let statusLabel = 'Schedule clear'
  let cardLabel = 'Next Class'
  let cardMeta = 'No live class data'

  if (currentClass && nextClass) {
    freeMinutes = getMinutesBetween(nextClass.startDate, currentClass.endDate)
    freeLabel = `Free after ${currentClass.title} until ${nextClass.title}`
    statusLabel = `Current class ends in ${formatDuration(getMinutesBetween(currentClass.endDate, now))}`
    cardLabel = 'Current Class'
    cardMeta = `Next: ${nextClass.title} in ${formatDuration(getMinutesBetween(nextClass.startDate, now))}`
  } else if (currentClass) {
    freeMinutes = 0
    freeLabel = `In class until ${currentClass.endDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    statusLabel = `Current class ends in ${formatDuration(getMinutesBetween(currentClass.endDate, now))}`
    cardLabel = 'Current Class'
    cardMeta = 'No later class found'
  } else if (nextClass) {
    freeMinutes = getMinutesBetween(nextClass.startDate, now)
    freeLabel = `Free before ${nextClass.title}`
    statusLabel = `In ${formatDuration(freeMinutes)}`
    cardLabel = isLikelyExamItem(nextClass) ? 'Next Exam' : 'Next Class'
    cardMeta = `${new Date(nextClass.startTime).toLocaleDateString(undefined, { weekday: 'long' })} · ${formatTimeRange(nextClass.startTime, nextClass.endTime)}`
  }

  return {
    currentClass,
    nextClass,
    displayClass,
    freeMinutes,
    freeLabel,
    statusLabel,
    cardLabel,
    cardMeta,
  }
}

const AVG_STOP_MINUTES = 2

/**
 * Find the index of the stop closest to a given lat/lon within the ordered
 * stop list. Returns -1 if no stop is within 300m.
 */
function findStopIndex(routeStops, lat, lon) {
  let bestIdx = -1
  let bestD = 300
  for (let i = 0; i < routeStops.length; i++) {
    const d = haversineMeters(routeStops[i].lat, routeStops[i].lon, lat, lon)
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Plain-language ETA from this bus to the user's nearest stop on its route.
 * Falls back to a generic description when user location or stop data is missing.
 */
function describeBusEta(vehicle, route, nearestBusStop, routeStops, speed, moving, userLoc) {
  if (!routeStops?.length) {
    if (!moving) return `${route.shortName} bus is stopped`
    return `${route.shortName} bus is moving at ${Math.round(speed)} mph`
  }

  const busIdx = findStopIndex(routeStops, vehicle.Latitude, vehicle.Longitude)

  // Find user's closest stop on this route
  let userIdx = -1
  let userStopName = null
  if (userLoc) {
    let bestD = Infinity
    for (let i = 0; i < routeStops.length; i++) {
      const d = haversineMeters(routeStops[i].lat, routeStops[i].lon, userLoc.lat, userLoc.lon)
      if (d < bestD) {
        bestD = d
        userIdx = i
      }
    }
    if (bestD < 2000) {
      userStopName = routeStops[userIdx].name
    } else {
      userIdx = -1
    }
  }

  // If we know both positions, compute stops between bus and user
  if (busIdx !== -1 && userIdx !== -1 && userStopName) {
    // Route is a loop: bus travels in index order and wraps around
    const stopsAway =
      userIdx >= busIdx
        ? userIdx - busIdx
        : routeStops.length - busIdx + userIdx
    if (stopsAway === 0) {
      return `At your stop — ${userStopName}`
    }
    const etaMin = stopsAway * AVG_STOP_MINUTES
    const stopWord = stopsAway === 1 ? 'stop' : 'stops'
    return `${stopsAway} ${stopWord} from you (${userStopName}), ~${etaMin} min`
  }

  // Fallback: no user location — describe bus position generically
  if (!nearestBusStop) {
    if (!moving) return `${route.shortName} bus is stopped`
    return `${route.shortName} bus is en route`
  }
  const dist = nearestBusStop.meters
  if (dist < 150) return `At ${nearestBusStop.description}`
  if (!moving) return `Near ${nearestBusStop.description}, stopped`
  const avgMps = (speed > 1 ? speed : 12) * 0.44704
  const etaMin = Math.max(1, Math.round(dist / avgMps / 60))
  return `~${etaMin} min from ${nearestBusStop.description}`
}

/** Avoid "Today 12:00 AM" for calendar blocks that start at local midnight (common all-day pattern). */
function formatSuggestionEventTiming(item, now) {
  if (!item?.startTime) return 'Today'
  const start = new Date(item.startTime)
  const end = item.endTime ? new Date(item.endTime) : null
  const midnightStart = start.getHours() === 0 && start.getMinutes() === 0
  const spansRestOfDay =
    midnightStart &&
    end &&
    isSameLocalDay(item.startTime, now) &&
    end.getTime() - start.getTime() >= 20 * 60 * 60 * 1000
  if (midnightStart && isSameLocalDay(item.startTime, now) && (!end || spansRestOfDay)) {
    return 'Today · All day'
  }
  if (isSameLocalDay(item.startTime, now)) {
    const t = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return `Today · ${t}`
  }
  const dayPart = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const timePart = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${dayPart} · ${timePart}`
}

function buildSuggestions({ freeMinutes, nextClass, currentClass, diningStatus, upcomingEvents, now }) {
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const list = []

  // Currently in class
  if (currentClass && freeMinutes === 0) {
    list.push({
      icon: 'book',
      text: `In ${currentClass.title} right now`,
      time: currentClass.endTime ? `Until ${fmtTime(currentClass.endTime)}` : 'In progress',
      variant: 'class',
    })
    if (nextClass) {
      list.push({
        icon: 'mapPin',
        text: `Next: ${nextClass.title}${nextClass.location ? ` · ${nextClass.location}` : ''}`,
        time: fmtTime(nextClass.startTime),
        variant: 'nav',
      })
    }
    list.push({ icon: 'coffee', text: 'Plan a break after class', time: 'Soon', variant: 'default' })
    return list.slice(0, 3)
  }

  // Tight gap — need to head to next class
  if (freeMinutes > 0 && freeMinutes < 20 && nextClass) {
    list.push({
      icon: 'mapPin',
      text: `Head to ${nextClass.location || 'your next class'}`,
      time: `${nextClass.title} · ${fmtTime(nextClass.startTime)}`,
      variant: 'nav',
    })
    list.push({ icon: 'book', text: 'Skim notes en route', time: formatDuration(freeMinutes), variant: 'free' })
    list.push({ icon: 'coffee', text: 'Quick water or coffee', time: 'Keep it short', variant: 'default' })
    return list.slice(0, 3)
  }

  // Good window — dining open?
  if (diningStatus?.is_open && freeMinutes >= 25) {
    const hrs = diningStatus.hours && diningStatus.hours !== 'Closed today' ? diningStatus.hours : 'Open now'
    list.push({
      icon: 'dining',
      text: `${diningStatus.name} is open`,
      time: hrs,
      variant: 'dining-open',
    })
  } else if (diningStatus && !diningStatus.is_open) {
    const hoursLine = diningStatus.hours && diningStatus.hours !== 'Closed' ? diningStatus.hours : null
    list.push({
      icon: 'dining',
      text: `${diningStatus.name} is closed right now`,
      time: 'Closed',
      variant: 'dining-closed',
      sub: hoursLine || undefined,
    })
  }

  // Upcoming event today?
  const nextEvent = upcomingEvents?.[0]
  if (nextEvent && (nextEvent.title || nextEvent.startTime)) {
    list.push({
      icon: 'calendar',
      text: nextEvent.title || 'Event',
      time: formatSuggestionEventTiming(nextEvent, now),
      variant: 'event',
    })
  }

  // Study suggestion
  if (freeMinutes >= 90) {
    list.push({
      icon: 'book',
      text: nextClass ? `Study before ${nextClass.title}` : 'Good time for a study block',
      time: formatDuration(freeMinutes),
      variant: 'free',
      sub: 'Free window',
    })
  } else if (freeMinutes >= 30) {
    list.push({
      icon: 'coffee',
      text: 'Coffee + review notes',
      time: formatDuration(freeMinutes),
      variant: 'free',
      sub: 'Free window',
    })
  } else if (freeMinutes > 0) {
    list.push({
      icon: 'book',
      text: 'Quick review before class',
      time: formatDuration(freeMinutes),
      variant: 'free',
      sub: 'Free window',
    })
  }

  // Pad with fallbacks if under 3
  const fallbacks = [
    { icon: 'coffee', text: 'Grab coffee at the Union', time: '5 min walk', variant: 'default' },
    { icon: 'book', text: 'Study at Cavanaugh Hall', time: 'Quiet floor', variant: 'default' },
    { icon: 'mapPin', text: 'Explore the Campus Center', time: 'Nearby', variant: 'default' },
  ]
  let i = 0
  while (list.length < 3 && i < fallbacks.length) list.push(fallbacks[i++])

  return list.slice(0, 3)
}

export default function Home() {
  const { getFirstName, onboarding, user, authConfig } = useAuth()
  const firstName = getFirstName()
  const reducedMotion = usePrefersReducedMotion()
  const { layout, editing, setEditing, move, reorder, setVisible, setSize, reset } = useDashboardLayout(user?.id)
  const { summary: gpaSummary } = useGradeTracker(user?.id)
  const [now, setNow] = useState(() => new Date())
  const [classes, setClasses] = useState([])
  const [classLoadError, setClassLoadError] = useState('')
  const [calendarItems, setCalendarItems] = useState([])
  const [calendarLoadError, setCalendarLoadError] = useState('')
  const [calendarLoading, setCalendarLoading] = useState(true)

  const [transitVehicles, setTransitVehicles] = useState([])
  const [transitStops, setTransitStops] = useState([])
  const [transitRouteMap, setTransitRouteMap] = useState(() => ({ ...TRANLOC_ROUTE_ALIASES }))
  const [transitLoading, setTransitLoading] = useState(true)
  const [transitError, setTransitError] = useState('')
  const [transitUpdated, setTransitUpdated] = useState(null)
  const [userLocation, setUserLocation] = useState(null) // { lat, lon }

  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 },
    )
  }, [])

  const [diningPreview, setDiningPreview] = useState(null)
  const [diningStatus, setDiningStatus] = useState(null) // { name, is_open, hours, weekly_hours }

  const [boardPreview, setBoardPreview] = useState([])
  const [boardLoading, setBoardLoading] = useState(true)
  const [boardError, setBoardError] = useState('')

  function getWeekDigestStorageKey() {
    const d = new Date()
    const day = d.getDay()
    const monday = new Date(d)
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    return `ai-week-ahead-${monday.toISOString().slice(0, 10)}`
  }

  function readCachedWeekDigest() {
    try {
      const raw = JSON.parse(localStorage.getItem(getWeekDigestStorageKey()))
      return typeof raw === 'string' && raw.trim() ? raw : null
    } catch {
      return null
    }
  }

  const [weekAheadText, setWeekAheadText] = useState(readCachedWeekDigest)
  // Start loading when there is no cached digest: the mount effect will fetch
  // one. Deriving the initial value here means the effect never has to flip the
  // flag synchronously (which trips react-hooks/set-state-in-effect).
  const [weekAheadLoading, setWeekAheadLoading] = useState(() => !readCachedWeekDigest())

  // Fetches and stores the digest. Does NOT raise the loading flag on entry —
  // the mount path starts with it already true, and the Refresh button raises it
  // via generateWeekAheadSummary. The only setState calls here run inside async
  // promise callbacks, so this is safe to call directly from an effect.
  const fetchWeekAheadSummary = () => {
    fetch('/api/assistant', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: WEEK_AHEAD_GEMINI_PROMPT }],
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.reply) {
          const clean = cleanAiText(d.reply)
          setWeekAheadText(clean)
          try {
            localStorage.setItem(getWeekDigestStorageKey(), JSON.stringify(clean))
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {})
      .finally(() => setWeekAheadLoading(false))
  }

  const generateWeekAheadSummary = () => {
    setWeekAheadLoading(true)
    fetchWeekAheadSummary()
  }

  useEffect(() => {
    if (!weekAheadText) fetchWeekAheadSummary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/dining')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.ok || !Array.isArray(data.locations)) return
        const tower = data.locations.find((l) => l.slug === 'tower-dining') || data.locations[0]
        if (!tower) return
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' })
        const todayHrs = tower.weekly_hours?.[todayName]
        setDiningStatus({
          name: tower.name,
          is_open: tower.is_open,
          hours: todayHrs || tower.hours,
          weekly_hours: tower.weekly_hours || null,
        })
        const allItems = (tower.stations || []).flatMap((s) => s.items || [])
        const names = allItems.map((i) => i.name).filter(Boolean)
        if (names.length > 0) {
          setDiningPreview({ items: names.slice(0, 8) })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setBoardLoading(true)
      try {
        const data = await authRequest('/api/board/posts?sort=recent')
        if (cancelled) return
        setBoardPreview((data.posts || []).slice(0, 3))
        setBoardError('')
      } catch (e) {
        if (!cancelled) {
          setBoardPreview([])
          setBoardError(e?.message || 'Could not load board.')
        }
      } finally {
        if (!cancelled) setBoardLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const menuSnapshot = diningPreview || { items: fallbackMenuPreview.entrees.concat(fallbackMenuPreview.sides) }

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setCalendarLoading(true)
      const [classesResult, calResult] = await Promise.allSettled([
        authRequest('/api/me/classes?limit=200&mode=display'),
        authRequest(`/api/me/calendar?categories=${HOME_CALENDAR_CATEGORIES}&limit=200`),
      ])
      if (cancelled) return
      if (classesResult.status === 'fulfilled') {
        setClasses(classesResult.value.items || [])
        setClassLoadError('')
      } else {
        setClasses([])
        setClassLoadError(classesResult.reason?.message || 'Could not load classes.')
      }
      if (calResult.status === 'fulfilled') {
        setCalendarItems(calResult.value.items || [])
        setCalendarLoadError('')
      } else {
        setCalendarItems([])
        setCalendarLoadError(calResult.reason?.message || 'Could not load events.')
      }
      setCalendarLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadStopsAndRoutes() {
      try {
        const [sRes, rRes] = await Promise.all([fetch('/api/transit/stops'), fetch('/api/transit/routes')])
        const stopsData = sRes.ok ? await sRes.json() : []
        const routesData = rRes.ok ? await rRes.json() : null
        if (cancelled) return
        setTransitStops(Array.isArray(stopsData) ? stopsData : [])
        if (Array.isArray(routesData)) {
          setTransitRouteMap(buildTranslocRouteIdMap(routesData))
        }
      } catch {
        if (!cancelled) setTransitStops([])
      }
    }

    async function loadVehicles() {
      try {
        const res = await fetch('/api/transit/vehicles')
        const data = await res.json()
        if (cancelled) return
        if (!res.ok || (data && typeof data === 'object' && !Array.isArray(data) && data.error)) {
          setTransitError(typeof data?.error === 'string' ? data.error : 'Could not load live buses.')
          setTransitVehicles([])
        } else {
          setTransitError('')
          setTransitVehicles(Array.isArray(data) ? data : [])
        }
        setTransitUpdated(new Date())
      } catch (e) {
        if (!cancelled) {
          setTransitError(e?.message || 'Could not load live buses.')
          setTransitVehicles([])
        }
      }
    }

    ;(async () => {
      setTransitLoading(true)
      setTransitError('')
      await loadStopsAndRoutes()
      await loadVehicles()
      if (!cancelled) setTransitLoading(false)
    })()

    const id = window.setInterval(loadVehicles, 10000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const cleanCalendarItems = useMemo(
    () => calendarItems.filter((i) => i && !isOnlineMeetingNoise(i)),
    [calendarItems],
  )
  const homeClasses = useMemo(() => getHomeClassItems(classes), [classes])
  const scheduleState = useMemo(() => deriveScheduleState(homeClasses, now), [homeClasses, now])
  const suggestions = useMemo(() => buildSuggestions({
    freeMinutes: scheduleState.freeMinutes,
    nextClass: scheduleState.nextClass,
    currentClass: scheduleState.currentClass,
    diningStatus,
    upcomingEvents: cleanCalendarItems.filter((i) => ['campus_event', 'event', 'activity'].includes(i.category)),
    now,
  }), [scheduleState, diningStatus, cleanCalendarItems, now])

  const todayRelevantEvents = useMemo(
    () =>
      filterTodayRelevantEvents(
        cleanCalendarItems.filter((i) => ['campus_event', 'event', 'activity'].includes(i.category)),
        now,
      ),
    [cleanCalendarItems, now],
  )
  const todayEventsPreview = useMemo(() => todayRelevantEvents.slice(0, 6), [todayRelevantEvents])

  const eventsQuickSub = useMemo(() => {
    if (calendarLoading) return 'Loading…'
    if (todayRelevantEvents.length === 0) return 'None today'
    if (todayRelevantEvents.length === 1) return '1 today'
    return `${todayRelevantEvents.length} today`
  }, [calendarLoading, todayRelevantEvents.length])

  const transitQuickSub = useMemo(() => {
    if (transitLoading && transitVehicles.length === 0 && !transitError) return 'Loading…'
    if (transitError && transitVehicles.length === 0) return 'Tap for map'
    if (transitVehicles.length === 0) return 'No buses live'
    return `${transitVehicles.length} bus${transitVehicles.length === 1 ? '' : 'es'} live`
  }, [transitLoading, transitVehicles.length, transitError])

  const transitDashboardRows = useMemo(() => {
    const mapped = (transitVehicles || []).map((v) => {
      let canon = canonicalFromMap(transitRouteMap, v.RouteID)
      const reportedRoute = transitRoutes.find((r) => r.id === canon)
      if (reportedRoute && !isRouteActiveNow(reportedRoute)) {
        const peerId = SCHEDULE_PEERS[canon]
        if (peerId != null) {
          const peerRoute = transitRoutes.find((r) => r.id === peerId)
          if (peerRoute && isRouteActiveNow(peerRoute)) canon = peerId
        }
      }
      const route = transitRoutes.find((r) => r.id === canon) || UNKNOWN_ROUTE
      const near = nearestStopForVehicle(transitStops, v, transitRouteMap)
      const speed = Number(v.GroundSpeed) || 0
      const moving = speed > 0.5

      const routeStops = getOrderedStopsForRoute(transitStops, canon, transitRouteMap)
      const eta = describeBusEta(v, route, near, routeStops, speed, moving, userLocation)

      return {
        key: v.VehicleID ?? `${v.Latitude},${v.Longitude},${v.RouteID}`,
        vehicle: v,
        route,
        near,
        speed,
        moving,
        eta,
      }
    })
    mapped.sort((a, b) => {
      const byRoute = a.route.shortName.localeCompare(b.route.shortName)
      if (byRoute !== 0) return byRoute
      return String(a.vehicle.Name || '').localeCompare(String(b.vehicle.Name || ''))
    })
    return mapped.slice(0, 5)
  }, [transitVehicles, transitStops, transitRouteMap, userLocation])

  const smartAlerts = useMemo(() => {
    const alerts = []
    const nowMs = now.getTime()

    // Assignment due within 24 hours
    const urgentItems = (calendarItems || []).filter((item) => {
      if (!item || !item.startTime) return false
      if (['campus_event', 'event', 'class'].includes(item.category)) return false
      const due = new Date(item.startTime).getTime()
      return due > nowMs && due - nowMs < 24 * 60 * 60 * 1000
    })
    for (const item of urgentItems.slice(0, 2)) {
      const hoursLeft = Math.round((new Date(item.startTime).getTime() - nowMs) / 3600000)
      alerts.push({
        icon: 'alert',
        color: 'text-red-500',
        text: `${item.title} is due in ${hoursLeft}h`,
      })
    }

    // Next class starting within 15 minutes
    if (scheduleState.nextClass && !scheduleState.currentClass) {
      const minsToClass = Math.round(
        (new Date(scheduleState.nextClass.startTime).getTime() - nowMs) / 60000,
      )
      if (minsToClass > 0 && minsToClass <= 15) {
        alerts.push({
          icon: 'clock',
          color: 'text-orange-500',
          text: `${scheduleState.nextClass.title} starts in ${minsToClass} min`,
        })
      }
    }

    // Dining closing within 45 minutes
    if (diningStatus?.is_open && diningStatus.hours) {
      const match = diningStatus.hours.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*$/i)
      if (match) {
        const todayStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        const closeTime = new Date(`${todayStr} ${match[1]}`)
        if (!isNaN(closeTime)) {
          const minsUntilClose = Math.round((closeTime.getTime() - nowMs) / 60000)
          if (minsUntilClose > 0 && minsUntilClose <= 45) {
            alerts.push({
              icon: 'dining',
              color: 'text-yellow-500',
              text: `${diningStatus.name} closes in ${minsUntilClose} min`,
            })
          }
        }
      }
    }

    // No buses running
    if (!transitLoading && transitVehicles.length === 0 && !transitError) {
      alerts.push({
        icon: 'bus',
        color: 'text-[var(--color-txt-3)]',
        text: 'No campus shuttles are running right now',
      })
    }

    return alerts.slice(0, 4)
  }, [now, calendarItems, scheduleState, diningStatus, transitLoading, transitVehicles, transitError])

  const quickActions = useMemo(
    () =>
      quickActionTemplates.map((a) => {
        if (a.path === '/events') return { ...a, sub: eventsQuickSub }
        if (a.path === '/transit') return { ...a, sub: transitQuickSub }
        return a
      }),
    [eventsQuickSub, transitQuickSub],
  )

  const needsPurdueConnection = onboarding?.needsPurdueConnection
  const needsScheduleSource = onboarding?.needsScheduleSource
  const purdueLinkingOff = authConfig?.supportsPurdueLink === false
  const showSetupBanner = (needsPurdueConnection || needsScheduleSource) && !shouldSkipSetup()
  const hasNoCalendarSources = onboarding?.linkedSourceCount === 0
  const displayClass = scheduleState.displayClass

  const tasksDuePreview = (cleanCalendarItems || [])
    .filter(
      (item) =>
        item?.startTime &&
        !['campus_event', 'event', 'activity', 'class'].includes(item.category) &&
        new Date(item.startTime).getTime() >= now.getTime(),
    )
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .slice(0, 5)

  // Registry: widget id → display title + a renderer that closes over the
  // already-computed state above. Each renderer returns the section's existing
  // card JSX verbatim (or null when it has nothing to show, e.g. smart alerts).
  // Only ids present here are rendered; unknown ids in a saved layout are
  // ignored. The saved layout drives order, size, and visibility.
  const widgetRegistry = {
    'week-ahead': {
      title: 'Week ahead',
      render: () => (
        <div
          className={`card p-4 sm:p-5 overflow-hidden transition-all duration-700 opacity-100 translate-y-0 ${
            now.getDay() === 1
              ? 'border-[var(--color-gold)]/40 bg-[var(--color-gold)]/5 ring-1 ring-[var(--color-gold)]/15'
              : 'border-[var(--color-gold)]/20'
          }`}
        >
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-1">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center shrink-0">
              <Icon name="sparkles" size={12} className="text-[var(--color-gold-dark)]" />
            </div>
            <div>
              <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
                {now.getDay() === 1 ? 'Monday briefing' : 'Week ahead'}
              </span>
              <p className="text-[11px] text-[var(--color-txt-3)] mt-0.5">
                Gemini · from your linked schedule & calendar
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={generateWeekAheadSummary}
            disabled={weekAheadLoading}
            className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-40 shrink-0 self-start sm:self-auto"
          >
            {weekAheadLoading ? 'Generating…' : 'Refresh'}
          </button>
        </div>
        <div className="mt-4">
          {weekAheadLoading && !weekAheadText ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)]">
              <div className="w-3.5 h-3.5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin shrink-0" />
              Generating your week summary…
            </div>
          ) : typeof weekAheadText === 'string' && weekAheadText ? (
            <div className="text-[13px] text-[var(--color-txt-1)] leading-relaxed space-y-3 whitespace-pre-line">
              {weekAheadText.split(/\n\n+/).map((para, i) => (
                <p key={i} className="m-0">
                  {para.trim()}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </div>
        ),
    },
    'smart-alerts': {
      title: 'Heads up',
      render: () =>
        smartAlerts.length === 0 ? null : (
        <div className="card p-4 border-[var(--color-border)] transition-all duration-700 opacity-100 translate-y-0">
          <div className="flex items-center gap-2 mb-3">
            <Icon name="alert" size={14} className="text-[var(--color-txt-2)]" />
            <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Heads Up</span>
          </div>
          <div className="space-y-2">
            {smartAlerts.map((alert, i) => (
              <div key={i} className="flex items-center gap-3 text-[13px]">
                <Icon name={alert.icon} size={14} className={alert.color} />
                <span className="text-[var(--color-txt-1)]">{alert.text}</span>
              </div>
            ))}
          </div>
        </div>
        ),
    },
    'quick-actions': {
      title: 'Quick actions',
      // Column count follows the widget's width so a narrow widget stacks its
      // actions vertically instead of squashing them. Full class strings are
      // written out so Tailwind's scanner emits them.
      render: (size) => (
        <div className={`grid gap-2.5 sm:gap-3 transition-all duration-700 opacity-100 translate-y-0 ${quickActionsGridClass(size)}`}>

        {quickActions.map(({ path, label, sub, icon, color }, idx) => (
          <Link
            key={path}
            to={path}
            className="group card card-interactive p-3 sm:p-4 flex items-center gap-3 sm:gap-4 active:scale-[0.98] transition-transform"
            style={{ animationDelay: `${idx * 0.05}s` }}
          >
            <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0 ${colorMap[color]} transition-transform duration-300 group-hover:scale-110`}>
              <Icon name={icon} size={18} className="sm:hidden" />
              <Icon name={icon} size={22} className="hidden sm:block" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] sm:text-[14px] font-medium text-[var(--color-txt-0)] group-hover:text-[var(--color-accent)] transition-colors">
                {label}
              </div>
              <div className="text-[11px] sm:text-[12px] text-[var(--color-txt-2)] mt-0.5 truncate">{sub}</div>
            </div>
            <Icon name="arrowUpRight" size={14} className="text-[var(--color-txt-3)] group-hover:text-[var(--color-accent)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all hidden sm:block" />
          </Link>
        ))}
        </div>
      ),
    },
    gpa: {
      title: 'GPA',
      render: () => {
        const gpa = gpaSummary.gpa
        const tone =
          gpa == null
            ? 'text-[var(--color-txt-2)]'
            : gpa >= 3.5
              ? 'text-[var(--color-success)]'
              : gpa >= 2.5
                ? 'text-[var(--color-gold)]'
                : 'text-[var(--color-error)]'
        return (
          <div className="card p-4 sm:p-5 transition-all duration-700 opacity-100 translate-y-0">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
                Cumulative GPA
              </span>
              <Link
                to="/grade-tracker"
                className="text-[11px] text-[var(--color-accent)] hover:underline"
              >
                {gpa == null ? 'Add grades' : 'View all'}
              </Link>
            </div>
            {gpa == null ? (
              <div className="text-[13px] text-[var(--color-txt-2)]">
                Track your courses to see your GPA here.
              </div>
            ) : (
              <div className="flex items-baseline gap-3">
                <span className={`text-4xl font-semibold ${tone}`}>{gpa.toFixed(2)}</span>
                <span className="text-[12px] text-[var(--color-txt-2)]">
                  {gpaSummary.credits} credits · {gpaSummary.terms.length} term
                  {gpaSummary.terms.length === 1 ? '' : 's'}
                </span>
              </div>
            )}
          </div>
        )
      },
    },
    'next-class': {
      title: 'Next class',
      render: () => (
        <div className="card p-4 sm:p-5 transition-all duration-700 opacity-100 translate-y-0">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
              {scheduleState.cardLabel}
            </span>
            <span className="text-[11px] text-[var(--color-txt-2)] flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse" />
              {scheduleState.statusLabel}
            </span>
          </div>

          {displayClass ? (
            <div className="bg-gradient-to-br from-[var(--color-cls-bg)] to-[var(--color-cls-bg)]/50 rounded-xl p-4 border border-[var(--color-cls-sub)]/10">
              <div className="text-[11px] font-semibold text-[var(--color-cls-sub)] tracking-wide">{displayClass.title}</div>
              <div className="text-[16px] font-semibold text-[var(--color-cls-title)] mt-1">{displayClass.description || 'Class meeting'}</div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--color-cls-sub)] mt-2">
                <span className="flex items-center gap-1.5">
                  <Icon name="mapPin" size={12} />
                  {displayClass.location || 'Location unavailable'}
                </span>
                <span className="flex items-center gap-1.5">
                  <Icon name="clock" size={12} />
                  {formatTimeRange(displayClass.startTime, displayClass.endTime)}
                </span>
                <span className="flex items-center gap-1.5">
                  <Icon name="calendar" size={12} />
                  {new Date(displayClass.startTime).toLocaleDateString(undefined, { weekday: 'long' })}
                </span>
              </div>
              <div className="text-[12px] text-[var(--color-cls-sub)]/90 mt-3">
                {scheduleState.cardMeta}
              </div>
            </div>
          ) : (
            <div className="bg-[var(--color-stat)] rounded-xl p-4 border border-[var(--color-border)]">
              <div className="text-[16px] font-semibold text-[var(--color-txt-0)]">No upcoming classes</div>
              <div className="text-[13px] text-[var(--color-txt-2)] mt-1">
                {classLoadError || 'You have no more imported class meetings coming up right now.'}
              </div>
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <Link to="/schedule" className="btn btn-secondary text-[12px] px-4 py-2 flex-1">
              <Icon name="calendar" size={14} />
              Full Schedule
            </Link>
            <Link to="/map" className="btn btn-secondary text-[12px] px-4 py-2 flex-1">
              <Icon name="navigation" size={14} />
              Get Directions
            </Link>
          </div>
        </div>
      ),
    },
    'free-time': {
      title: 'Free time',
      render: () => (
        <div className="card p-5 transition-all duration-700 opacity-100 translate-y-0">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
              Free Time
            </span>
            <span className="badge bg-[var(--color-gold)]/10 text-[var(--color-gold-muted)]">
              <Icon name="sparkles" size={10} />
              Live Suggestions
            </span>
          </div>

          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[42px] font-semibold text-[var(--color-txt-0)] leading-none tracking-tight">
              {formatDuration(scheduleState.freeMinutes)}
            </span>
          </div>
          <p className="text-[13px] text-[var(--color-txt-2)] mb-4">
            {scheduleState.freeLabel}
          </p>

          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)] overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-stat)]/50">
              <div>
                <div className="text-[10px] font-bold text-[var(--color-txt-3)] uppercase tracking-wider">
                  What you could do
                </div>
                <p className="text-[11px] text-[var(--color-txt-2)] mt-0.5 hidden sm:block">
                  Ideas from your schedule, dining, and today&apos;s events
                </p>
              </div>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('open-campus-assistant', {
                  detail: { message: 'What should I do right now? Consider my free time, dining hours, any upcoming events or classes, and give me a specific personalized suggestion.' }
                }))}
                className="inline-flex items-center justify-center gap-1.5 shrink-0 rounded-xl px-3.5 py-2 text-[12px] font-semibold bg-gradient-to-br from-[var(--color-gold)]/25 to-[var(--color-gold)]/10 text-[var(--color-gold-muted)] border border-[var(--color-gold)]/25 hover:from-[var(--color-gold)]/35 hover:border-[var(--color-gold)]/40 transition-all"
              >
                <Icon name="sparkles" size={14} />
                Ask AI
              </button>
            </div>
            <ul className="list-none m-0 divide-y divide-[var(--color-border)] p-2 sm:p-3 gap-0">
              {suggestions.map(({ icon, text, time, variant = 'default', sub }, idx) => {
                const iconWrap =
                  variant === 'dining-open'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/25'
                    : variant === 'dining-closed'
                      ? 'bg-[var(--color-bg-2)] text-[var(--color-txt-2)] ring-1 ring-[var(--color-border)]'
                      : variant === 'event'
                        ? 'bg-[var(--color-accent)]/12 text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/20'
                        : variant === 'free'
                          ? 'bg-[var(--color-gold)]/15 text-[var(--color-gold-muted)] ring-1 ring-[var(--color-gold)]/25'
                          : variant === 'class' || variant === 'nav'
                            ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/15'
                            : 'bg-[var(--color-stat)] text-[var(--color-txt-2)] ring-1 ring-[var(--color-border)]'
                const timeIsShort = String(time).length <= 14
                return (
                  <li key={idx} className="list-none">
                    <div className="flex gap-3 sm:gap-4 p-3 rounded-xl hover:bg-[var(--color-stat)]/80 transition-colors">
                      <div className={`w-11 h-11 shrink-0 rounded-xl flex items-center justify-center ${iconWrap}`}>
                        <Icon name={icon} size={18} />
                      </div>
                      <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4">
                        <div className="min-w-0">
                          {sub && (
                            <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-txt-3)] block mb-0.5">
                              {sub}
                            </span>
                          )}
                          <p className="text-[14px] font-medium text-[var(--color-txt-0)] leading-snug line-clamp-3">
                            {text}
                          </p>
                          {!timeIsShort && (
                            <p className="text-[12px] text-[var(--color-txt-2)] mt-1 sm:hidden leading-snug">
                              {time}
                            </p>
                          )}
                        </div>
                        <div
                          className={`shrink-0 sm:text-right ${timeIsShort ? 'sm:self-center' : 'sm:max-w-[min(100%,12rem)]'}`}
                        >
                          <span
                            className={`inline-block text-[11px] font-semibold tabular-nums px-2.5 py-1 rounded-lg whitespace-pre-wrap sm:whitespace-nowrap sm:text-right ${
                              variant === 'dining-open'
                                ? 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300'
                                : variant === 'dining-closed'
                                  ? 'bg-[var(--color-bg-2)] text-[var(--color-txt-2)]'
                                  : variant === 'event'
                                    ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]'
                                    : variant === 'free'
                                      ? 'bg-[var(--color-gold)]/12 text-[var(--color-gold-muted)]'
                                      : 'bg-[var(--color-stat)] text-[var(--color-txt-2)] border border-[var(--color-border)]'
                            }`}
                          >
                            {time}
                          </span>
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      ),
    },
    'todays-events': {
      title: "Today's events",
      render: () => (
        <div className="card p-5 transition-all duration-700 opacity-100 translate-y-0">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Today's Events</span>
            <Link to="/events" className="text-[12px] text-[var(--color-accent)] hover:underline">View all</Link>
          </div>
          {hasNoCalendarSources && (
            <div className="rounded-xl border border-[var(--color-gold)]/30 bg-[var(--color-gold)]/8 p-4 mb-4">
              <div className="text-[13px] font-medium text-[var(--color-txt-0)]">Connect your calendar</div>
              <p className="text-[12px] text-[var(--color-txt-2)] mt-1">
                Link Brightspace or another source in setup so today&apos;s campus events match your feed.
              </p>
              <Link to="/setup" className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-accent)] font-medium mt-2 hover:underline">
                <Icon name="calendar" size={14} />
                Go to setup
              </Link>
            </div>
          )}
          {calendarLoadError && !calendarLoading && (
            <p className="text-[12px] text-[var(--color-txt-2)] mb-3">{calendarLoadError}</p>
          )}
          <div className="space-y-3">
            {calendarLoading ? (
              <div className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] text-[13px] text-[var(--color-txt-2)]">
                Loading today&apos;s events…
              </div>
            ) : todayEventsPreview.length === 0 ? (
              !hasNoCalendarSources ? (
                <div className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] text-[13px] text-[var(--color-txt-2)]">
                  No more events scheduled for the rest of today.
                </div>
              ) : null
            ) : (
              todayEventsPreview.map((item) => {
                const cat = homeEventCategory[item.category] || homeEventCategory.event
                const loc = item.location ? item.location.split(' (')[0] : null
                return (
                  <div key={item.id} className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)]">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="text-[14px] font-medium text-[var(--color-txt-0)] leading-snug">{item.title}</div>
                      <span className={`badge shrink-0 ${cat.badge}`}>{cat.label}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--color-txt-2)]">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />
                        {formatDashboardEventTime(item.startTime, item.endTime)}
                      </span>
                      {loc && (
                        <span className="flex items-center gap-1.5 min-w-0">
                          <Icon name="mapPin" size={12} className="shrink-0" />
                          <span className="truncate">{loc}</span>
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
            {!calendarLoading && todayRelevantEvents.length > todayEventsPreview.length && (
              <p className="text-[11px] text-[var(--color-txt-3)] text-center pt-1">
                +{todayRelevantEvents.length - todayEventsPreview.length} more on the{' '}
                <Link to="/events" className="text-[var(--color-accent)] hover:underline">
                  events page
                </Link>
              </p>
            )}
          </div>
        </div>
      ),
    },
    'live-shuttles': {
      title: 'Live shuttles',
      render: () => (
        <div className="card p-5 transition-all duration-700 opacity-100 translate-y-0">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Live shuttles</span>
              <div className="flex items-center gap-2 mt-0.5">
                {transitUpdated && !transitLoading && (
                  <span className="text-[10px] text-[var(--color-txt-3)]">
                    Updated {transitUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                )}
                {userLocation && (
                  <span className="text-[10px] text-[var(--color-success)] flex items-center gap-1">
                    <span className="w-1 h-1 rounded-full bg-[var(--color-success)]" />
                    ETA to you
                  </span>
                )}
              </div>
            </div>
            <Link to="/transit" className="text-[12px] text-[var(--color-accent)] hover:underline shrink-0">Map & routes</Link>
          </div>
          <div className="space-y-3">
            {transitLoading && transitVehicles.length === 0 ? (
              <div className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] text-[13px] text-[var(--color-txt-2)]">
                Loading live bus positions…
              </div>
            ) : transitError && transitVehicles.length === 0 ? (
              <div className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)]">
                <p className="text-[13px] text-[var(--color-txt-2)]">{transitError}</p>
                <Link to="/transit" className="text-[12px] text-[var(--color-accent)] font-medium mt-2 inline-block hover:underline">
                  Open transit
                </Link>
              </div>
            ) : transitDashboardRows.length === 0 ? (
              <div className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] text-[13px] text-[var(--color-txt-2)]">
                No buses active right now. Check the transit map for routes and alerts.
              </div>
            ) : (
              transitDashboardRows.map(({ key, vehicle, route, near, speed, moving, eta }) => (
                <div
                  key={key}
                  className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)]"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0 mt-1.5"
                      style={{ backgroundColor: route.color }}
                      title={route.name}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[14px] font-medium text-[var(--color-txt-0)]">{route.name}</div>
                        <span className={`text-[11px] shrink-0 ${moving ? 'text-[var(--color-success)]' : 'text-[var(--color-txt-3)]'}`}>
                          {moving ? `${Math.round(speed)} mph` : 'stopped'}
                        </span>
                      </div>
                      <div className="text-[13px] text-[var(--color-txt-1)] mt-1 leading-snug">
                        {eta}
                      </div>
                      <div className="text-[11px] text-[var(--color-txt-3)] mt-1">
                        Bus {vehicle.Name}
                        {near && <> · near {near.description}</>}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
            {!transitLoading && transitVehicles.length > transitDashboardRows.length ? (
              <p className="text-[11px] text-[var(--color-txt-3)] text-center pt-1">
                +{transitVehicles.length - transitDashboardRows.length} more on{' '}
                <Link to="/transit" className="text-[var(--color-accent)] hover:underline">
                  transit
                </Link>
              </p>
            ) : null}
          </div>
        </div>
      ),
    },
    'dining': {
      title: 'Dining snapshot',
      render: () => (
        <div className="card p-5 transition-all duration-700 opacity-100 translate-y-0">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Dining Snapshot</span>
            <Link to="/dining" className="text-[12px] text-[var(--color-accent)] hover:underline">Open dining</Link>
          </div>

          {diningStatus && (
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2 h-2 rounded-full shrink-0 ${diningStatus.is_open ? 'bg-[var(--color-success)]' : 'bg-[var(--color-txt-3)]'}`} />
              <span className="text-[13px] font-medium text-[var(--color-txt-0)]">{diningStatus.name}</span>
              <span className="text-[12px] text-[var(--color-txt-2)]">
                · {diningStatus.is_open ? 'Open' : 'Closed'} · {diningStatus.hours}
              </span>
            </div>
          )}

          <div className="text-[12px] font-medium text-[var(--color-txt-1)] mb-2">
            {diningPreview ? "Today's menu" : 'Sample items'}
          </div>
          <div className="flex flex-wrap gap-2">
            {menuSnapshot.items.map((item) => (
              <span key={item} className="badge">{item}</span>
            ))}
          </div>
        </div>
      ),
    },
    'board': {
      title: 'Student board',
      render: () => (
        <div className="card p-0 overflow-hidden transition-all duration-700 opacity-100 translate-y-0 shadow-[var(--shadow-sm)]">
          <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-4 border-b border-[var(--color-border)] bg-gradient-to-r from-[var(--color-accent-bg)]/35 via-transparent to-[var(--color-gold)]/8">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-sm)] flex items-center justify-center shrink-0">
                <Icon name="messageCircle" size={20} className="text-[var(--color-accent)]" />
              </div>
              <div className="min-w-0">
                <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider block">Student Board</span>
                <p className="text-[12px] text-[var(--color-txt-2)] mt-0.5 truncate">Community Q&amp;A from campus</p>
              </div>
            </div>
            <Link
              to="/board"
              className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-light)] px-3 py-1.5 rounded-lg hover:bg-[var(--color-accent)]/10 transition-colors no-underline"
            >
              Open board
              <Icon name="arrowUpRight" size={14} />
            </Link>
          </div>

          <div className="p-5 pt-4">
            {boardError && !boardLoading && (
              <p className="text-[12px] text-[var(--color-error)] mb-3 px-1">{boardError}</p>
            )}
            <div className="space-y-2.5">
              {boardLoading ? (
                <div className="space-y-2.5">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="flex gap-3 p-3 rounded-xl bg-[var(--color-stat)] border border-[var(--color-border)] animate-pulse"
                    >
                      <div className="w-1 rounded-full bg-[var(--color-border-2)] shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3.5 bg-[var(--color-border-2)] rounded-md w-[85%]" />
                        <div className="h-3 bg-[var(--color-border-2)] rounded-md w-[40%]" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : boardPreview.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--color-border-2)] bg-[var(--color-stat)]/50 px-5 py-8 text-center">
                  <div className="w-12 h-12 mx-auto rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center mb-3 shadow-[var(--shadow-sm)]">
                    <Icon name="message" size={22} className="text-[var(--color-txt-3)]" />
                  </div>
                  <p className="text-[13px] text-[var(--color-txt-1)] font-medium">No threads yet</p>
                  <p className="text-[12px] text-[var(--color-txt-2)] mt-1 max-w-[220px] mx-auto">
                    Be the first to ask the campus a question.
                  </p>
                  <Link
                    to="/board"
                    className="inline-flex items-center gap-1.5 mt-4 text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    Start a thread
                    <Icon name="arrowUpRight" size={12} />
                  </Link>
                </div>
              ) : (
                boardPreview.map((post) => (
                  <Link
                    key={post.id}
                    to="/board"
                    className="group flex gap-3 p-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]/35 hover:bg-[var(--color-surface-hover)] hover:shadow-[var(--shadow-sm)] transition-all duration-200 no-underline text-inherit"
                  >
                    <div className="w-1 self-stretch min-h-[2.5rem] rounded-full bg-gradient-to-b from-[var(--color-gold-muted)] to-[var(--color-accent)] opacity-80 group-hover:opacity-100 transition-opacity shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-[14px] font-semibold text-[var(--color-txt-0)] leading-snug line-clamp-2 group-hover:text-[var(--color-accent)] transition-colors">
                          {post.title}
                        </h3>
                        {post.hot && (
                          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md bg-[var(--color-events-bg)] text-[var(--color-events-color)]">
                            Hot
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-txt-2)]">
                          <span className="w-5 h-5 rounded-full bg-[var(--color-accent-bg)] text-[var(--color-accent)] text-[9px] font-bold flex items-center justify-center">
                            {(post.user || '?').charAt(0).toUpperCase()}
                          </span>
                          {post.user}
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)] text-[11px] font-medium">
                          <Icon name="arrowUp" size={11} />
                          {post.upvotes}
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)] text-[11px] font-medium">
                          <Icon name="messageCircle" size={11} />
                          {Array.isArray(post.replies) ? post.replies.length : 0}
                        </span>
                      </div>
                    </div>
                    <Icon
                      name="arrowUpRight"
                      size={15}
                      className="text-[var(--color-txt-3)] shrink-0 opacity-0 group-hover:opacity-100 group-hover:text-[var(--color-accent)] transition-all mt-0.5"
                    />
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>
      ),
    },
    'tasks-due': {
      title: 'Tasks due',
      render: () => (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Tasks Due</span>
            <Link to="/assignments" className="text-[12px] text-[var(--color-accent)] hover:underline">View all</Link>
          </div>
          {calendarLoading ? (
            <div className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] text-[13px] text-[var(--color-txt-2)]">
              Loading your tasks…
            </div>
          ) : tasksDuePreview.length === 0 ? (
            <div className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] text-[13px] text-[var(--color-txt-2)]">
              Nothing due right now. Add assignments on the{' '}
              <Link to="/assignments" className="text-[var(--color-accent)] hover:underline">assignments page</Link>.
            </div>
          ) : (
            <div className="space-y-3">
              {tasksDuePreview.map((item) => (
                <Link
                  key={item.id}
                  to="/assignments"
                  className="block rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] hover:border-[var(--color-accent)]/35 transition-colors no-underline"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[14px] font-medium text-[var(--color-txt-0)] leading-snug">{item.title}</div>
                    <Icon name="arrowUpRight" size={14} className="text-[var(--color-txt-3)] shrink-0" />
                  </div>
                  <div className="text-[12px] text-[var(--color-txt-2)] mt-1.5 flex items-center gap-1.5">
                    <Icon name="clock" size={12} className="shrink-0" />
                    {formatDashboardEventTime(item.startTime, item.endTime)}
                    {' · '}
                    {new Date(item.startTime).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      ),
    },
    'calendar-feed': {
      title: 'Calendar feed',
      render: () => (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-2">
            <Icon name="calendar" size={14} className="text-[var(--color-txt-3)]" />
            <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Calendar Feed</span>
          </div>
          <p className="text-[13px] text-[var(--color-txt-2)] mb-3">
            Subscribe to your BoilerIndy schedule and events in Google Calendar, Apple Calendar, or Outlook.
          </p>
          <Link to="/settings" className="btn btn-secondary text-[12px] px-4 py-2 w-fit">
            <Icon name="external" size={14} />
            Manage feed
          </Link>
        </div>
      ),
    },
    'sponsored': {
      title: 'Sponsored',
      // Self-contained: fetches its own active ad and logs impression/tap.
      // Renders nothing when no ad is active, so the slot collapses cleanly.
      render: () => <SponsoredWidget />,
    },
  }

  const visibleWidgets = layout.filter((w) => w.visible && widgetRegistry[w.id])
  const hiddenWidgets = layout
    .filter((w) => !w.visible && widgetRegistry[w.id])
    .map((w) => ({ id: w.id, title: widgetRegistry[w.id].title }))

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24">
      <div className="mb-6 sm:mb-8 transition-all duration-700 opacity-100 translate-y-0">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl md:text-3xl font-semibold text-[var(--color-txt-0)]">
              {getGreeting(now)}, {firstName}
            </h1>
            <p className="text-[13px] sm:text-[14px] text-[var(--color-txt-2)] mt-1 sm:mt-2">
              Here's what's happening on campus today.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[12px] sm:text-[13px] text-[var(--color-txt-2)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl px-3 sm:px-4 py-2 sm:py-2.5 shadow-sm self-start sm:self-auto">
            <Icon name="calendar" size={14} className="text-[var(--color-txt-3)]" />
            {getCurrentDate(now)}
          </div>
        </div>
      </div>

      {showSetupBanner && (
        <div className="card p-5 mb-6 border-[var(--color-gold)]/30 bg-[var(--color-gold)]/8 transition-all duration-700 delay-75 opacity-100 translate-y-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-1">
                Finish Setup
              </div>
              <div className="text-[16px] font-semibold text-[var(--color-txt-0)]">
                {needsPurdueConnection
                  ? 'Link your Purdue account next'
                  : purdueLinkingOff
                    ? 'Connect your class schedule'
                    : 'Your Purdue schedule is not connected yet'}
              </div>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1 max-w-[640px]">
                {needsPurdueConnection
                  ? 'Your BoilerIndy account is active. Link your Purdue identity from setup before connecting Purdue-specific sources.'
                  : purdueLinkingOff
                    ? 'Import your class schedule and assignments by attaching your Brightspace or Purdue Timetabling iCalendar export.'
                    : 'Your Purdue identity is linked, but classes only appear after you attach the Purdue Timetabling iCalendar export.'}
              </p>
            </div>
            <Link to="/setup" className="btn btn-primary text-[13px] px-5 py-2.5 w-fit">
              <Icon name={needsPurdueConnection ? 'graduation' : 'calendar'} size={15} />
              {needsPurdueConnection ? 'Link Purdue' : 'Connect schedule'}
            </Link>
          </div>
        </div>
      )}

      {/* Customize toolbar — fixed chrome that toggles widget edit mode. */}
      <div className="flex items-center justify-between gap-3 mb-5 sm:mb-6">
        <p className="text-[12px] text-[var(--color-txt-3)] min-h-[1rem]">
          {editing
            ? 'Drag a card or use the arrows to reorder. Hide with ×; add hidden widgets below.'
            : ''}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {editing && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Reset your dashboard to the default layout?')) reset()
              }}
              className="btn btn-secondary text-[12px] px-4 py-2"
            >
              <Icon name="refresh" size={14} />
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            aria-pressed={editing}
            className={`btn text-[12px] px-4 py-2 ${editing ? 'btn-primary' : 'btn-secondary'}`}
          >
            <Icon name={editing ? 'check' : 'settings'} size={14} />
            {editing ? 'Done' : 'Customize'}
          </button>
        </div>
      </div>

      <div
        className={
          editing
            ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4'
            : // View mode: 1px row tracks + dense flow turn the grid into a
              // masonry layout so short widgets don't leave vertical holes.
              // Column spans still apply; row spans are set per-widget.
              'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-3 sm:gap-x-4 items-start [grid-auto-rows:1px] [grid-auto-flow:row_dense]'
        }
      >
        {visibleWidgets.map((w, idx) => {
          const def = widgetRegistry[w.id]
          const content = def.render(w.size)
          // Outside edit mode, a widget with nothing to show takes no space.
          if (!editing && !content) return null
          return (
            <DashboardWidget
              key={w.id}
              id={w.id}
              title={def.title}
              editing={editing}
              size={w.size}
              canMoveUp={idx > 0}
              canMoveDown={idx < visibleWidgets.length - 1}
              onMove={move}
              onResize={setSize}
              onHide={(id) => setVisible(id, false)}
              onDropReorder={reorder}
              reducedMotion={reducedMotion}
            >
              {content || (
                <div className="card p-5 text-[13px] text-[var(--color-txt-2)]">
                  Nothing to show right now — this widget appears when it has something for you.
                </div>
              )}
            </DashboardWidget>
          )
        })}
      </div>

      {editing && (
        <AddWidgetPicker hiddenWidgets={hiddenWidgets} onAdd={(id) => setVisible(id, true)} />
      )}
    </div>
  )
}
