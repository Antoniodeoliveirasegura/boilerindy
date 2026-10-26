// demoCalendars.mjs
//
// Two made-up calendars for the account Apple's reviewers sign in with (issue
// #521): a Purdue Timetabling class schedule and a Brightspace calendar.
// Calendars come in as pasted iCal links, and the server fetches a link only
// from its provider's hosts (SCHEDULE_SOURCE_HOSTS in src/routes/sources.mjs),
// its one guard against server-side request forgery once a URL passes
// assertSafeHttpUrl. So the demo links sit on BoilerIndy's own origin
// instead, and the sources routes and the hourly re-sync build their feeds
// here rather than fetching them:
//
//   <origin>/api/demo/calendars/purdue-timetable.ics
//   <origin>/api/demo/calendars/brightspace.ics
//
// Nothing goes out on the network and the allowlist stays as it is. The same
// paths answer GET with the same text, so a link also opens in a browser.
//
// Pure: the clock comes in as `now`, and two builds on the same Indianapolis
// day are identical. Both feeds follow one fixed weekly pattern, so an item
// keeps its date, title and UID from one build to the next: a re-sync updates
// the same rows, and a task marked done stays done.
//
// - Classes: the redesign's four demo courses on every weekday, from the
//   Monday two weeks before this week to the Monday ten weeks after it. One
//   VEVENT per section with a weekly RRULE and wall-clock times under a
//   VTIMEZONE, the timetable export's shape (test/scheduleSyncParse.test.mjs).
// - Coursework: what is due from the start of today to that same Monday, as
//   "<item> - <course> - Due" in UTC like Brightspace's feed, with homework
//   every Friday at 11:59 PM, so something is always due within a week. Past
//   work is left out: the app lists unfinished past work as Overdue, and
//   nobody ticks off the demo's. The re-sync sweeps an item once its day ends.

import { escapeIcsText, foldLine, formatIcsUtc } from './icsFeed.mjs'

const DEMO_CALENDAR_PATH = '/api/demo/calendars/'
const TIME_ZONE = 'America/Indiana/Indianapolis'
const UID_DOMAIN = 'demo.boilerindy.app'
const DAY_MS = 24 * 60 * 60 * 1000
const WEEKS_BACK = 2
const WEEKS_AHEAD = 10
const DUE_AT = [23, 59]

// Numbers such as Homework 10 count the weeks of a 16-week term from Monday
// 24 August 2026, and start again after week 16.
const TERM_START = Date.UTC(2026, 7, 24)
const TERM_WEEKS = 16

// ── Indianapolis time ───────────────────────────────────────────────────────
// A wall-clock time is held as the UTC fields of a Date (a "civil" time), so
// adding days to one never meets a daylight saving change.

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** The Indianapolis wall clock at an instant, as a civil time. */
function civilAt(instant) {
  const part = Object.fromEntries(wallClock.formatToParts(instant).map((p) => [p.type, Number(p.value)]))
  return new Date(Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second))
}

/** The instant at which the Indianapolis wall clock reads a civil time. */
function instantAt(civil) {
  let guess = civil.getTime()
  // Twice: the second pass settles a guess that crossed a daylight saving change.
  for (let pass = 0; pass < 2; pass += 1) guess += civil.getTime() - civilAt(new Date(guess)).getTime()
  return new Date(guess)
}

const addDays = (civil, days) => new Date(civil.getTime() + days * DAY_MS)
const atTime = (day, [hour, minute]) => new Date(day.getTime() + (hour * 60 + minute) * 60 * 1000)
const dayOf = (civil) => new Date(Date.UTC(civil.getUTCFullYear(), civil.getUTCMonth(), civil.getUTCDate()))
// getUTCDay counts from Sunday; the weeks here start on Monday.
const mondayOf = (civil) => addDays(dayOf(civil), -((civil.getUTCDay() + 6) % 7))

/** A civil time as a TZID value, 20261030T093000. */
const wallStamp = (civil) => formatIcsUtc(civil).slice(0, -1)

/** Week 0 to 15 of the demo term for the Monday that starts it. */
function termWeek(monday) {
  const weeks = Math.round((monday.getTime() - TERM_START) / (7 * DAY_MS))
  return ((weeks % TERM_WEEKS) + TERM_WEEKS) % TERM_WEEKS
}

// ── iCalendar text ──────────────────────────────────────────────────────────

const prop = (name, value) => foldLine(`${name}:${value}`)

function calendarText(name, header, events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    prop('PRODID', `-//BoilerIndy//${name}//EN`),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    prop('X-WR-CALNAME', escapeIcsText(name)),
    ...header,
    ...events.flat(),
    'END:VCALENDAR',
  ]
  return lines.join('\r\n') + '\r\n'
}

// America/Indiana/Indianapolis since 2007: EDT from the second Sunday in March,
// EST from the first Sunday in November.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${TIME_ZONE}`,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
]

// ── The class schedule ──────────────────────────────────────────────────────

const MA = { code: 'MA 16600', title: 'Analytic Geometry And Calculus II' }
const CS = { code: 'CS 18000', title: 'Problem Solving And Object-Oriented Programming' }
const PHYS = { code: 'PHYS 17200', title: 'Modern Mechanics' }
const ENGL = { code: 'ENGL 10600', title: 'First-Year Composition' }

const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

// Days in week order, Indianapolis wall-clock times. A room is a building
// code on the app's campus map and a room number, which is what its
// Directions search finds: Purdue's code where the map has one, IU's for
// Lecture Hall and Cavanaugh Hall.
const SECTIONS = [
  { id: 'ma16600-lecture', course: MA, kind: 'Lecture', days: ['MO', 'WE', 'FR'], start: [9, 30], end: [10, 20], room: 'LDPI 108' },
  { id: 'ma16600-recitation', course: MA, kind: 'Recitation', days: ['MO', 'FR'], start: [15, 30], end: [16, 20], room: 'LDPI 129' },
  { id: 'cs18000-lecture', course: CS, kind: 'Lecture', days: ['MO', 'WE', 'FR'], start: [11, 30], end: [12, 20], room: 'SLPI 108' },
  { id: 'cs18000-laboratory', course: CS, kind: 'Laboratory', days: ['WE'], start: [15, 30], end: [17, 20], room: 'SLPI 010' },
  { id: 'phys17200-lecture', course: PHYS, kind: 'Lecture', days: ['TU', 'TH'], start: [10, 30], end: [11, 45], room: 'LE 101' },
  { id: 'phys17200-recitation', course: PHYS, kind: 'Recitation', days: ['TU'], start: [16, 30], end: [17, 20], room: 'LDPI 214' },
  { id: 'phys17200-laboratory', course: PHYS, kind: 'Laboratory', days: ['TH'], start: [15, 0], end: [16, 50], room: 'LDPI 236' },
  { id: 'engl10600-lecture', course: ENGL, kind: 'Lecture', days: ['TU', 'TH'], start: [13, 30], end: [14, 45], room: 'CA 331' },
]

function purdueTimetable(now) {
  const today = dayOf(civilAt(now))
  const from = addDays(mondayOf(today), -7 * WEEKS_BACK)
  const until = addDays(mondayOf(today), 7 * WEEKS_AHEAD)
  const stamp = formatIcsUtc(instantAt(today))
  // UNTIL is in UTC when DTSTART carries a TZID (RFC 5545 §3.3.10).
  const lastSecond = formatIcsUtc(new Date(instantAt(until).getTime() - 1000))
  const events = SECTIONS.map((section) => {
    const first = addDays(from, BYDAY.indexOf(section.days[0]))
    return [
      'BEGIN:VEVENT',
      prop('UID', `${section.id}@${UID_DOMAIN}`),
      prop('DTSTAMP', stamp),
      prop(`DTSTART;TZID=${TIME_ZONE}`, wallStamp(atTime(first, section.start))),
      prop(`DTEND;TZID=${TIME_ZONE}`, wallStamp(atTime(first, section.end))),
      prop('RRULE', `FREQ=WEEKLY;UNTIL=${lastSecond};BYDAY=${section.days.join(',')}`),
      prop('SUMMARY', escapeIcsText(`${section.course.code} ${section.kind}`)),
      prop('DESCRIPTION', escapeIcsText(section.course.title)),
      prop('LOCATION', escapeIcsText(section.room)),
      'STATUS:CONFIRMED',
      'END:VEVENT',
    ]
  })
  return calendarText('Demo class schedule', [prop('X-WR-TIMEZONE', TIME_ZONE), ...VTIMEZONE], events)
}

// ── The Brightspace calendar ────────────────────────────────────────────────

// Week `t` of the term (0 to 15): each item's day (0 is Monday, so -1 is the
// Sunday before), its title, and its time when it is not 11:59 PM. A quiz's
// "Availability Starts" marker is in the feed as Brightspace sends it, and
// planSync drops it.
function courseworkOfWeek(t) {
  const n = t + 1
  const half = Math.floor(t / 2) + 1
  const items = [
    { id: 'cs18000-lab', day: 2, summary: `Lab ${n} - CS 18000 - Due` },
    { id: 'ma16600-homework', day: 4, summary: `Homework ${n} - MA 16600 - Due` },
    { id: 'engl10600-response', day: 6, summary: `Reading Response ${n} - ENGL 10600 - Due` },
  ]
  if (t % 2 === 0) {
    items.push(
      { id: 'phys17200-quiz-opens', day: 0, at: [8, 0], summary: `Quiz ${half} - PHYS 17200 - Availability Starts` },
      { id: 'phys17200-quiz', day: 1, summary: `Quiz ${half} - PHYS 17200 - Due` },
    )
  } else {
    items.push(
      { id: 'cs18000-quiz-opens', day: -1, at: [8, 0], summary: `Quiz ${half} - CS 18000 - Availability Starts` },
      { id: 'cs18000-quiz', day: 0, summary: `Quiz ${half} - CS 18000 - Due` },
      { id: 'phys17200-lab-report', day: 3, summary: `Lab Report ${half} - PHYS 17200 - Due` },
    )
  }
  if (t % 4 === 1) items.push({ id: 'engl10600-essay', day: 6, summary: `Essay ${(t + 3) / 4} - ENGL 10600 - Due` })
  if (t % 4 === 3) items.push({ id: 'cs18000-project', day: 4, summary: `Project ${(t + 1) / 4} - CS 18000 - Due` })
  // Weeks 7 and 13: an evening exam, clear of Thanksgiving in fall 2026.
  if (t === 6 || t === 12) {
    items.push({ id: 'phys17200-exam', day: 3, at: [18, 30], ends: [19, 30], summary: `Exam ${t / 6} - PHYS 17200`, location: 'LE 101' })
  }
  return items
}

function brightspaceCalendar(now) {
  const today = dayOf(civilAt(now))
  const monday = mondayOf(today)
  const until = addDays(monday, 7 * WEEKS_AHEAD)
  const stamp = formatIcsUtc(instantAt(today))
  const events = []
  for (let week = 0; week < WEEKS_AHEAD; week += 1) {
    const weekStart = addDays(monday, 7 * week)
    for (const item of courseworkOfWeek(termWeek(weekStart))) {
      const day = addDays(weekStart, item.day)
      const start = atTime(day, item.at ?? DUE_AT)
      if (start.getTime() < today.getTime() || start.getTime() >= until.getTime()) continue
      events.push([
        'BEGIN:VEVENT',
        prop('UID', `${item.id}-${wallStamp(day).slice(0, 8)}@${UID_DOMAIN}`),
        prop('DTSTAMP', stamp),
        prop('DTSTART', formatIcsUtc(instantAt(start))),
        prop('DTEND', formatIcsUtc(instantAt(item.ends ? atTime(day, item.ends) : start))),
        prop('SUMMARY', escapeIcsText(item.summary)),
        ...(item.location ? [prop('LOCATION', escapeIcsText(item.location))] : []),
        'END:VEVENT',
      ])
    }
  }
  return calendarText('Demo Brightspace calendar', [], events)
}

// ── Links ───────────────────────────────────────────────────────────────────

const CALENDARS = new Map([
  ['purdue-timetable.ics', { sourceType: 'purdue_schedule_ical', build: purdueTimetable }],
  ['brightspace.ics', { sourceType: 'brightspace_ical', build: brightspaceCalendar }],
])

export const DEMO_CALENDAR_FILES = [...CALENDARS.keys()]

function originOf(value) {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

// A link of the demo form: http or https, one of the exact paths, no query,
// fragment or credentials.
function demoLink(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl ?? '').trim())
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) return null
  const file = url.pathname.startsWith(DEMO_CALENDAR_PATH) ? url.pathname.slice(DEMO_CALENDAR_PATH.length) : null
  return CALENDARS.has(file) ? { url, file } : null
}

/**
 * The demo calendar a pasted link names, or null. Only the exact paths on one
 * of `origins` count (server.mjs hands in CLIENT_APP_URL and
 * BACKEND_PUBLIC_URL), so no other link gets past the provider allowlist this
 * way.
 *
 * @param {string}   rawUrl
 * @param {string[]} origins
 * @returns {{ file: string, sourceType: string, url: string } | null} `url` is
 *   the link as a source stores it
 */
export function matchDemoCalendarUrl(rawUrl, origins = []) {
  const link = demoLink(rawUrl)
  if (!link || !origins.some((origin) => originOf(origin) === link.url.origin)) return null
  return { file: link.file, sourceType: CALENDARS.get(link.file).sourceType, url: link.url.origin + link.url.pathname }
}

/**
 * The demo calendar a stored source link names, on any origin, or null. A sync
 * goes by this, so a source added under an earlier CLIENT_APP_URL is still
 * built here and never fetched. No provider's feed has these paths.
 *
 * @param {string} rawUrl
 * @returns {string | null} one of DEMO_CALENDAR_FILES
 */
export function demoCalendarFileOf(rawUrl) {
  return demoLink(rawUrl)?.file ?? null
}

/**
 * A demo calendar's iCalendar text for the Indianapolis day `now` falls on,
 * or null when `file` names none.
 *
 * @param {string} file one of DEMO_CALENDAR_FILES
 * @param {{ now?: Date }} [options]
 * @returns {string | null}
 */
export function buildDemoCalendar(file, { now = new Date() } = {}) {
  const calendar = CALENDARS.get(file)
  return calendar ? calendar.build(now) : null
}
