import { test } from 'node:test'
import assert from 'node:assert/strict'
import ical from 'node-ical'

import { DEMO_CALENDAR_FILES, buildDemoCalendar, demoCalendarFileOf, matchDemoCalendarUrl } from '../src/demoCalendars.mjs'
import { planSync } from '../src/scheduleSync.mjs'

// Issue #521: the demo calendars for the App Review account. A link counts
// only on its exact path on one of the server's origins; the feeds read like
// the real Purdue Timetabling and Brightspace exports once node-ical and
// planSync are through with them; and whenever someone looks, there is a
// class this week and something due within seven days. planSync expands
// weekly classes around the real clock, so each parse runs under a fake one.

const TZ = 'America/Indiana/Indianapolis'
const SITE = 'https://www.boilerindy.app'
const API = 'https://boilerindy-api.onrender.com'
const ORIGINS = [SITE, API]
const PURDUE = `${SITE}/api/demo/calendars/purdue-timetable.ics`
const BRIGHTSPACE = `${SITE}/api/demo/calendars/brightspace.ics`
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ── Indianapolis days in the test's own terms ──────────────────────────────

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** The Indianapolis day ('2026-10-27'), weekday ('Tue') and time ('09:30') of an instant. */
function local(instant) {
  const p = Object.fromEntries(wallClock.formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, time: `${p.hour}:${p.minute}` }
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const shiftDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
/** The Indianapolis day of the Monday that starts the week of an instant. */
const mondayOf = (instant) => shiftDay(local(instant).day, -WEEKDAYS.indexOf(local(instant).weekday))

async function syncDemo(file, now) {
  const text = buildDemoCalendar(file, { now: new Date(now) })
  const parsed = await ical.async.parseICS(text)
  const sourceType = file === 'brightspace.ics' ? 'brightspace_ical' : 'purdue_schedule_ical'
  const plan = planSync(parsed, { id: 'demo-source', user_id: 'demo-user', source_type: sourceType, source_url: `${SITE}/api/demo/calendars/${file}` })
  return { text, plan }
}

// The cheap read for the sweep below: each VEVENT's properties by name.
function vevents(text) {
  return text
    .split('BEGIN:VEVENT\r\n')
    .slice(1)
    .map((block) => Object.fromEntries(block.split('\r\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)])))
}
const utcInstant = (stamp) => Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))

// ── The links ───────────────────────────────────────────────────────────────

test('a demo link counts only as its exact path on one of the server origins', () => {
  assert.deepEqual(matchDemoCalendarUrl(PURDUE, ORIGINS), { file: 'purdue-timetable.ics', sourceType: 'purdue_schedule_ical', url: PURDUE })
  assert.deepEqual(matchDemoCalendarUrl(`  ${API}/api/demo/calendars/brightspace.ics  `, ORIGINS), {
    file: 'brightspace.ics',
    sourceType: 'brightspace_ical',
    url: `${API}/api/demo/calendars/brightspace.ics`,
  })
  // The same origin spelled with its default port is stored without it.
  assert.equal(matchDemoCalendarUrl('https://www.boilerindy.app:443/api/demo/calendars/brightspace.ics', ORIGINS)?.url, BRIGHTSPACE)
  // An origin that is not a URL is skipped, not fatal.
  assert.equal(matchDemoCalendarUrl(PURDUE, ['not a url', SITE])?.file, 'purdue-timetable.ics')

  for (const link of [
    'https://example.com/api/demo/calendars/brightspace.ics',
    'https://www.boilerindy.app.example.com/api/demo/calendars/brightspace.ics',
    'https://purdue.brightspace.com/api/demo/calendars/brightspace.ics',
    'https://boilerindy.app/api/demo/calendars/brightspace.ics',
    'http://www.boilerindy.app/api/demo/calendars/brightspace.ics',
    'https://www.boilerindy.app:8443/api/demo/calendars/brightspace.ics',
    'webcal://www.boilerindy.app/api/demo/calendars/brightspace.ics',
    'https://student:secret@www.boilerindy.app/api/demo/calendars/brightspace.ics',
    `${BRIGHTSPACE}?token=1`,
    `${BRIGHTSPACE}#week-9`,
    `${BRIGHTSPACE}/`,
    `${SITE}/api/demo/calendars/`,
    `${SITE}/api/demo/calendars/other.ics`,
    `${SITE}/api/demo/calendars/Brightspace.ics`,
    `${SITE}/api/demo/calendars/brightspace%2Eics`,
    `${SITE}/api/demo/calendars/constructor`,
    `${SITE}/api/demo/calendars/__proto__`,
    `${SITE}/API/demo/calendars/brightspace.ics`,
    `${SITE}/api/demo/brightspace.ics`,
    'not a link',
    '',
    null,
    undefined,
  ]) {
    assert.equal(matchDemoCalendarUrl(link, ORIGINS), null, String(link))
  }
  assert.equal(matchDemoCalendarUrl(PURDUE, []), null)
  assert.equal(matchDemoCalendarUrl(PURDUE), null)
})

test('a stored demo link is recognized on any origin, so no sync fetches one added under an earlier origin', () => {
  assert.equal(demoCalendarFileOf(PURDUE), 'purdue-timetable.ics')
  assert.equal(demoCalendarFileOf('https://old-site.example.com/api/demo/calendars/brightspace.ics'), 'brightspace.ics')
  assert.equal(demoCalendarFileOf('http://localhost:5173/api/demo/calendars/brightspace.ics'), 'brightspace.ics')
  for (const link of [
    'https://timetable.mypurdue.purdue.edu/Timetabling/export?x=abc123',
    'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=t',
    'ftp://www.boilerindy.app/api/demo/calendars/brightspace.ics',
    `${BRIGHTSPACE}?token=1`,
    `${BRIGHTSPACE}#week-9`,
    `${SITE}/api/demo/calendars/other.ics`,
    `${SITE}/api/demo/calendars/__proto__`,
    null,
  ]) {
    assert.equal(demoCalendarFileOf(link), null, String(link))
  }
})

test('only the two demo names build a calendar', () => {
  assert.deepEqual(DEMO_CALENDAR_FILES, ['purdue-timetable.ics', 'brightspace.ics'])
  for (const file of DEMO_CALENDAR_FILES) {
    assert.match(buildDemoCalendar(file), /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n[\s\S]*\r\nEND:VCALENDAR\r\n$/)
  }
  for (const file of ['other.ics', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(buildDemoCalendar(file), null, file)
  }
})

test('a build changes only with the Indianapolis day, in CRLF lines of at most 75 octets', () => {
  const justAfterMidnight = new Date('2026-10-27T04:00:30Z') // 12:00:30 AM EDT
  const justBeforeMidnight = new Date('2026-10-28T03:59:30Z') // 11:59:30 PM EDT
  const nextDay = new Date('2026-10-28T04:00:30Z')
  for (const file of DEMO_CALENDAR_FILES) {
    const text = buildDemoCalendar(file, { now: justAfterMidnight })
    assert.equal(buildDemoCalendar(file, { now: justBeforeMidnight }), text, file)
    assert.notEqual(buildDemoCalendar(file, { now: nextDay }), text, file)
    assert.doesNotMatch(text, /[^\r]\n/, `${file} ends every line in CRLF`)
    for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line)
  }
})

// ── The class schedule ──────────────────────────────────────────────────────

// What the timetable holds, by weekday: time, title, room. Every room is a
// building code on the app's campus map plus a room number, which is what
// the app's Directions search finds.
const TIMETABLE = {
  Mon: ['09:30 MA 16600 Lecture LDPI 108', '11:30 CS 18000 Lecture SLPI 108', '15:30 MA 16600 Recitation LDPI 129'],
  Tue: ['10:30 PHYS 17200 Lecture LE 101', '13:30 ENGL 10600 Lecture CA 331', '16:30 PHYS 17200 Recitation LDPI 214'],
  Wed: ['09:30 MA 16600 Lecture LDPI 108', '11:30 CS 18000 Lecture SLPI 108', '15:30 CS 18000 Laboratory SLPI 010'],
  Thu: ['10:30 PHYS 17200 Lecture LE 101', '13:30 ENGL 10600 Lecture CA 331', '15:00 PHYS 17200 Laboratory LDPI 236'],
  Fri: ['09:30 MA 16600 Lecture LDPI 108', '11:30 CS 18000 Lecture SLPI 108', '15:30 MA 16600 Recitation LDPI 129'],
  Sat: [],
  Sun: [],
}

test('the class schedule parses like a timetable export: the same week of classes, two weeks back to ten ahead, through daylight saving changes', async (t) => {
  const nows = [
    '2026-10-27T16:00:00Z', // Tuesday at noon
    '2026-11-01T12:00:00Z', // the Sunday EST starts: next week is on the other side of it
    '2026-12-31T23:30:00Z', // Thursday evening, the last day of the year
    '2027-03-14T15:00:00Z', // the Sunday EDT starts
  ]
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(nows[0]) })
  for (const now of nows) {
    t.mock.timers.setTime(Date.parse(now))
    const { plan } = await syncDemo('purdue-timetable.ics', now)
    assert.equal(plan.meta.timezone, TZ, now)
    assert.equal(plan.meta.rawCount, 8, `${now}: one VEVENT per section`)
    assert.equal(plan.meta.skippedCount, 0, now)
    assert.ok(plan.itemsToInsert.every((item) => item.category === 'class' && !item.all_day), `${now}: classes only`)

    const byDay = new Map()
    for (const item of plan.itemsToInsert) {
      const { day, weekday, time } = local(item.start_time)
      const ends = local(item.end_time).time
      assert.ok(ends > time, `${now}: ${item.title} ends after it starts`)
      if (!byDay.has(day)) byDay.set(day, { weekday, rows: [] })
      byDay.get(day).rows.push(`${time} ${item.title} ${item.location}`)
    }
    const monday = mondayOf(now)
    const days = Array.from({ length: 12 * 7 }, (_, i) => shiftDay(monday, i - 14))
    for (const day of days) {
      const weekday = WEEKDAYS[days.indexOf(day) % 7]
      assert.deepEqual((byDay.get(day)?.rows ?? []).sort(), [...TIMETABLE[weekday]].sort(), `${now}: ${weekday} ${day}`)
    }
    assert.deepEqual([...byDay.keys()].filter((day) => !days.includes(day)), [], `${now}: nothing outside the window`)
  }
})

test('every class names its course, a building on the campus map and the course title', async (t) => {
  const now = '2026-10-27T16:00:00Z'
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) })
  const { plan } = await syncDemo('purdue-timetable.ics', now)
  const titles = {
    'MA 16600': 'Analytic Geometry And Calculus II',
    'CS 18000': 'Problem Solving And Object-Oriented Programming',
    'PHYS 17200': 'Modern Mechanics',
    'ENGL 10600': 'First-Year Composition',
  }
  for (const item of plan.itemsToInsert) {
    // The course code the study groups and degree planner read (/\b[A-Z]{2,4}\s*\d{5}\b/).
    const code = item.title.match(/^([A-Z]{2,4} \d{5}) (Lecture|Recitation|Laboratory)$/)?.[1]
    assert.ok(code, item.title)
    assert.equal(item.description, titles[code], item.title)
    // Science Building, Engineering Science and Technology, Lecture Hall, Cavanaugh Hall.
    assert.match(item.location, /^(LDPI|SLPI|LE|CA) \d{3}$/, item.title)
  }
})

test('a class keeps its UID from one build to the next, so a re-sync updates the same row', async (t) => {
  const tuesday = '2026-10-27T16:00:00Z'
  const nextMonday = '2026-11-02T14:00:00Z'
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(tuesday) })
  const before = (await syncDemo('purdue-timetable.ics', tuesday)).plan.itemsToInsert
  t.mock.timers.setTime(Date.parse(nextMonday))
  const after = (await syncDemo('purdue-timetable.ics', nextMonday)).plan.itemsToInsert
  const afterByUid = new Map(after.map((item) => [item.external_uid, item]))
  const shared = before.filter((item) => afterByUid.has(item.external_uid))
  // The window moved a week: eleven of its twelve weeks are in both builds.
  assert.equal(shared.length, 11 * 15)
  for (const item of shared) {
    const again = afterByUid.get(item.external_uid)
    assert.deepEqual([again.title, again.start_time, again.end_time, again.location], [item.title, item.start_time, item.end_time, item.location])
  }
})

// ── The Brightspace calendar ────────────────────────────────────────────────

const TASK_CATEGORIES = new Set(['assignment', 'quiz', 'lab', 'project', 'exam'])

test('the Brightspace calendar parses like a Brightspace feed: clean titles, task categories, nothing already past', async (t) => {
  const nows = [
    '2026-10-27T16:00:00Z', // Tuesday at noon
    '2026-10-31T04:00:30Z', // 12:00:30 AM Saturday, just after Friday's homework was due
    '2026-11-01T12:00:00Z', // the Sunday EST starts
    '2027-03-14T15:00:00Z', // the Sunday EDT starts
  ]
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(nows[0]) })
  for (const now of nows) {
    t.mock.timers.setTime(Date.parse(now))
    const { text, plan } = await syncDemo('brightspace.ics', now)
    const items = plan.itemsToInsert
    assert.equal(plan.meta.skippedCount, 0, now)
    // Brightspace sends quiz availability markers; planSync drops them.
    assert.match(text, /- Availability Starts\r\n/, now)
    const categories = new Set(items.map((item) => item.category))
    assert.ok([...categories].every((category) => TASK_CATEGORIES.has(category)), `${now}: ${[...categories]}`)
    for (const category of ['assignment', 'quiz', 'lab', 'project']) assert.ok(categories.has(category), `${now}: a ${category}`)
    for (const item of items) {
      assert.match(item.title, /^(Homework|Lab|Lab Report|Quiz|Project|Essay|Reading Response|Exam) \d+ - (MA 16600|CS 18000|PHYS 17200|ENGL 10600)$/, item.title)
      assert.ok(local(item.start_time).day >= local(now).day, `${now}: ${item.title} is not from an earlier day`)
    }
    const dueSoon = items.filter((item) => Date.parse(item.start_time) > Date.parse(now) && Date.parse(item.start_time) <= Date.parse(now) + 7 * DAY)
    assert.ok(dueSoon.length >= 3, `${now}: ${dueSoon.length} due within seven days`)
    // Homework every Friday at 11:59 PM, and a project within four weeks.
    const fridays = items.filter((item) => item.title.startsWith('Homework '))
    assert.ok(fridays.length >= 9, now)
    for (const item of fridays) assert.deepEqual([local(item.start_time).weekday, local(item.start_time).time], ['Fri', '23:59'], item.title)
    assert.ok(items.some((item) => item.category === 'project' && Date.parse(item.start_time) <= Date.parse(now) + 28 * DAY), `${now}: a project ahead`)
    // Two evening exams a term, so a ten-week window can miss both.
    for (const exam of items.filter((item) => item.category === 'exam')) {
      assert.deepEqual([local(exam.start_time).weekday, local(exam.start_time).time, local(exam.end_time).time, exam.location], ['Thu', '18:30', '19:30', 'LE 101'])
    }
  }
  t.mock.timers.setTime(Date.parse(nows[0]))
  const { plan } = await syncDemo('brightspace.ics', nows[0])
  assert.ok(plan.itemsToInsert.some((item) => item.category === 'exam'), 'an exam in late October 2026')
})

test('coursework keeps its UID, title and due time from one day to the next', async (t) => {
  const tuesday = '2026-10-27T16:00:00Z'
  const thursday = '2026-10-29T16:00:00Z'
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(tuesday) })
  const before = (await syncDemo('brightspace.ics', tuesday)).plan.itemsToInsert
  t.mock.timers.setTime(Date.parse(thursday))
  const after = (await syncDemo('brightspace.ics', thursday)).plan.itemsToInsert
  const beforeByUid = new Map(before.map((item) => [item.external_uid, item]))
  // Wednesday's lab is gone (past), and nothing new has come into the window.
  assert.deepEqual(
    before.filter((item) => !after.some((next) => next.external_uid === item.external_uid)).map((item) => item.title),
    ['Lab 10 - CS 18000'],
  )
  for (const item of after) {
    const earlier = beforeByUid.get(item.external_uid)
    assert.ok(earlier, item.title)
    assert.deepEqual([item.title, item.start_time, item.category], [earlier.title, earlier.start_time, earlier.category])
  }
})

// ── Always something to show ────────────────────────────────────────────────

test('at any hour of the year there are classes this week and something due within seven days', () => {
  const nows = []
  // Every 13 hours for a year: 13 shares no factor with the 168 hours of a
  // week, so the steps land on every hour of every weekday.
  for (let at = Date.parse('2026-10-01T00:00:00Z'); at < Date.parse('2027-10-01T00:00:00Z'); at += 13 * HOUR) nows.push(at)
  nows.push(
    Date.parse('2026-10-31T03:59:30Z'), // 11:59:30 PM Friday, just after the homework was due
    Date.parse('2026-11-01T04:59:30Z'), // 11:59:30 PM Saturday
    Date.parse('2026-11-02T04:59:30Z'), // 11:59:30 PM Sunday
    Date.parse('2026-11-01T05:59:00Z'), // a minute before EST starts
    Date.parse('2026-11-01T06:01:00Z'), // a minute after
    Date.parse('2027-03-14T06:59:00Z'), // a minute before EDT starts
    Date.parse('2027-03-14T07:01:00Z'), // a minute after
  )
  for (const now of nows) {
    const monday = mondayOf(now).replaceAll('-', '')
    const friday = shiftDay(mondayOf(now), 4).replaceAll('-', '')
    const nextMonday = shiftDay(mondayOf(now), 7).replaceAll('-', '')
    for (const section of vevents(buildDemoCalendar('purdue-timetable.ics', { now: new Date(now) }))) {
      const first = section[`DTSTART;TZID=${TZ}`].slice(0, 8)
      const until = section.RRULE.match(/UNTIL=(\d{8})T/)[1]
      assert.ok(first <= monday && until >= nextMonday, `${new Date(now).toISOString()}: ${section.SUMMARY} meets this week`)
      assert.ok(first <= friday)
    }
    const due = vevents(buildDemoCalendar('brightspace.ics', { now: new Date(now) }))
      .filter((event) => !event.SUMMARY.includes('Availability'))
      .map((event) => utcInstant(event.DTSTART))
    assert.ok(due.some((at) => at > now && at <= now + 7 * DAY), `${new Date(now).toISOString()}: something is due within seven days`)
  }
})
