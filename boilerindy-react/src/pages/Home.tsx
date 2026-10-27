import { Link } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { authRequest, shouldSkipSetup } from '../lib/authApi'
import AiMarkdown from '../components/AiMarkdown'
import Icon from '../components/Icons'
import SourceErrorNotice from '../components/SourceErrorNotice'
import FeaturedDeal from '../components/FeaturedDeal'
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
import {
  applyScheduleOverridesToItems,
  manualClassesForDays,
  useScheduleOverrides,
} from '../lib/scheduleOverrideStore'
import { useDashboardLayout } from '../hooks/useDashboardLayout'
import { useEntrance } from '../hooks/useEntrance'
import { allowedSizesFor } from '../lib/dashboardLayoutStore'
import { useGradeTracker } from '../hooks/useGradeTracker'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import DashboardWidget from '../components/dashboard/DashboardWidget'
import AddWidgetPicker from '../components/dashboard/AddWidgetPicker'
import SponsoredWidget from '../components/dashboard/SponsoredWidget'
import CampusNewsWidget from '../components/dashboard/CampusNewsWidget'
import ConfirmDialog from '../components/ConfirmDialog'
import FlapDigit from '../components/FlapDigit'
import { useUserLocation } from '../hooks/useUserLocation'
import { mapHrefForRoom } from '../lib/buildingCode'
import { localIsoDate, startOfWeek } from '../lib/localDate'
import { splitCourseCode } from '../lib/courseCode'
import { dueSoonHours, dueSoonLabel } from '../lib/urgency'
import { aiCacheKey, readAiCache, writeAiCache } from '../lib/aiInsightCache'
import { errorMessage, useDining, useDiningUpcoming, useTransitRoutes, useTransitStops, useTransitVehicles } from '../lib/queries/publicData'
import { favoritesComingUp, locationMenus, openState, splitStations, todaysMealHeading } from '../lib/dining'
import { favoritesOnTodaysMenu, normalizeItemName } from '../lib/diningFavorites'
import { defaultMeal } from '../../../src/diningMeals.mjs'
import { useMyCalendar, useMyClasses, useMyDiningFavorites, useTaskMeta, type TaskMeta } from '../lib/queries/userData'
import { taskMetaFromLocalStore } from '../lib/taskLocalStore'
import PageTitle from '../components/PageTitle'

// Each quick action wears its own transit line (route class) on its badge.
const quickActionTemplates = [
  { path: '/map', label: 'Campus Map', sub: 'Find any building', icon: 'mapPin', route: 'r-map' },
  { path: '/dining', label: 'Dining', sub: 'See what\'s open', icon: 'dining', route: 'r-din' },
  { path: '/transit', label: 'Transit', sub: 'Live bus times', icon: 'bus', route: 'r-bus' },
  { path: '/events', label: 'Events', sub: '', icon: 'calendar', route: 'r-evt' },
]

// Quick actions widget width -> internal grid columns. At quarter width the
// actions stack into a single vertical column; wider widths fan them out. Full
// class strings keep Tailwind's scanner happy (it can't read computed names).
const QUICK_ACTIONS_GRID_CLASS: Record<string, string> = {
  quarter: 'grid-cols-1',
  half: 'grid-cols-2',
  'three-quarter': 'grid-cols-2 lg:grid-cols-3',
  full: 'grid-cols-2 lg:grid-cols-4',
}
function quickActionsGridClass(size: string) {
  return QUICK_ACTIONS_GRID_CLASS[size] || QUICK_ACTIONS_GRID_CLASS.full
}

/** Broader fetch for Home: dues + events (today's event strip still filters to event-like categories). */
const HOME_CALENDAR_CATEGORIES =
  'campus_event,event,deadline,activity,assignment,task,homework,submission,quiz,project,exam,lab,midterm,paper,presentation'

/** User message for /api/assistant - server already attaches schedule & calendar context. */
const WEEK_AHEAD_PROMPT = `Write a concise "Week Ahead" summary for my dashboard using ONLY the class schedule, assignments, deadlines, and events in your context. Do not invent courses, due dates, or events.

Requirements:
- One short opening sentence on the shape of the week, then three "-" bullets.
- Bullet 1: my class rhythm - each course and which days it meets, course codes in bold.
- Bullet 2: assignments, exams or deadlines due this calendar week with the due day in bold, or clearly say nothing major is due. Skip anything marked DONE.
- Bullet 3: notable campus or career events this week, or say none are scheduled.
- No headings, no emoji. Stay under 150 words. Write in second person ("you"). Be warm and skimmable.`

// Shown when the assistant fails without saying why (no response, or a body
// with no message). The chat panel says the same.
const ASSISTANT_UNREACHABLE = "Couldn't reach the assistant right now. Try again in a moment."

type AssistantAnswer = { reply: string } | { error: string }

// The digest from an /api/assistant response, or the message to show instead.
// The card used to read only `reply`, so the hourly limit's 429 and the 502
// when Groq fails left it with no summary and nothing said. A 200 marked busy
// or offline carries a status line, not a digest, so it is shown as the
// message and never cached as the week's briefing.
async function readAssistantAnswer(res: Response): Promise<AssistantAnswer> {
  const data = (await res.json().catch(() => null)) as { reply?: unknown; source?: unknown; error?: unknown } | null
  const reply = typeof data?.reply === 'string' ? data.reply : ''
  if (res.ok && reply && data?.source !== 'busy' && data?.source !== 'offline') return { reply }
  // The limiter sends `error` as a string; the app's error handler sends { message }.
  const error = data?.error as string | { message?: unknown } | null | undefined
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
  return { error: message || reply || ASSISTANT_UNREACHABLE }
}

// Category labels for today's events. The card carries the Events line, so the
// labels themselves stay neutral badges.
const homeEventCategory: Record<string, { label: string }> = {
  campus_event: { label: 'Campus Event' },
  event: { label: 'Event' },
  deadline: { label: 'Deadline' },
}

function isSameLocalDay(isoOrDate: string | Date, now: Date) {
  return new Date(isoOrDate).toDateString() === now.toDateString()
}

/** Event still has time left today (not fully ended). All-day (midnight start) stays for the whole local day. */
function isStillRelevantToday(item: any, now: Date) {
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

/**
 * Events not over yet, for the free-time suggestion, which takes the first;
 * the feed lists past events too, in no particular order. "Not over" is the
 * Today's events rule (isStillRelevantToday), so an all-day event with no end
 * time stays for its whole day. Events from today on come soonest first, and
 * one still running from an earlier day (a week-long event) only after them:
 * a social on right now beats tomorrow's event, tonight's beats a week-long one.
 */
function upcomingEventsFrom<T extends { startTime?: string | null }>(items: T[], now: Date): T[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startMs = (item: T) => new Date(item.startTime ?? '').getTime()
  const fromEarlierDay = (item: T) => (startMs(item) < startOfToday ? 1 : 0)
  return (items || [])
    .filter((item) => item?.startTime && isStillRelevantToday(item, now))
    .sort((a, b) => fromEarlierDay(a) - fromEarlierDay(b) || startMs(a) - startMs(b))
}

function filterTodayRelevantEvents(items: any[], now: Date) {
  return (items || [])
    .filter(
      (item) =>
        item?.startTime &&
        isSameLocalDay(item.startTime, now) &&
        isStillRelevantToday(item, now),
    )
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
}

/**
 * A deadline's time for the Tasks due rows: one clock time, never an event's
 * "start - end" range (a feed deadline ends when it starts, which read as
 * "11:59 PM - 11:59 PM"). D2L's 23:59 stamp reads as the end of the day and a
 * midnight or all-day item as all day, as on Assignments.
 */
function formatDueTime(item: { startTime: string; allDay?: boolean }) {
  const due = new Date(item.startTime)
  if (item.allDay || (due.getHours() === 0 && due.getMinutes() === 0)) return 'All day'
  if (due.getHours() === 23 && due.getMinutes() === 59) return 'Due by end of day'
  return shortTime(due)
}

function formatDashboardEventTime(startTime: string, endTime?: string | null) {
  const start = new Date(startTime)
  if (start.getHours() === 0 && start.getMinutes() === 0) return 'All day'
  const startLabel = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (!endTime) return startLabel
  const end = new Date(endTime)
  const endLabel = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${startLabel} - ${endLabel}`
}

const fallbackMenuPreview = {
  entrees: ['Grilled Chicken', 'Pasta Marinara', 'Black Bean Burger', 'Mac & Cheese'],
  sides: ['Caesar Salad', 'Roasted Veggies', 'Garlic Bread'],
}

function getGreeting(now: Date) {
  const hour = now.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function getCurrentDate(now: Date) {
  return now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatTimeRange(startTime: string, endTime?: string | null) {
  const start = new Date(startTime)
  const end = endTime ? new Date(endTime) : null
  const startLabel = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const endLabel = end ? end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  return endLabel ? `${startLabel} - ${endLabel}` : startLabel
}

function formatDuration(minutes: number) {
  if (minutes <= 0) return '0m'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (!hours) return `${mins}m`
  if (!mins) return `${hours}h`
  return `${hours}h ${mins}m`
}

function getMinutesBetween(later: Date, earlier: Date) {
  return Math.max(0, Math.round((later.getTime() - earlier.getTime()) / 60000))
}

const EVENT_CATEGORIES = ['campus_event', 'event', 'activity']
const NOT_TASK_CATEGORIES = ['campus_event', 'event', 'activity', 'class']
const EXAM_CATEGORIES = ['exam', 'quiz', 'midterm']

/**
 * "CS 25100 Data Structures" -> code plate "CS 25100" + name "Data Structures",
 * by the shared rule in lib/courseCode. A title that is only a code stays whole
 * as the name, so the board and the rows always have a name to show.
 */
function courseParts(title: string): { code: string | null; name: string } {
  const split = splitCourseCode(title)
  return split?.rest ? { code: split.code, name: split.rest } : { code: null, name: String(title || '').trim() }
}

function shortTime(d: Date) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function shortWeekdayCaps(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()
}

/** Split-flap digits for the departures board: 9:30 AM -> [9] : [3][0] AM. */
function flapParts(d: Date) {
  const h = d.getHours()
  const hour12 = h % 12 || 12
  return {
    hour: String(hour12).split(''),
    minute: String(d.getMinutes()).padStart(2, '0').split(''),
    meridiem: h < 12 ? 'AM' : 'PM',
    day: shortWeekdayCaps(d),
  }
}

/** "9:00 PM" -> minutes after midnight, or null. */
function parseClockMinutes(text: string) {
  const m = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i)
  if (!m) return null
  let hour = Number(m[1]) % 12
  if (m[3].toUpperCase() === 'P') hour += 12
  return hour * 60 + Number(m[2])
}

/** "7:00 AM - 10:00 AM, 11:00 AM - 9:00 PM" -> [[420, 600], [660, 1260]]. */
function parseHourRanges(hours: string | null | undefined) {
  const ranges: Array<[number, number]> = []
  const re = /(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(String(hours || ''))) !== null) {
    const open = parseClockMinutes(m[1])
    let close = parseClockMinutes(m[2])
    if (open == null || close == null) continue
    if (close <= open) close = 24 * 60
    ranges.push([open, close])
  }
  return ranges
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`

function deriveScheduleState(items: any[], now: Date) {
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
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())

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
function findStopIndex(routeStops: any[], lat: number, lon: number) {
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
function describeBusEta(
  vehicle: any,
  route: any,
  nearestBusStop: any,
  routeStops: any[],
  speed: number,
  moving: boolean,
  userLoc: { lat: number; lon: number } | null,
) {
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
      return `At your stop - ${userStopName}`
    }
    const etaMin = stopsAway * AVG_STOP_MINUTES
    const stopWord = stopsAway === 1 ? 'stop' : 'stops'
    return `${stopsAway} ${stopWord} from you (${userStopName}), ~${etaMin} min`
  }

  // Fallback: no user location - describe bus position generically
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
function formatSuggestionEventTiming(item: any, now: Date) {
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
  // Still running from an earlier day (a week-long event): its start date read
  // like an event in the past. An end at local midnight closes the day before.
  if (end && start < now && end > now) {
    const endsAtMidnight = end.getHours() === 0 && end.getMinutes() === 0
    const lastDay = endsAtMidnight ? new Date(end.getTime() - 1) : end
    if (isSameLocalDay(lastDay, now)) {
      return endsAtMidnight ? 'On now · ends today' : `On now · until ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    }
    return `On now · until ${lastDay.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
  }
  const dayPart = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const timePart = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${dayPart} · ${timePart}`
}

function buildSuggestions({
  freeMinutes,
  nextClass,
  currentClass,
  diningStatus,
  upcomingEvents,
  now,
}: {
  freeMinutes: number
  nextClass: any
  currentClass: any
  diningStatus: any
  upcomingEvents: any[]
  now: Date
}) {
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const list: Array<{ icon: string; text: string; time: string; variant: string; sub?: string }> = []

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

  // Tight gap - need to head to next class
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

  // Good window - dining open? A status that is not known (is_open null: a
  // menu is posted on a day the feed lists no hours for, issue #465) is never
  // called closed.
  const diningState = diningStatus ? openState(diningStatus) : null
  if (diningState === 'open' && freeMinutes >= 25) {
    const hrs = diningStatus.hours && diningStatus.hours !== 'Closed today' ? diningStatus.hours : 'Open now'
    list.push({
      icon: 'dining',
      text: `${diningStatus.name} is open`,
      time: hrs,
      variant: 'dining-open',
    })
  } else if (diningState === 'unknown' && freeMinutes >= 25) {
    list.push({
      icon: 'dining',
      text: `${diningStatus.name} has a menu posted`,
      time: 'Hours not listed',
      variant: 'dining-unknown',
    })
  } else if (diningState === 'closed') {
    const hoursLine = diningStatus.hours && diningStatus.hours !== 'Closed' ? diningStatus.hours : null
    list.push({
      icon: 'dining',
      text: `${diningStatus.name} is closed right now`,
      time: 'Closed',
      variant: 'dining-closed',
      sub: hoursLine || undefined,
    })
  }

  // The next event that is not over yet (upcomingEventsFrom).
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

  // Generic campus ideas, only worth showing when the student actually has a
  // window to fill. Padding these in unconditionally is what made the widget
  // look like it was making things up on a fully booked day.
  if (freeMinutes >= 30) {
    const fillers = [
      { icon: 'coffee', text: 'Grab coffee at the Union', time: '5 min walk', variant: 'default' },
      { icon: 'book', text: 'Study at Cavanaugh Hall', time: 'Quiet floor', variant: 'default' },
      { icon: 'mapPin', text: 'Explore the Campus Center', time: 'Nearby', variant: 'default' },
    ]
    let i = 0
    while (list.length < 3 && i < fillers.length) list.push(fillers[i++])
  }

  return list.slice(0, 3)
}

export default function Home() {
  const { getFirstName, onboarding, user, authConfig } = useAuth()
  const firstName = getFirstName()
  const reducedMotion = usePrefersReducedMotion()
  const userId = user?.id as string | undefined
  const overrides = useScheduleOverrides(userId)
  const { layout, editing, setEditing, move, moveToTop, reorder, setVisible, setSize, reset, saveError } = useDashboardLayout(userId)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const { summary: gpaSummary, loadFailed: gradesLoadFailed } = useGradeTracker(userId)
  const [now, setNow] = useState(() => new Date())
  // Classes and the calendar window through the per-user query cache (issue
  // #327): keyed by the user, shared with Schedule, Assignments and Events, and
  // never written to storage. A failed refetch keeps the last answer on screen.
  const classesQuery = useMyClasses<any>({ limit: 200, mode: 'display' })
  const calendarQuery = useMyCalendar<any>({ categories: HOME_CALENDAR_CATEGORIES, limit: 200 })
  const classes = useMemo<any[]>(() => classesQuery.data?.items ?? [], [classesQuery.data])
  const calendarItems = useMemo<any[]>(() => calendarQuery.data?.items ?? [], [calendarQuery.data])
  const calendarLoading = classesQuery.isPending || calendarQuery.isPending
  const classLoadError = classesQuery.isError ? errorMessage(classesQuery.error, 'Could not load classes.') : ''
  const calendarLoadError = calendarQuery.isError ? errorMessage(calendarQuery.error, 'Could not load events.') : ''
  // Nothing cached and the read failed: Tasks due says so instead of "Nothing
  // due right now", which told a student with a quiz due tomorrow they were clear.
  const calendarFailed = calendarQuery.isError && !calendarQuery.data
  // The task list Assignments keeps: calendar items the student ticked off and
  // the tasks they added by hand. Home read the calendar alone, so a finished
  // quiz kept its Heads up and urgent badge, and a task added on Assignments
  // never showed here. With no task tables on the server, Assignments keeps
  // them in this browser, and so does this.
  const taskMetaQuery = useTaskMeta()
  const taskMeta = useMemo<TaskMeta | undefined>(() => {
    const data = taskMetaQuery.data
    return data?.unavailable && userId ? (taskMetaFromLocalStore(userId) as TaskMeta) : data
  }, [taskMetaQuery.data, userId])
  const tasksLoading = calendarLoading || taskMetaQuery.isPending

  // Live transit through the shared query cache (issue #251): Home and Transit
  // read the same entries, the vehicle poll pauses while the tab is hidden,
  // and the last snapshot paints from storage before the network answers.
  const stopsQuery = useTransitStops()
  const routesQuery = useTransitRoutes()
  const vehiclesQuery = useTransitVehicles()
  const transitVehicles = useMemo<any[]>(
    () => (Array.isArray(vehiclesQuery.data) ? vehiclesQuery.data : []),
    [vehiclesQuery.data],
  )
  const transitStops = useMemo<any[]>(() => (Array.isArray(stopsQuery.data) ? stopsQuery.data : []), [stopsQuery.data])
  const transitRouteMap = useMemo<Record<number, number>>(
    () => (Array.isArray(routesQuery.data) ? buildTranslocRouteIdMap(routesQuery.data) : { ...TRANLOC_ROUTE_ALIASES }),
    [routesQuery.data],
  )
  const transitLoading = vehiclesQuery.isPending || stopsQuery.isPending || routesQuery.isPending
  // A failed refetch keeps the last vehicles on screen; the widget only shows
  // the message when it has nothing else to show.
  const transitError = vehiclesQuery.isError ? errorMessage(vehiclesQuery.error, 'Could not load live buses.') : ''
  const transitUpdated = useMemo(
    () => (vehiclesQuery.dataUpdatedAt ? new Date(vehiclesQuery.dataUpdatedAt) : null),
    [vehiclesQuery.dataUpdatedAt],
  )
  // Cached, prompt-frugal location: paints the last known position instantly and
  // asks for permission at most once (see useUserLocation) instead of nagging on
  // every login. { lat, lon }
  const userLocation = useUserLocation({ autoPrompt: true })

  // Dining snapshot from the shared entry the Dining page uses too (#251).
  const diningQuery = useDining()
  const { diningStatus, diningPreview } = useMemo(() => {
    const none = { diningStatus: null as any, diningPreview: null as { items: string[]; heading: string } | null }
    const data = diningQuery.data as any
    if (!data?.ok || !Array.isArray(data.locations)) return none
    const tower = data.locations.find((l: any) => l.slug === 'tower-dining') || data.locations[0]
    if (!tower) return none
    // The snapshot names the Indianapolis calendar day it was built for; the
    // browser's own weekday is only a fallback (a student can be on another date).
    const todayName = (typeof data.weekday === 'string' && data.weekday) || new Date().toLocaleDateString('en-US', { weekday: 'long' })
    const todayHrs = tower.weekly_hours?.[todayName]
    const status = {
      name: tower.name,
      is_open: tower.is_open,
      hours: todayHrs || tower.hours,
      weekly_hours: tower.weekly_hours || null,
    }
    // The meal being served now (issue #466), the dishes that change today
    // first; a snapshot from before per-meal menus previews its merged list.
    const menus = locationMenus(tower)
    const meal = defaultMeal(menus.map((m) => m.meal))
    const { specials, everyday } = splitStations(menus.find((m) => m.meal === meal)?.stations ?? [])
    const names = [...specials, ...everyday].flatMap((s) => s.items || []).map((i) => i.name).filter(Boolean)
    return {
      diningStatus: status as any,
      diningPreview: names.length > 0 ? { items: names.slice(0, 8), heading: todaysMealHeading(meal) } : null,
    }
  }, [diningQuery.data])

  const [boardPreview, setBoardPreview] = useState<any[]>([])
  const [boardLoading, setBoardLoading] = useState(true)
  const [boardError, setBoardError] = useState('')

  // Keyed by user (issue #219) and the local week's Monday; lib/localDate
  // explains why not toISOString(). Null until the user id is known, which
  // skips the cache and lets the mount effect fetch.
  function getWeekDigestStorageKey() {
    return userId ? aiCacheKey('week-ahead', userId, localIsoDate(startOfWeek())) : null
  }

  function readCachedWeekDigest(): string | null {
    const cached = readAiCache(getWeekDigestStorageKey())
    return cached?.text.trim() ? cached.text : null
  }

  // With no linked source and no class added by hand there is nothing to
  // summarize, and the model used to invent a week of classes to fill the gap
  // (issue #371), so the card asks the student to connect a schedule instead.
  const hasScheduleData = (onboarding?.linkedSourceCount ?? 0) > 0 || overrides.manual.length > 0

  const [weekAheadText, setWeekAheadText] = useState(readCachedWeekDigest)
  const [weekAheadError, setWeekAheadError] = useState('')
  // Start loading when there is no cached digest: the mount effect will fetch
  // one. Deriving the initial value here means the effect never has to flip the
  // flag synchronously (which trips react-hooks/set-state-in-effect).
  const [weekAheadLoading, setWeekAheadLoading] = useState(() => hasScheduleData && !readCachedWeekDigest())
  // A digest that lands after sign-out has unmounted the page must not write the
  // cache back once sign-out has cleared it (issue #219).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Fetches and stores the digest. Does NOT raise the loading flag on entry -
  // the mount path starts with it already true, and the Refresh button raises it
  // via generateWeekAheadSummary. The only setState calls here run inside async
  // promise callbacks, so this is safe to call directly from an effect.
  const fetchWeekAheadSummary = () => {
    fetch('/api/assistant', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: WEEK_AHEAD_PROMPT }],
      }),
    })
      .then(readAssistantAnswer)
      .then((answer) => {
        if (!mountedRef.current) return
        if ('error' in answer) {
          setWeekAheadError(answer.error)
          return
        }
        setWeekAheadText(answer.reply)
        setWeekAheadError('')
        writeAiCache(getWeekDigestStorageKey(), answer.reply)
      })
      .catch(() => {
        if (mountedRef.current) setWeekAheadError(ASSISTANT_UNREACHABLE)
      })
      .finally(() => setWeekAheadLoading(false))
  }

  const generateWeekAheadSummary = () => {
    setWeekAheadLoading(true)
    setWeekAheadError('')
    fetchWeekAheadSummary()
  }

  useEffect(() => {
    if (hasScheduleData && !weekAheadText) fetchWeekAheadSummary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setBoardLoading(true)
      try {
        const data = (await authRequest('/api/board/posts?sort=recent')) as { posts?: any[] }
        if (cancelled) return
        setBoardPreview((data.posts || []).slice(0, 3))
        setBoardError('')
      } catch (e) {
        if (!cancelled) {
          setBoardPreview([])
          setBoardError(e instanceof Error ? e.message : 'Could not load board.')
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

  const cleanCalendarItems = useMemo(
    () => calendarItems.filter((i) => i && !isOnlineMeetingNoise(i)),
    [calendarItems],
  )
  // Deadlines still open, for Tasks due, Heads up, the week strip and the
  // free-time line: calendar items that are not classes or events and not
  // ticked off, plus the student's own dated tasks that are not done.
  const openTasks = useMemo(() => {
    const done = new Set((taskMeta?.completions ?? []).map((c) => c.calendar_item_id))
    const fromCalendar = cleanCalendarItems.filter(
      (item) => item?.startTime && !NOT_TASK_CATEGORIES.includes(item.category) && !done.has(item.id),
    )
    const own = (taskMeta?.manualTasks ?? []).filter((task) => task.startTime && !task.completedAt)
    return [...fromCalendar, ...own]
  }, [cleanCalendarItems, taskMeta])
  const homeClasses = useMemo(() => {
    // Deletes/edits made on Schedule apply to today's class strip and the
    // free-time math; the hook also refreshes these after the server pull.
    // Classes added by hand count on each of the seven days the week strip
    // shows, as feed classes do. Expanding them for today alone left the
    // strip empty after today and the next-class board skipping them.
    const filtered = applyScheduleOverridesToItems(getHomeClassItems(classes), overrides)
    return [...filtered, ...manualClassesForDays(overrides.manual, now, 7)]
  }, [classes, overrides, now])
  const scheduleState = useMemo(() => deriveScheduleState(homeClasses, now), [homeClasses, now])
  const suggestions = useMemo(() => buildSuggestions({
    freeMinutes: scheduleState.freeMinutes,
    nextClass: scheduleState.nextClass,
    currentClass: scheduleState.currentClass,
    diningStatus,
    upcomingEvents: upcomingEventsFrom(
      cleanCalendarItems.filter((i) => ['campus_event', 'event', 'activity'].includes(i.category)),
      now,
    ),
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
      if (reportedRoute && canon != null && !isRouteActiveNow(reportedRoute)) {
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

      const routeStops = getOrderedStopsForRoute(transitStops, canon ?? -1, transitRouteMap)
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

  // A favorite dish on today's or tomorrow's menu (issue #469): the starred
  // names against today's snapshot, then tomorrow in the look-ahead.
  const diningFavoritesQuery = useMyDiningFavorites()
  const upcomingQuery = useDiningUpcoming()
  const favoriteDishAlert = useMemo(() => {
    const favorites = new Set((diningFavoritesQuery.data ?? []).map(normalizeItemName).filter(Boolean))
    if (!favorites.size) return null
    const say = (names: string[], where: string, when: string) =>
      names.length === 1
        ? `${names[0]} is on the menu at ${where} ${when}`
        : `${names[0]} and ${names.length - 1} more favorite${names.length > 2 ? 's' : ''} are on the menu at ${where} ${when}`
    const snapshot = diningQuery.data as { ok?: boolean; locations?: Parameters<typeof favoritesOnTodaysMenu>[1] } | undefined
    const today = favoritesOnTodaysMenu(favorites, snapshot?.ok ? snapshot.locations : [])
    if (today.length) return say(today.map((f) => f.name), today[0].locations[0] || 'Tower Dining', 'today')
    const upcoming = upcomingQuery.data
    if (!upcoming?.today) return null
    const [y, m, d] = upcoming.today.split('-').map(Number)
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
    const soon = favoritesComingUp(favorites, upcoming, upcoming.today, normalizeItemName).filter((e) => e.date === tomorrow)
    return soon.length ? say(soon.map((e) => e.name), soon[0].location, 'tomorrow') : null
  }, [diningFavoritesQuery.data, diningQuery.data, upcomingQuery.data])

  const smartAlerts = useMemo(() => {
    // Each alert wears the line it belongs to. The sentence stays one text node.
    const alerts: Array<{ icon: string; route: string; text: string }> = []
    const nowMs = now.getTime()

    // Assignment due within 24 hours and not done yet. The hours come from
    // lib/urgency, as on the task rows, so both say the same number.
    const urgentItems = openTasks
      .map((item) => ({ item, hoursLeft: dueSoonHours(item.startTime, { now: nowMs }) }))
      .filter((entry): entry is { item: (typeof openTasks)[number]; hoursLeft: number } => entry.hoursLeft !== null)
    for (const { item, hoursLeft } of urgentItems.slice(0, 2)) {
      alerts.push({
        icon: 'document',
        route: 'r-tsk',
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
          route: 'r-cls',
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
        if (!isNaN(closeTime.getTime())) {
          const minsUntilClose = Math.round((closeTime.getTime() - nowMs) / 60000)
          if (minsUntilClose > 0 && minsUntilClose <= 45) {
            alerts.push({
              icon: 'dining',
              route: 'r-din',
              text: `${diningStatus.name} closes in ${minsUntilClose} min`,
            })
          }
        }
      }
    }

    if (favoriteDishAlert) alerts.push({ icon: 'star', route: 'r-din', text: favoriteDishAlert })

    // No buses running
    if (!transitLoading && transitVehicles.length === 0 && !transitError) {
      alerts.push({
        icon: 'bus',
        route: 'r-bus',
        text: 'No campus shuttles are running right now',
      })
    }

    return alerts.slice(0, 4)
  }, [now, openTasks, scheduleState, diningStatus, favoriteDishAlert, transitLoading, transitVehicles, transitError])

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

  const tasksDuePreview = openTasks
    .filter((item) => new Date(item.startTime).getTime() >= now.getTime())
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .slice(0, 5)

  // The week ahead as seven days from today: what lands on each, as short
  // neutral tags (the full detail goes in each day's aria-label).
  const weekDays = useMemo(() => {
    const first = new Date(now)
    first.setHours(0, 0, 0, 0)
    const meetings = homeClasses.filter((c) => c?.startTime && !shouldExcludeFromSchedule(c))
    return Array.from({ length: 7 }, (_, i) => {
      const day = new Date(first)
      day.setDate(first.getDate() + i)
      const nextDay = new Date(day)
      nextDay.setDate(day.getDate() + 1)
      const inDay = (iso: string | undefined) => {
        if (!iso) return false
        const t = new Date(iso).getTime()
        return t >= day.getTime() && t < nextDay.getTime()
      }
      const classCount = meetings.filter((c) => inDay(c.startTime)).length
      const dated = cleanCalendarItems.filter((item) => item?.startTime && inDay(item.startTime))
      const tasks = openTasks.filter((item) => inDay(item.startTime))
      const exams = tasks.filter((item) => EXAM_CATEGORIES.includes(item.category) || isLikelyExamItem(item))
      const dueCount = tasks.length - exams.length
      const eventCount = dated.filter((item) => EVENT_CATEGORIES.includes(item.category)).length
      const quizOnly = exams.length > 0 && exams.every((e) => /quiz/i.test(`${e.category} ${e.title}`))

      // Tallies: a count and a short singular noun, the same form for every
      // count, so they fit a 390px column and repeat no string on the page.
      const tags: Array<{ text: string; due?: boolean }> = []
      if (classCount) tags.push({ text: `${classCount} class` })
      if (dueCount) tags.push({ text: `${dueCount} due`, due: true })
      if (exams.length) tags.push({ text: `${exams.length} ${quizOnly ? 'quiz' : 'exam'}` })
      if (eventCount) tags.push({ text: `${eventCount} event` })

      const parts = [
        classCount ? `${classCount} class${classCount === 1 ? '' : 'es'}` : '',
        dueCount ? `${dueCount} due` : '',
        exams.length ? `${exams.length} ${quizOnly ? 'quiz' : 'exam'}${exams.length === 1 ? '' : quizOnly ? 'zes' : 's'}` : '',
        eventCount ? `${eventCount} event${eventCount === 1 ? '' : 's'}` : '',
      ].filter(Boolean)
      const long = day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
      return {
        key: localIsoDate(day),
        today: i === 0,
        d: shortWeekdayCaps(day),
        n: day.getDate(),
        tags: tags.slice(0, 3),
        label: `${long}${i === 0 ? ', today' : ''}: ${parts.length ? parts.join(', ') : 'nothing scheduled'}`,
      }
    })
  }, [now, homeClasses, cleanCalendarItems, openTasks])

  // Free time drawn as a route line: now, the first deadline that falls before
  // the next class (if any), and the next class as the terminus. Stops sit in
  // proportion to the real times; the middle one is kept clear of the ends so
  // its labels never collide with theirs.
  const freeLine = useMemo(() => {
    const next = scheduleState.nextClass
    if (!next) return null
    const nowMs = now.getTime()
    const startMs = next.startDate.getTime()
    if (startMs <= nowMs) return null
    const dayTag = (d: Date) => (d.toDateString() === now.toDateString() ? '' : shortWeekdayCaps(d))
    const deadline = openTasks
      .filter((item) => {
        const t = new Date(item.startTime).getTime()
        return t > nowMs && t < startMs
      })
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0]
    const nextParts = courseParts(next.title)
    const startDay = dayTag(next.startDate)
    let mid = null as null | { left: string; leftNarrow: string; time: string; day: string; name: string }
    let midLabel = ''
    if (deadline) {
      const due = new Date(deadline.startTime)
      const share = (due.getTime() - nowMs) / (startMs - nowMs)
      // Clamped so the middle labels stay clear of "Now" and the terminus.
      // The narrow bounds apply when the card is under 32rem (phones, and a
      // half-width card on a tablet), where the labels sit closer together.
      mid = {
        left: pct(Math.min(0.58, Math.max(0.22, share))),
        leftNarrow: pct(Math.min(0.5, Math.max(0.26, share))),
        time: shortTime(due),
        day: dayTag(due),
        name: courseParts(deadline.title).name,
      }
      midLabel = ` ${deadline.title} due ${mid.day ? `${mid.day} ` : ''}${mid.time}.`
    }
    return {
      nowTime: shortTime(now),
      mid,
      last: {
        time: shortTime(next.startDate),
        day: startDay,
        name: nextParts.code || nextParts.name,
        where: next.location || '',
      },
      label: `Now, ${shortTime(now)}.${midLabel} ${next.title} ${startDay ? `${startDay} ` : ''}${shortTime(next.startDate)}${next.location ? `, ${next.location}` : ''}.`,
    }
  }, [scheduleState.nextClass, openTasks, now])

  // Card headings keep their original Title Case text (tests and accessible
  // names read it) and display in sentence case through CSS
  // ('lowercase first-letter:uppercase'), as they used to display in caps.
  // Registry: widget id → display title + a renderer that closes over the
  // already-computed state above. Each renderer returns the section's card
  // (or null when it has nothing to show, e.g. smart alerts).
  // Only ids present here are rendered; unknown ids in a saved layout are
  // ignored. The saved layout drives order, size, and visibility.
  const widgetRegistry: Record<string, { title: string; render: (size?: string) => React.ReactNode }> = {
    'week-ahead': {
      title: 'Week ahead',
      render: () => {
        const weekAheadDigest = (
          <AiMarkdown className="text-[14px] leading-[1.55] text-[var(--color-txt-1)] max-w-[68ch]">{weekAheadText}</AiMarkdown>
        )
        const weekAheadFailure = (
          <p role="alert" className="text-[13px] text-[var(--color-error)]">
            {weekAheadError}
          </p>
        )
        const summary = !hasScheduleData ? (
          <p className="text-[14px] text-[var(--color-txt-2)]">
            <Link to="/setup" className="font-display font-bold text-[var(--color-accent)] hover:underline">
              Connect your schedule
            </Link>{' '}
            to get a weekly briefing.
          </p>
        ) : weekAheadLoading && !weekAheadText ? (
          <div className="flex items-center gap-2 text-[14px] text-[var(--color-txt-2)]">
            <div className="w-3.5 h-3.5 border-2 border-[var(--color-txt-2)] border-t-transparent rounded-full animate-spin shrink-0" />
            Generating your week summary…
          </div>
        ) : typeof weekAheadText === 'string' && weekAheadText ? (
          weekAheadError ? (
            // A failed Refresh keeps the digest already shown, under the message.
            <div className="min-w-0 space-y-2">
              {weekAheadFailure}
              {weekAheadDigest}
            </div>
          ) : (
            weekAheadDigest
          )
        ) : weekAheadError ? (
          weekAheadFailure
        ) : null
        // Seven blank days say nothing to someone with no schedule, so the
        // strip waits for a schedule or for something landing this week.
        const showStrip = hasScheduleData || weekDays.some((day) => day.tags.length > 0)
        return (
          <div className="card card-pad r-ai @container">
            <div className="card-head">
              <span className="route-badge">
                <Icon name="sparkles" size={18} />
              </span>
              <div>
                <h2 className="card-title">{now.getDay() === 1 ? 'Monday briefing' : 'Week ahead'}</h2>
                <p className="card-sub">AI · from your linked schedule & calendar</p>
              </div>
              {hasScheduleData && (
                <button
                  type="button"
                  onClick={generateWeekAheadSummary}
                  disabled={weekAheadLoading}
                  className="head-link disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Icon name="refresh" size={14} className={weekAheadLoading ? 'animate-spin' : ''} />
                  {weekAheadLoading ? 'Generating…' : 'Refresh'}
                </button>
              )}
            </div>
            <div
              className={
                // One minmax(0,1fr) column below 46rem: the implicit auto column
                // grew to the summary's longest unbroken word or URL, pushing the
                // summary and the strip past the card and the page sideways.
                summary && showStrip
                  ? 'grid grid-cols-[minmax(0,1fr)] gap-5 items-start @min-[46rem]:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] @min-[46rem]:gap-8'
                  : ''
              }
            >
              {summary}
              {showStrip && (
                <ol className="week-strip" aria-label="Your next seven days">
                  {weekDays.map((day) => (
                    // The detail is real text for screen readers (browse mode
                    // skips an aria-label on a list item); the short visible
                    // day, date and tags are hidden from them.
                    <li key={day.key} className={day.today ? 'today' : undefined}>
                      <span className="sr-only">{day.label}</span>
                      <span className="d" aria-hidden="true">{day.d}</span>
                      <span className="n" aria-hidden="true">{day.n}</span>
                      <span className="tags" aria-hidden="true">
                        {day.tags.map((tag) => (
                          <span key={tag.text} className={`tag${tag.due ? ' due' : ''}`}>
                            {tag.text}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )
      },
    },
    'smart-alerts': {
      title: 'Heads up',
      render: () =>
        smartAlerts.length === 0 ? null : (
          <div className="alerts">
            <h2 className="alerts-label">
              <Icon name="alert" size={15} />
              Heads Up
            </h2>
            <ul>
              {smartAlerts.map((alert, i) => (
                <li key={i} className={alert.route}>
                  <span className="route-badge sm">
                    <Icon name={alert.icon} size={14} />
                  </span>
                  <span className="min-w-0">{alert.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ),
    },
    'quick-actions': {
      title: 'Quick actions',
      // Column count follows the widget's width so a narrow widget stacks its
      // actions vertically instead of squashing them. Full class strings are
      // written out so Tailwind's scanner emits them.
      render: (size?: string) => (
        <div className={`grid gap-3 sm:gap-4 ${quickActionsGridClass(size ?? 'full')}`}>
          {quickActions.map(({ path, label, sub, icon, route }) => (
            <Link key={path} to={path} className={`tile ${route}`}>
              <span className="route-badge">
                <Icon name={icon} size={18} />
              </span>
              <span>
                <b>{label}</b>
                <small>{sub}</small>
              </span>
              <Icon name="arrowUpRight" size={16} className="go" />
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
                ? 'text-[var(--color-gold-muted)]'
                : 'text-[var(--color-error)]'
        return (
          <div className="card card-pad r-ink">
            <div className="card-head">
              <span className="route-badge">
                <Icon name="graduation" size={18} />
              </span>
              <div>
                <h2 className="card-title">Cumulative GPA</h2>
              </div>
              <Link to="/grade-tracker" className="head-link">
                {gpa == null ? 'Add grades' : 'View all'}
                <Icon name={gpa == null ? 'plus' : 'chevronRight'} size={14} />
              </Link>
            </div>
            {gpa == null ? (
              <div className="empty sm:flex-row sm:items-center sm:gap-4">
                {/* Decorative: the heading and the sentence carry the meaning. */}
                <span className="flaps blank" aria-hidden="true">
                  <span className="flap" />
                  <span className="flap-sep">.</span>
                  <span className="flap" />
                  <span className="flap" />
                </span>
                {/* A failed grades read is not an empty transcript (R12). */}
                {gradesLoadFailed ? (
                  <p role="alert">Could not load your grades. Check your connection and try again.</p>
                ) : (
                  <p>Track your courses to see your GPA here.</p>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={`big-stat ${tone}`}>{gpa.toFixed(2)}</span>
                <span className="text-[13px] text-[var(--color-txt-2)] tnum">
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
      render: () => {
        const start = displayClass ? new Date(displayClass.startTime) : null
        const flap = start ? flapParts(start) : null
        const course = displayClass ? courseParts(displayClass.title) : null
        // The big amber countdown is the visual twin of the status line, which
        // stays in the head for screen readers (and is the only one on a narrow board).
        const countdown = scheduleState.currentClass
          ? { label: 'Ends in', value: formatDuration(getMinutesBetween(scheduleState.currentClass.endDate, now)) }
          : scheduleState.nextClass
            ? { label: 'Starts in', value: formatDuration(scheduleState.freeMinutes) }
            : null
        // One amber primary per view: the setup banner's button owns it while
        // the banner shows. Customizing adds none (Done is ink).
        const directionsPrimary = !!displayClass && !showSetupBanner
        return (
          // The board's own width picks its layout (index.css, the .board
          // container tiers), so a half-width board never squeezes the wide row.
          <div className="board r-cls">
            <div className="board-head flex-wrap gap-y-2">
              <h2 className="board-title">{scheduleState.cardLabel}</h2>
              {/* Amber only while something is counting down; "Schedule clear" stays neutral.
                  With a countdown on screen the board keeps the line for screen readers only. */}
              <span className={countdown ? 'board-status' : 'board-status text-[var(--color-ink-dim)]'}>
                {countdown && <span className="live-dot" aria-hidden="true" />}
                {scheduleState.statusLabel}
              </span>
            </div>
            <div className="board-main">
              {flap && start ? (
                <div
                  className="flaps"
                  role="img"
                  aria-label={`${start.toLocaleDateString(undefined, { weekday: 'long' })} ${shortTime(start)}`}
                >
                  {/* Each digit rolls over when the next class changes, and in
                      from a blank tile when the board appears (FlapDigit). */}
                  {flap.hour.map((digit, i) => (
                    <FlapDigit key={`h${i}`} value={digit} index={i} />
                  ))}
                  <span className="flap-sep" aria-hidden="true">:</span>
                  {flap.minute.map((digit, i) => (
                    <FlapDigit key={`m${i}`} value={digit} index={flap.hour.length + i} />
                  ))}
                  <span className="flap-meta" aria-hidden="true">
                    <b>{flap.meridiem}</b>
                    <span>{flap.day}</span>
                  </span>
                </div>
              ) : (
                <div className="flaps" aria-hidden="true">
                  <span className="flap">{' '}</span>
                  <span className="flap-sep">:</span>
                  <span className="flap">{' '}</span>
                  <span className="flap">{' '}</span>
                </div>
              )}
              <div className="dest">
                {displayClass && course ? (
                  <>
                    {course.code && <span className="code solid">{course.code}</span>}
                    {course.code ? ' ' : null}
                    <p className="dest-name">{course.name}</p>
                    <p className="dest-sub">{displayClass.description || 'Class meeting'}</p>
                    <p className="dest-sub mt-1 tnum">{scheduleState.cardMeta}</p>
                  </>
                ) : (
                  <>
                    <p className="dest-name">No upcoming classes</p>
                    <p className="dest-sub">
                      {classLoadError || 'You have no more imported class meetings coming up right now.'}
                    </p>
                  </>
                )}
              </div>
              {countdown && (
                <div className="countdown" aria-hidden="true">
                  <small>{countdown.label}</small>
                  <b>{countdown.value}</b>
                </div>
              )}
            </div>
            <div className="board-foot">
              {displayClass && start && (
                <dl className="cells">
                  <div>
                    <dt>Room</dt>
                    <dd className="whitespace-normal [overflow-wrap:anywhere]">
                      {displayClass.location || 'Location unavailable'}
                    </dd>
                  </div>
                  <div>
                    <dt>Time</dt>
                    <dd>{formatTimeRange(displayClass.startTime, displayClass.endTime)}</dd>
                  </div>
                  <div>
                    <dt>Day</dt>
                    <dd>{start.toLocaleDateString(undefined, { weekday: 'long' })}</dd>
                  </div>
                </dl>
              )}
              <div className="board-actions">
                <Link to="/schedule" className="btn btn-onink">
                  <Icon name="calendar" size={16} />
                  Full Schedule
                </Link>
                {/* Opens the map on the class's building (?building=&room=), as
                    Schedule's Find Room does, rather than on an empty map. */}
                <Link
                  to={mapHrefForRoom(displayClass?.location)}
                  className={`btn ${directionsPrimary ? 'btn-primary' : 'btn-onink'}`}
                >
                  <Icon name="navigation" size={16} />
                  Get Directions
                </Link>
              </div>
            </div>
          </div>
        )
      },
    },
    'free-time': {
      title: 'Free time',
      render: () => (
        // The route line is its own size container (index.css), so its labels
        // follow the card's width, not the viewport.
        <div className="card card-pad r-cls">
          <div className="card-head">
            <span className="route-badge">
              <Icon name="clock" size={18} />
            </span>
            <div>
              <h2 className="card-title lowercase first-letter:uppercase">Free Time</h2>
            </div>
            {/* Not AI: buildSuggestions() is deterministic logic over the
                schedule. A sparkle here made it read as a model answer and
                undercut the real assistant sitting right below it. */}
            <span className="chip ml-auto shrink-0">From your schedule</span>
          </div>

          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="big-stat">{formatDuration(scheduleState.freeMinutes)}</span>
            {freeLine && <p className="min-w-0 text-[14px] text-[var(--color-txt-2)]">{scheduleState.freeLabel}</p>}
          </div>

          {freeLine ? (
            <div className="line" role="img" aria-label={freeLine.label}>
              <div className="line-track" />
              <div className="stop first now" aria-hidden="true">
                <span className="t">{freeLine.nowTime}</span>
                <span className="dot" />
                <span className="n">
                  <b>Now</b>
                </span>
              </div>
              {freeLine.mid && (
                // An ink stop (r-ink) for the deadline. Under 32rem of line it
                // takes the narrow position; the line's own rule (index.css)
                // moves its time under the dot there.
                <div
                  className="stop mid r-ink left-[var(--mid)] @max-[32rem]:left-[var(--mid-narrow)]"
                  aria-hidden="true"
                  style={{ '--mid': freeLine.mid.left, '--mid-narrow': freeLine.mid.leftNarrow } as React.CSSProperties}
                >
                  <span className="t">
                    {freeLine.mid.day && <em>{freeLine.mid.day}</em>}
                    {freeLine.mid.time}
                  </span>
                  <span className="dot" />
                  <span className="n">
                    <b className="max-w-[8.5rem] @max-[32rem]:max-w-[5rem] truncate">{freeLine.mid.name}</b>
                    due
                  </span>
                </div>
              )}
              <div className="stop last" aria-hidden="true">
                <span className="t">
                  {freeLine.last.day && <em>{freeLine.last.day}</em>}
                  {freeLine.last.time}
                </span>
                <span className="dot" />
                <span className="n max-w-[8rem] @max-[32rem]:max-w-[6rem]">
                  <b className="truncate">{freeLine.last.name}</b>
                  {/* In the narrowest card (a half-width card on a small tablet) the
                      room makes way for the middle stop; the board and the
                      line's label still give it. */}
                  <span className={`block truncate ${freeLine.mid ? '@max-[19rem]:hidden' : ''}`}>
                    {freeLine.last.where}
                  </span>
                </span>
              </div>
            </div>
          ) : (
            <div className="empty row mt-4">
              <span className="ico">
                <Icon name="calendar" size={18} />
              </span>
              <p>{scheduleState.freeLabel}</p>
            </div>
          )}

          <div className="mt-5 pt-4 border-t border-[var(--color-border)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 pt-1">
                <div className="eyebrow bare">What you could do</div>
                <p className="text-[12.5px] text-[var(--color-txt-2)] mt-1.5 hidden sm:block">
                  Ideas from your schedule, dining, and today&apos;s events
                </p>
              </div>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('open-campus-assistant', {
                  detail: { message: 'What should I do right now? Consider my free time, dining hours, any upcoming events or classes, and give me a specific personalized suggestion.' }
                }))}
                className="btn btn-secondary btn-sm shrink-0"
              >
                <Icon name="sparkles" size={14} />
                Ask AI
              </button>
            </div>
            <ul className="rows mt-2">
              {suggestions.map(({ icon, text, time, sub }, idx) => (
                <li key={idx}>
                  <span className="ico">
                    <Icon name={icon} size={16} />
                  </span>
                  <span className="txt">
                    {sub && <small>{sub}</small>}
                    <b className="line-clamp-3">{text}</b>
                  </span>
                  <span className="chip shrink-0 max-w-[12rem] whitespace-normal leading-[1.25]">{time}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ),
    },
    'todays-events': {
      title: "Today's events",
      render: () => (
        <div className="card card-pad r-evt">
          <div className="card-head">
            <span className="route-badge">
              <Icon name="calendar" size={18} />
            </span>
            <div>
              <h2 className="card-title lowercase first-letter:uppercase">Today&apos;s Events</h2>
            </div>
            <Link to="/events" className="head-link">
              View all
              <Icon name="chevronRight" size={14} />
            </Link>
          </div>
          {hasNoCalendarSources && (
            <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-border-2)] bg-[var(--color-stat)] p-4">
              <div className="font-display font-bold text-[14px] text-[var(--color-txt-0)]">Connect your calendar</div>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
                Link Brightspace or another source in setup so today&apos;s campus events match your feed.
              </p>
              <Link
                to="/setup"
                className="inline-flex items-center gap-1.5 mt-2 font-display font-bold text-[13px] text-[var(--color-accent)] hover:underline"
              >
                <Icon name="calendar" size={14} />
                Go to setup
              </Link>
            </div>
          )}
          {calendarLoadError && !calendarLoading && (
            <p className="text-[13px] text-[var(--color-txt-2)] mb-3">{calendarLoadError}</p>
          )}
          {calendarLoading ? (
            <p className="text-[14px] text-[var(--color-txt-2)]">Loading today&apos;s events…</p>
          ) : todayEventsPreview.length === 0 ? (
            !hasNoCalendarSources ? (
              <div className="empty row">
                <span className="ico">
                  <Icon name="calendar" size={18} />
                </span>
                <p>No more events scheduled for the rest of today.</p>
              </div>
            ) : null
          ) : (
            <ul>
              {todayEventsPreview.map((item) => {
                const cat = homeEventCategory[item.category] || homeEventCategory.event
                const loc = item.location ? item.location.split(' (')[0] : null
                return (
                  <li
                    key={item.id}
                    className="flex items-start gap-3 py-3 border-t border-[var(--color-border)] first:border-t-0 first:pt-0"
                  >
                    <span className="mt-[7px] w-2 h-2 shrink-0 rounded-[2px] bg-[var(--route)]" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="font-display font-bold text-[15px] leading-snug text-[var(--color-txt-0)]">{item.title}</div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-[12.5px] text-[var(--color-txt-2)]">
                        <span className="tnum">{formatDashboardEventTime(item.startTime, item.endTime)}</span>
                        {loc && (
                          <span className="flex items-center gap-1.5 min-w-0">
                            <Icon name="mapPin" size={12} className="shrink-0" />
                            <span className="truncate">{loc}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="badge shrink-0">{cat.label}</span>
                  </li>
                )
              })}
            </ul>
          )}
          {!calendarLoading && todayRelevantEvents.length > todayEventsPreview.length && (
            <p className="text-[12.5px] text-[var(--color-txt-2)] pt-3">
              +{todayRelevantEvents.length - todayEventsPreview.length} more on the{' '}
              <Link to="/events" className="text-[var(--color-accent)] hover:underline">
                events page
              </Link>
            </p>
          )}
        </div>
      ),
    },
    'live-shuttles': {
      title: 'Live shuttles',
      render: () => (
        <div className="card card-pad r-bus">
          <div className="card-head">
            <span className="route-badge">
              <Icon name="bus" size={18} />
            </span>
            <div>
              <h2 className="card-title">Live shuttles</h2>
              {(transitUpdated && !transitLoading) || userLocation ? (
                <p className="card-sub flex flex-wrap items-center gap-x-2">
                  {transitUpdated && !transitLoading && (
                    <span className="tnum">
                      Updated {transitUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  )}
                  {userLocation && (
                    <span className="text-[var(--color-success)] inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
                      ETA to you
                    </span>
                  )}
                </p>
              ) : null}
            </div>
            <Link to="/transit" className="head-link">
              Map & routes
              <Icon name="chevronRight" size={14} />
            </Link>
          </div>
          {transitLoading && transitVehicles.length === 0 ? (
            <p className="text-[14px] text-[var(--color-txt-2)]">Loading live bus positions…</p>
          ) : transitError && transitVehicles.length === 0 ? (
            <div className="empty">
              <span className="ico">
                <Icon name="alert" size={18} />
              </span>
              <p>{transitError}</p>
              <Link
                to="/transit"
                className="font-display font-bold text-[13px] text-[var(--color-accent)] hover:underline"
              >
                Open transit
              </Link>
            </div>
          ) : transitDashboardRows.length === 0 ? (
            <div className="empty">
              {/* Decorative station sign; the sentence below carries the meaning. */}
              <span className="plate" aria-hidden="true">Not in service</span>
              <p>No buses active right now. Check the transit map for routes and alerts.</p>
            </div>
          ) : (
            <ul>
              {transitDashboardRows.map(({ key, vehicle, route, near, speed, moving, eta }) => (
                <li
                  key={key}
                  className="flex items-start gap-3 py-3 border-t border-[var(--color-border)] first:border-t-0 first:pt-0"
                >
                  <span
                    className="mt-1 w-3 h-3 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: route.color }}
                    title={route.name}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">{route.name}</div>
                      <span className={`chip shrink-0 ${moving ? 'text-[var(--color-success)]' : 'text-[var(--color-txt-2)]'}`}>
                        {moving ? `${Math.round(speed)} mph` : 'stopped'}
                      </span>
                    </div>
                    <div className="text-[14px] text-[var(--color-txt-1)] mt-1 leading-snug">{eta}</div>
                    <div className="text-[12px] text-[var(--color-txt-3)] mt-1">
                      Bus {vehicle.Name}
                      {near && <> · near {near.description}</>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!transitLoading && transitVehicles.length > transitDashboardRows.length ? (
            <p className="text-[12.5px] text-[var(--color-txt-2)] pt-3">
              +{transitVehicles.length - transitDashboardRows.length} more on{' '}
              <Link to="/transit" className="text-[var(--color-accent)] hover:underline">
                transit
              </Link>
            </p>
          ) : null}
        </div>
      ),
    },
    'dining': {
      title: 'Dining snapshot',
      render: () => {
        // The day's opening hours on a 24-hour track with an amber needle at
        // now. Drawn only when the hours parse; the text above carries them.
        const ranges = diningStatus ? parseHourRanges(diningStatus.hours) : []
        const nowShare = (now.getHours() * 60 + now.getMinutes()) / (24 * 60)
        const diningState = diningStatus ? openState(diningStatus) : null
        return (
          <div className="card card-pad r-din">
            <div className="card-head">
              <span className="route-badge">
                <Icon name="dining" size={18} />
              </span>
              <div>
                <h2 className="card-title lowercase first-letter:uppercase">Dining Snapshot</h2>
              </div>
              <Link to="/dining" className="head-link">
                Open dining
                <Icon name="chevronRight" size={14} />
              </Link>
            </div>

            {diningStatus && (
              <div className="mb-5">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display font-extrabold text-[18px] leading-tight tracking-[-0.01em] text-[var(--color-txt-0)] min-w-0">
                    {diningStatus.name}
                  </span>
                  {/* Open, Closed, or Menu posted when the feed lists no
                      hours for a day it serves (issue #465). */}
                  <span className={`eyebrow bare shrink-0 ${diningStatus.is_open ? 'text-[var(--color-success)]' : ''}`} data-dining-widget-status>
                    <span
                      className={`status-dot ${
                        diningState === 'open' ? 'status-open' : diningState === 'unknown' ? 'status-unknown' : 'bg-[var(--color-txt-3)]'
                      }`}
                    />
                    {diningState === 'open' ? 'Open' : diningState === 'unknown' ? 'Menu posted' : 'Closed'}
                  </span>
                </div>
                <p className="mt-1 text-[14px] text-[var(--color-txt-1)] tnum">{diningStatus.hours}</p>
                {ranges.length > 0 && (
                  <div className="mt-4" aria-hidden="true">
                    <div className="relative h-2.5 rounded-[2px] bg-[var(--color-stat)] shadow-[inset_0_0_0_1px_var(--color-border-2)]">
                      {ranges.map(([open, close]) => (
                        <span
                          key={`${open}-${close}`}
                          className="absolute inset-y-0 rounded-[2px] bg-[var(--route)]"
                          style={{ left: pct(open / 1440), width: pct((close - open) / 1440) }}
                        />
                      ))}
                      <span
                        className="absolute -top-1.5 -bottom-1.5 w-[3px] -ml-[1.5px] rounded-[1px] bg-[var(--color-gold)] shadow-[0_0_0_1.5px_var(--color-surface)]"
                        style={{ left: pct(nowShare) }}
                      />
                    </div>
                    <div className="relative h-4 mt-2 font-display font-bold text-[10.5px] leading-none text-[var(--color-txt-3)] tnum">
                      <span className="absolute left-1/4 -translate-x-1/2">6 AM</span>
                      <span className="absolute left-1/2 -translate-x-1/2">12 PM</span>
                      <span className="absolute left-3/4 -translate-x-1/2">6 PM</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="eyebrow mb-1">{diningPreview ? diningPreview.heading : 'Sample items'}</div>
            {/* Rules sit only between rows: none above the first row, none
                under the last, so an odd count leaves no short column. */}
            <ul className="grid grid-cols-2 gap-x-5">
              {menuSnapshot.items.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 py-2 border-t border-[var(--color-border)] [&:nth-child(-n+2)]:border-t-0 text-[14px] leading-snug text-[var(--color-txt-1)] min-w-0"
                >
                  <span className="mt-[6px] w-1.5 h-1.5 shrink-0 rounded-[1px] bg-[var(--route)]" aria-hidden="true" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      },
    },
    'board': {
      title: 'Student board',
      render: () => (
        <div className="card card-pad r-ink">
          <div className="card-head">
            <span className="route-badge">
              <Icon name="messageCircle" size={18} />
            </span>
            <div>
              <h2 className="card-title lowercase first-letter:uppercase">Student Board</h2>
              <p className="card-sub">Community Q&amp;A from campus</p>
            </div>
            <Link to="/board" className="head-link">
              Open board
              <Icon name="arrowUpRight" size={14} />
            </Link>
          </div>

          {boardError && !boardLoading && (
            <p className="text-[13px] text-[var(--color-error)] mb-3">{boardError}</p>
          )}
          {boardLoading ? (
            <ul className="posts" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <div className="post-row">
                    <span className="skeleton w-9 h-9 rounded-full" />
                    <span className="block space-y-2">
                      <span className="skeleton block h-3.5 w-[85%]" />
                      <span className="skeleton block h-3 w-[40%]" />
                    </span>
                    <span />
                  </div>
                </li>
              ))}
            </ul>
          ) : boardPreview.length === 0 ? (
            <div className="empty">
              <span className="ico">
                <Icon name="message" size={18} />
              </span>
              <div>
                <p className="font-display font-bold text-[var(--color-txt-1)]">No threads yet</p>
                <p className="mt-0.5">Be the first to ask the campus a question.</p>
              </div>
              <Link
                to="/board"
                className="inline-flex items-center gap-1.5 font-display font-bold text-[13px] text-[var(--color-accent)] hover:underline"
              >
                Start a thread
                <Icon name="arrowUpRight" size={12} />
              </Link>
            </div>
          ) : (
            <ul className="posts">
              {boardPreview.map((post) => (
                <li key={post.id}>
                  <Link to="/board">
                    <span className="ava" aria-hidden="true">
                      {(post.user || '?').charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-start gap-2">
                        <h3 className="ttl row-title line-clamp-2 min-w-0">{post.title}</h3>
                        {post.hot && <span className="badge shrink-0 mt-0.5">Hot</span>}
                      </div>
                      <span className="by">{post.user}</span>
                    </div>
                    <span className="counts">
                      <span>
                        <Icon name="arrowUp" size={12} />
                        {post.upvotes}
                      </span>
                      <span>
                        <Icon name="messageCircle" size={12} />
                        {Array.isArray(post.replies) ? post.replies.length : 0}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    },
    'tasks-due': {
      title: 'Tasks due',
      render: () => (
        <div className="card card-pad r-tsk">
          <div className="card-head">
            <span className="route-badge">
              <Icon name="document" size={18} />
            </span>
            <div>
              <h2 className="card-title lowercase first-letter:uppercase">Tasks Due</h2>
            </div>
            <Link to="/assignments" className="head-link">
              View all
              <Icon name="chevronRight" size={14} />
            </Link>
          </div>
          {calendarFailed && !tasksLoading && (
            <p role="alert" className="mb-4 text-[13px] text-[var(--color-txt-2)]">
              Could not load your calendar, so deadlines from it are missing.{' '}
              <button
                type="button"
                onClick={() => void calendarQuery.refetch()}
                disabled={calendarQuery.isFetching}
                className="font-display font-bold text-[var(--color-accent)] hover:underline disabled:opacity-40"
              >
                {calendarQuery.isFetching ? 'Trying…' : 'Try again'}
              </button>
            </p>
          )}
          {tasksLoading ? (
            <p className="text-[14px] text-[var(--color-txt-2)]">Loading your tasks…</p>
          ) : tasksDuePreview.length === 0 && calendarFailed ? (
            // The failed read is said above; "Nothing due" would be a guess.
            null
          ) : tasksDuePreview.length === 0 ? (
            <div className="empty row">
              <span className="ico">
                <Icon name="document" size={18} />
              </span>
              <p>
                Nothing due right now. Add tasks on the{' '}
                <Link to="/assignments" className="text-[var(--color-accent)] underline underline-offset-2">Tasks page</Link>.
              </p>
            </div>
          ) : (
            <ol className="dep -my-3">
              {tasksDuePreview.map((item) => {
                const due = new Date(item.startTime)
                // Urgent: due within the next 24 hours (lib/urgency, shared
                // with Assignments). Overdue items get no "Due in" label.
                const dueSoon = dueSoonLabel(due, { now })
                const { code, name } = courseParts(item.title)
                return (
                  <li key={item.id} className={dueSoon ? 'urgent' : undefined}>
                    <Link to="/assignments">
                      <span className="when" aria-hidden="true">
                        <span>{shortWeekdayCaps(due)}</span>
                        <b>{due.getDate()}</b>
                      </span>
                      <span className="body">
                        {code && <span className="code">{code}</span>}
                        {code ? ' ' : null}
                        <span className="ttl">{name}</span>
                        <span className="meta">
                          {formatDueTime(item)}
                          {' · '}
                          {due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                        </span>
                      </span>
                      {dueSoon ? (
                        <span className="badge badge-signal" aria-hidden="true">
                          {dueSoon}
                        </span>
                      ) : (
                        <span className="end" aria-hidden="true">
                          <Icon name="chevronRight" size={18} />
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      ),
    },
    'calendar-feed': {
      title: 'Calendar feed',
      render: () => (
        <div className="card card-pad r-cls">
          <div className="card-head">
            <span className="route-badge">
              <Icon name="calendar" size={18} />
            </span>
            <div>
              <h2 className="card-title lowercase first-letter:uppercase">Calendar Feed</h2>
            </div>
          </div>
          <p className="text-[14px] text-[var(--color-txt-2)] mb-4">
            Subscribe to your BoilerIndy schedule and events in Google Calendar, Apple Calendar, or Outlook.
          </p>
          <Link to="/settings" className="btn btn-secondary btn-sm">
            <Icon name="external" size={14} />
            Manage feed
          </Link>
        </div>
      ),
    },
    'campus-news': {
      title: 'Campus news',
      // The Circuit's headlines (issue #470); fetches only while shown.
      render: () => <CampusNewsWidget />,
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

  // The board paints at once from the saved layout, and each widget loads
  // inside its own card, so the grid never rises as a whole: a widget that
  // shows up later (Heads up once something is due, one added back while
  // customizing) rises by itself (hooks/useEntrance).
  const widgetsRef = useEntrance<HTMLDivElement>(true)

  return (
    <div className="page">
      <PageTitle>Dashboard</PageTitle>
      {/* A feed that stopped syncing shows here, not only on the Connect page (issue #12). */}
      <SourceErrorNotice className="mb-5" />
      <FeaturedDeal />
      <header className={`page-head ${editing ? '' : 'max-md:flex-nowrap max-md:items-start'}`}>
        <div className={`flex-1 ${editing ? 'max-md:basis-full' : ''}`}>
          <p className="eyebrow signal">
            <time dateTime={localIsoDate(now)}>{getCurrentDate(now)}</time>
          </p>
          <h1 className="page-title">
            {getGreeting(now)}, {firstName}
          </h1>
          <p className="page-sub">Here's what's happening on campus today.</p>
        </div>
        {/* Customize toolbar: toggles widget edit mode, the same as Services'.
            On phones the idle button is a compact square beside the title whose
            accessible name stays "Customize"; while customizing the toolbar
            wraps under the subtitle. Done is ink, not amber, so customizing
            never adds a second amber primary to the view. */}
        <div className="flex items-center gap-2 shrink-0">
          {editing && (
            <button type="button" onClick={() => setShowResetConfirm(true)} className="btn btn-secondary">
              <Icon name="refresh" size={16} />
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            aria-pressed={editing}
            className={`btn ${editing ? 'btn-ink' : 'btn-secondary max-md:px-0'}`}
          >
            <Icon name={editing ? 'check' : 'settings'} size={16} />
            <span className={editing ? undefined : 'max-md:sr-only'}>{editing ? 'Done' : 'Customize'}</span>
          </button>
        </div>
      </header>

      {/* A refused layout save (issue #202) replaces the hint until the next change. */}
      {saveError ? (
        <p role="alert" className="mb-4 text-[13px] text-[var(--color-error)]">
          {saveError}
        </p>
      ) : editing ? (
        <p className="mb-4 text-[13px] text-[var(--color-txt-2)]">
          Drag a card or use the arrows to reorder. Hide with ×; add hidden widgets below.
        </p>
      ) : null}

      {showSetupBanner && (
        <div className="card card-pad r-cls mb-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <span className="route-badge lg">
              <Icon name={needsPurdueConnection ? 'graduation' : 'calendar'} size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="eyebrow">Finish Setup</h2>
              <div className="mt-2 font-display font-bold text-[17px] leading-snug text-[var(--color-txt-0)]">
                {needsPurdueConnection
                  ? 'Link your Purdue account next'
                  : purdueLinkingOff
                    ? 'Connect your class schedule'
                    : 'Your Purdue schedule is not connected yet'}
              </div>
              <p className="text-[14px] text-[var(--color-txt-2)] mt-1 max-w-[640px]">
                {needsPurdueConnection
                  ? 'Your BoilerIndy account is active. Link your Purdue identity from setup before connecting Purdue-specific sources.'
                  : purdueLinkingOff
                    ? 'Import your class schedule and assignments by attaching your Brightspace or Purdue Timetabling iCalendar export.'
                    : 'Your Purdue identity is linked, but classes only appear after you attach the Purdue Timetabling iCalendar export.'}
              </p>
            </div>
            {/* The route badge already carries the icon. */}
            <Link to="/setup" className="btn btn-primary w-fit shrink-0">
              {needsPurdueConnection ? 'Link Purdue' : 'Connect schedule'}
            </Link>
          </div>
        </div>
      )}

      <div
        ref={widgetsRef}
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
              allowedSizes={allowedSizesFor(w.id)}
              canMoveUp={idx > 0}
              canMoveDown={idx < visibleWidgets.length - 1}
              onMove={move}
              onMoveTop={moveToTop}
              onResize={setSize}
              onHide={(id) => setVisible(id, false)}
              onDropReorder={reorder}
              reducedMotion={reducedMotion}
            >
              {content || (
                <div className="card card-pad text-[14px] text-[var(--color-txt-2)]">
                  Nothing to show right now - this widget appears when it has something for you.
                </div>
              )}
            </DashboardWidget>
          )
        })}
      </div>

      {editing && (
        <AddWidgetPicker hiddenWidgets={hiddenWidgets} onAdd={(id) => setVisible(id, true)} />
      )}

      <ConfirmDialog
        open={showResetConfirm}
        icon="refresh"
        title="Reset dashboard?"
        message="This restores the default widgets, order, and sizes. Your current layout will be lost."
        confirmLabel="Reset"
        tone="danger"
        onConfirm={() => {
          reset()
          setShowResetConfirm(false)
        }}
        onCancel={() => setShowResetConfirm(false)}
      />
    </div>
  )
}
