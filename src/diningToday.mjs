// One dining hall's day for the app's Dining widget (issue #549, the app's
// #173): each meal's stretch of the day by the app's meal windows with its
// headline dishes, open or closed, and the next opening with its first meal,
// in about a kilobyte instead of the 56 KB of /api/dining. Built only from the
// snapshot /api/dining serves (src/nutrisliceDining.mjs), so the two agree at
// the same moment. Pure, except getDiningToday, which is handed the snapshot
// reader.

import { isoSeconds, plusDaysYmd, zonedTimeMs } from './campusTime.mjs'
import { CAMPUS_TIME_ZONE, MEAL_ORDER, MEAL_WINDOWS, chooseMeal, mealsAtMinutes, minutesInZone } from './diningMeals.mjs'
import { HOURS_NOT_LISTED, weekdayForYmd } from './nutrisliceDining.mjs'

/** Headline dishes per meal; the widget draws three. */
export const MAX_HEADLINERS = 3
/** How many days ahead the next opening is looked for. */
export const NEXT_OPENING_DAYS = 7

const DAY_MINUTES = 24 * 60
const HALL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** A `?hall=` value tidied for the lookup, or null when it cannot name a hall. */
export function normalizeHall(value) {
  if (typeof value !== 'string') return null
  const hall = value.trim().toLowerCase()
  return HALL_RE.test(hall) ? hall : null
}

/**
 * The snapshot location `hall` names: its slug ("tower-dining"), or the
 * slug's first word ("tower") when no other hall's slug starts with it.
 */
export function findHall(locations, hall) {
  const list = Array.isArray(locations) ? locations : []
  const exact = list.find((location) => location?.slug === hall)
  if (exact) return exact
  const byWord = list.filter((location) => typeof location?.slug === 'string' && location.slug.startsWith(`${hall}-`))
  return byWord.length === 1 ? byWord[0] : null
}

// The hours label the snapshot keeps per weekday (windowLabel in
// src/nutrisliceDining.mjs), read back as minutes past midnight.
const CLOCK_RANGE_RE = /^(\d{1,2}):(\d{2}) (AM|PM) - (\d{1,2}):(\d{2}) (AM|PM)$/

function clockMinutes(hour, minute, ampm) {
  return ((Number(hour) % 12) + (ampm === 'PM' ? 12 : 0)) * 60 + Number(minute)
}

/**
 * One weekday's hours label as { kind: 'hours', start, end } (minutes; an
 * end before the start runs past midnight), { kind: 'allDay' }, { kind:
 * 'unknown' } for a day that may be open but lists no times ("Hours not
 * listed", issue #465), or { kind: 'closed' }.
 */
export function parseHoursLabel(label) {
  if (label === 'Open 24 hours') return { kind: 'allDay' }
  if (label === HOURS_NOT_LISTED || label === 'Hours unavailable') return { kind: 'unknown' }
  const m = CLOCK_RANGE_RE.exec(typeof label === 'string' ? label : '')
  if (!m) return { kind: 'closed' }
  return { kind: 'hours', start: clockMinutes(m[1], m[2], m[3]), end: clockMinutes(m[4], m[5], m[6]) }
}

function dayHours(location, ymd) {
  return parseHoursLabel(location?.weekly_hours?.[weekdayForYmd(ymd)])
}

// Where the app's meal windows (MEAL_WINDOWS in src/diningMeals.mjs) start:
// midnight, 10:30 AM and 4:30 PM.
const WINDOW_STARTS = MEAL_WINDOWS.map((_, i) => (i ? MEAL_WINDOWS[i - 1].until : 0))

const servingIndex = (meal) => (MEAL_ORDER.includes(meal) ? MEAL_ORDER.indexOf(meal) : MEAL_ORDER.length)

/**
 * Each posted meal's stretch of the day in minutes past midnight: the meal
 * the app opens Dining on in each window (chooseMeal, as its default tab
 * does), cut to the day's hours [open, close). The day never steps back to
 * an earlier meal: chooseMeal answers the first meal for an evening with no
 * dinner, and that window gets no meal here, so every meal has one stretch.
 * `posted` is in serving order; a meal no window shows gets null bounds.
 */
export function mealStretches(posted, open = 0, close = DAY_MINUTES) {
  const stretches = new Map()
  let last = -1
  MEAL_WINDOWS.forEach((window, i) => {
    const meal = chooseMeal(posted, window.meals)
    const from = Math.max(WINDOW_STARTS[i], open)
    const until = Math.min(window.until, close)
    if (!meal || servingIndex(meal) < last || from >= until) return
    last = servingIndex(meal)
    const seen = stretches.get(meal)
    stretches.set(meal, seen ? { from: seen.from, until } : { from, until })
  })
  return posted.map((meal) => ({ meal, ...(stretches.get(meal) ?? { from: null, until: null }) }))
}

/** The first dish of each station not served every day (issue #466), in menu order, at most MAX_HEADLINERS. */
export function headlinersOf(menu) {
  const out = []
  for (const station of menu?.stations ?? []) {
    const dish = station?.everyday ? null : station?.items?.[0]?.name
    if (!dish) continue
    out.push({ station: station.name, dish })
    if (out.length === MAX_HEADLINERS) break
  }
  return out
}

/**
 * The service window `now` falls in or comes before, as instants: yesterday's
 * when it runs past midnight into now, otherwise today's. Null when today
 * lists no times, or is open all day, as /api/dining has no closing then.
 */
function serviceWindow(location, today, nowMinutes) {
  const yesterday = plusDaysYmd(today, -1)
  const before = dayHours(location, yesterday)
  if (before.kind === 'hours' && before.end < before.start && nowMinutes <= before.end) {
    return { opens: zonedTimeMs(yesterday, before.start), closes: zonedTimeMs(today, before.end) }
  }
  const hours = dayHours(location, today)
  if (hours.kind !== 'hours') return null
  const end = hours.end < hours.start ? hours.end + DAY_MINUTES : hours.end
  return { opens: zonedTimeMs(today, hours.start), closes: zonedTimeMs(today, end) }
}

/**
 * When the hall next opens after the instant `afterMs`: the first day from
 * `today` whose listed opening is later than that, as { date, at, minutes },
 * or a later day that lists no times though it may open ("Hours not listed"),
 * with `at` and `minutes` null. Null when nothing opens within
 * NEXT_OPENING_DAYS.
 */
export function findNextOpening(location, today, afterMs) {
  for (let day = 0; day <= NEXT_OPENING_DAYS; day += 1) {
    const ymd = plusDaysYmd(today, day)
    const hours = dayHours(location, ymd)
    const start = hours.kind === 'hours' ? hours.start : hours.kind === 'allDay' ? 0 : null
    if (start != null) {
      const at = zonedTimeMs(ymd, start)
      if (at > afterMs) return { date: ymd, at, minutes: start }
    } else if (hours.kind === 'unknown' && day > 0) {
      return { date: ymd, at: null, minutes: null }
    }
  }
  return null
}

// The window around `now` and the opening after it: after this window closes
// while the hall is open, after `now` otherwise.
function openings(snapshot, location, now) {
  const window = serviceWindow(location, snapshot.date, minutesInZone(now, CAMPUS_TIME_ZONE))
  const after = location.is_open === true && window ? window.closes : now.getTime()
  return { window, next: findNextOpening(location, snapshot.date, after) }
}

/**
 * The widget's answer for one hall from today's snapshot at `now`:
 * `snapshot` as getDiningSnapshot returns it and `location` one of its
 * locations. `nextLocation` is the same hall in the snapshot for the date of
 * the next opening, when that is another day; its first meal and dishes are
 * left empty without it.
 */
export function buildDiningToday(snapshot, location, now, { nextLocation = null } = {}) {
  const today = snapshot.date
  const { window, next } = openings(snapshot, location, now)

  // Today's meals, cut to today's hours. Without listed times the day's ends
  // are not known, so the first meal has no start and the last no end.
  const hours = dayHours(location, today)
  const known = hours.kind === 'hours' || hours.kind === 'allDay'
  const [dayOpen, dayClose] = hours.kind === 'hours' ? [hours.start, hours.end < hours.start ? DAY_MINUTES : hours.end] : [0, DAY_MINUTES]
  const instant = (minutes, edge) => (minutes == null || (!known && minutes === edge) ? null : isoSeconds(zonedTimeMs(today, minutes)))
  const menus = location.menus ?? []
  const meals = mealStretches(menus.map((menu) => menu.meal), dayOpen, dayClose).map(({ meal, from, until }) => ({
    meal,
    from: instant(from, 0),
    until: instant(until, DAY_MINUTES),
    headliners: headlinersOf(menus.find((menu) => menu.meal === meal)),
  }))

  let nextOpening = null
  if (next) {
    const nextMenus = (next.date === today ? location : nextLocation)?.menus ?? []
    const meal = chooseMeal(nextMenus.map((menu) => menu.meal), mealsAtMinutes(next.minutes ?? 0))
    nextOpening = {
      date: next.date,
      at: next.at == null ? null : isoSeconds(next.at),
      meal,
      headliners: meal ? headlinersOf(nextMenus.find((menu) => menu.meal === meal)) : [],
    }
  }

  return {
    date: today,
    hall: { slug: location.slug, name: location.name, kind: location.kind },
    open: location.is_open ?? null,
    opensAt: window ? isoSeconds(window.opens) : null,
    closesAt: window ? isoSeconds(window.closes) : null,
    nextOpening,
    meals,
  }
}

/**
 * GET /api/dining/today's work for a tidied `hall`: { today } with the
 * answer, { today: null } for a hall the snapshot does not list, or
 * { unavailable: true } when there is no good snapshot to build from. Reads
 * today's snapshot, and the next opening's date too when that is another day
 * (the date's snapshot is cached like any other; a failure there only leaves
 * the next meal out).
 */
export async function getDiningToday(hall, { getDiningSnapshot, now = new Date() }) {
  const snapshot = await getDiningSnapshot({})
  if (!snapshot?.ok) return { unavailable: true }
  const location = findHall(snapshot.locations, hall)
  if (!location) return { today: null }

  const { next } = openings(snapshot, location, now)
  let nextLocation = null
  if (next && next.date !== snapshot.date) {
    try {
      const other = await getDiningSnapshot({ date: next.date })
      nextLocation = other?.ok ? findHall(other.locations, location.slug) : null
    } catch (error) {
      console.warn(`[dining] next opening menu for ${next.date} unavailable:`, error?.message || error)
    }
  }
  return { today: buildDiningToday(snapshot, location, now, { nextLocation }) }
}
