// Tests for the pure schedule-sync core. The interface IS the test surface:
// a parsed feed goes in, a deterministic plan comes out. No DB, no network,
// no mocks - just values.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planSync,
  classifyFetchError,
  countFeedEvents,
  expandRecurringEvents,
  detectTimezoneFromFeed,
  icalText,
  cleanTitle,
  FEED_TOO_MANY_EVENTS,
  FEED_TOO_MANY_ITEMS,
  MAX_FEED_EVENTS,
  MAX_FEED_ITEMS,
} from '../src/scheduleSync.mjs'
import { FEED_TOO_LARGE, FeedRefusedError, PROVIDER_NOT_ALLOWED } from '../src/urlSafety.mjs'

const TZ = 'America/Indiana/Indianapolis'

function purdueSource(overrides = {}) {
  return {
    id: 'src-1',
    user_id: 'user-1',
    source_type: 'purdue_schedule_ical',
    source_url: 'https://purdue.edu/feed.ics',
    ...overrides,
  }
}

function vevent(overrides = {}) {
  return {
    type: 'VEVENT',
    summary: 'CS 180 Lecture',
    start: new Date('2026-01-12T14:30:00.000Z'),
    end: new Date('2026-01-12T15:20:00.000Z'),
    location: 'LWSN B155',
    uid: 'evt-1',
    datetype: 'date-time',
    description: 'Intro to programming',
    ...overrides,
  }
}

// ── planSync: shape, identity, determinism ──────────────────────────────────

test('planSync maps a single VEVENT to one item without stamping identity', () => {
  const plan = planSync({ a: vevent() }, purdueSource())

  assert.equal(plan.itemsToInsert.length, 1)
  const item = plan.itemsToInsert[0]

  // Identity is the shell's job - the pure core must not stamp these.
  assert.equal('id' in item, false)
  assert.equal('created_at' in item, false)
  assert.equal('updated_at' in item, false)

  assert.equal(item.user_id, 'user-1')
  assert.equal(item.source_id, 'src-1')
  assert.equal(item.title, 'CS 180 Lecture')
  assert.equal(item.start_time, '2026-01-12T14:30:00.000Z')
  assert.equal(item.end_time, '2026-01-12T15:20:00.000Z')
  assert.equal(item.category, 'class') // purdue feed → always 'class'
  assert.equal(plan.sourceStatus, 'ready')
  assert.equal(plan.meta.itemCount, 1)
  assert.equal(plan.meta.rawCount, 1)
})

test('planSync is deterministic - same feed yields a deep-equal plan', () => {
  const feed = { a: vevent(), b: vevent({ uid: 'evt-2', summary: 'CS 240', start: new Date('2026-01-13T16:30:00.000Z'), end: new Date('2026-01-13T17:20:00.000Z') }) }
  const source = purdueSource()

  assert.deepEqual(planSync(feed, source), planSync(feed, source))
})

test('planSync ignores non-VEVENT entries', () => {
  const feed = {
    tz: { type: 'VTIMEZONE', tzid: TZ },
    cal: { type: 'VCALENDAR' },
    a: vevent(),
  }
  const plan = planSync(feed, purdueSource())
  assert.equal(plan.itemsToInsert.length, 1)
})

// ── planSync: empty feed preserves existing items (rawCount === 0) ───────────

test('planSync on an empty feed signals ready + warning and writes nothing', () => {
  const plan = planSync({ tz: { type: 'VTIMEZONE', tzid: TZ } }, purdueSource())

  assert.equal(plan.itemsToInsert.length, 0)
  assert.equal(plan.meta.rawCount, 0)
  assert.equal(plan.sourceStatus, 'ready')
  assert.match(plan.statusMessage, /No events found/)
  assert.match(plan.meta.warning, /No events found/)
})

// ── Categorization (non-purdue feeds) ───────────────────────────────────────

function categoryOf(summary, sourceOverrides = {}) {
  const source = purdueSource({ source_type: 'generic_ical', source_url: 'https://example.com/feed.ics', ...sourceOverrides })
  const plan = planSync({ a: vevent({ summary }) }, source)
  return plan.itemsToInsert[0]?.category
}

test('planSync categorizes academic items from the summary', () => {
  assert.equal(categoryOf('HW3 - Due'), 'assignment')
  assert.equal(categoryOf('Midterm Exam 1'), 'exam')
  assert.equal(categoryOf('Quiz 4'), 'quiz')
  assert.equal(categoryOf('Lab 2 - Due'), 'lab')
  assert.equal(categoryOf('Final Project - Due'), 'project')
  assert.equal(categoryOf('Random Meeting'), 'event')
})

test('planSync treats posted solutions as resources', () => {
  // generic feed keeps resources; the category is still computed.
  assert.equal(categoryOf('Exam 1 Solutions posted'), 'resource')
})

test('planSync classifies "- Due" items before the campus-event keywords (#121)', () => {
  // "week" / "social" used to hijack these into campus_event.
  assert.equal(categoryOf('Lab Report - Week 4 - Due'), 'lab')
  assert.equal(categoryOf('Project 2 - Week 6 - Due'), 'project')
  assert.equal(categoryOf('Homework 3 - Social Studies - Due'), 'assignment')
  assert.equal(categoryOf('Quiz 2 - Due'), 'quiz')
  // genuine campus events carry no "- Due" marker and are unaffected.
  assert.equal(categoryOf('Career Fair - Indy Tech Employers'), 'campus_event')
  assert.equal(categoryOf('Welcome Week Social'), 'campus_event')
})

test('planSync treats D2L availability markers as resources (#121)', () => {
  assert.equal(categoryOf('Homework 3 - Availability Starts'), 'resource')
  assert.equal(categoryOf('Homework 3 - Availability Ends'), 'resource')
  assert.equal(categoryOf('Quiz 1 - Available'), 'resource')
})

test('icalText coerces node-ical string, object-shaped, and empty values', () => {
  assert.equal(icalText('Plain title'), 'Plain title')
  assert.equal(icalText({ params: { LANGUAGE: 'en-US' }, val: 'Tagged title' }), 'Tagged title')
  assert.equal(icalText(null), '')
  assert.equal(icalText(undefined), '')
  // Defensive fallback for an unexpected non-string val.
  assert.equal(icalText({ params: {}, val: 42 }), '[object Object]')
})

test('planSync handles node-ical object-shaped text properties (SUMMARY;LANGUAGE=…)', () => {
  // node-ical yields { params, val } objects for properties that carry
  // parameters. The old code crashed on (event.summary || '').toLowerCase()
  // and would otherwise have stored "[object Object]".
  const source = purdueSource({ source_type: 'generic_ical', source_url: 'https://example.com/feed.ics' })
  const feed = {
    a: vevent({
      summary: { params: { LANGUAGE: 'en-US' }, val: 'Midterm Exam 1' },
      location: { params: { LANGUAGE: 'en-US' }, val: 'LWSN B155' },
      description: { params: {}, val: 'Covers chapters 1-5' },
    }),
  }
  const plan = planSync(feed, source)
  const item = plan.itemsToInsert[0]

  assert.equal(item.title, 'Midterm Exam 1')
  assert.equal(item.location, 'LWSN B155')
  assert.equal(item.description, 'Covers chapters 1-5')
  assert.equal(item.category, 'exam') // categorization must see the unwrapped string
  assert.equal(item.raw_json.summary, 'Midterm Exam 1')
})

// ── Brightspace resource skip ───────────────────────────────────────────────

test('planSync drops resource items for Brightspace feeds', () => {
  const source = purdueSource({ source_type: 'brightspace_ical', source_url: 'https://x.brightspace.com/feed.ics' })
  const feed = {
    keep: vevent({ uid: 'k', summary: 'HW1 - Due' }),
    drop: vevent({ uid: 'd', summary: 'Solutions posted', start: new Date('2026-01-14T14:30:00.000Z') }),
  }
  const plan = planSync(feed, source)

  const titles = plan.itemsToInsert.map((i) => i.title)
  assert.deepEqual(titles, ['HW1']) // "- Due" marker stripped (#121)
  assert.equal(plan.itemsToInsert[0].raw_json.summary, 'HW1 - Due')
})

test('planSync keeps only the due item from a Brightspace availability/due triple (#121)', () => {
  const source = purdueSource({ source_type: 'brightspace_ical', source_url: 'https://x.brightspace.com/feed.ics' })
  const feed = {
    starts: vevent({ uid: 's', summary: 'Homework 3 - Availability Starts', start: new Date('2026-01-12T05:00:00.000Z'), end: new Date('2026-01-12T05:00:00.000Z') }),
    ends: vevent({ uid: 'e', summary: 'Homework 3 - Availability Ends', start: new Date('2026-01-20T04:59:00.000Z'), end: new Date('2026-01-20T04:59:00.000Z') }),
    due: vevent({ uid: 'd', summary: 'Homework 3 - Due', start: new Date('2026-01-19T04:59:00.000Z'), end: new Date('2026-01-19T04:59:00.000Z') }),
  }
  const plan = planSync(feed, source)

  assert.equal(plan.itemsToInsert.length, 1)
  assert.equal(plan.itemsToInsert[0].title, 'Homework 3')
  assert.equal(plan.itemsToInsert[0].raw_json.summary, 'Homework 3 - Due')
  assert.equal(plan.itemsToInsert[0].category, 'assignment')
  assert.equal(plan.meta.itemCount, 1)
})

// ── Deduplication ───────────────────────────────────────────────────────────

test('planSync collapses true duplicates (same title/day/hour/location)', () => {
  const feed = {
    a: vevent({ uid: 'a' }),
    b: vevent({ uid: 'b' }), // identical summary/start-hour/location
  }
  const plan = planSync(feed, purdueSource())

  assert.equal(plan.itemsToInsert.length, 1)
  assert.equal(plan.meta.duplicateCount, 1)
})

test('planSync keeps same-day items at different hours (lecture + lab)', () => {
  const feed = {
    lecture: vevent({ uid: 'l', start: new Date('2026-01-12T14:30:00.000Z'), end: new Date('2026-01-12T15:20:00.000Z') }),
    lab: vevent({ uid: 'lab', start: new Date('2026-01-12T18:30:00.000Z'), end: new Date('2026-01-12T20:20:00.000Z') }),
  }
  const plan = planSync(feed, purdueSource())
  assert.equal(plan.itemsToInsert.length, 2)
})

// ── Invalid dates are dropped, not crashed on ───────────────────────────────

test('planSync drops events with an unparseable start date', () => {
  const feed = {
    good: vevent({ uid: 'g' }),
    bad: vevent({ uid: 'b', start: 'not-a-date', end: 'not-a-date', summary: 'Broken' }),
  }
  const plan = planSync(feed, purdueSource())
  const titles = plan.itemsToInsert.map((i) => i.title)
  assert.deepEqual(titles, ['CS 180 Lecture'])
})

// ── detectTimezoneFromFeed ──────────────────────────────────────────────────

test('detectTimezoneFromFeed prefers a VTIMEZONE tzid, else falls back', () => {
  assert.equal(detectTimezoneFromFeed({ tz: { type: 'VTIMEZONE', tzid: 'America/Chicago' } }), 'America/Chicago')
  assert.equal(detectTimezoneFromFeed({ a: vevent() }), TZ)
})

// ── expandRecurringEvents (fake rrule, fully deterministic) ──────────────────

test('expandRecurringEvents preserves local time across occurrences', () => {
  const fakeRrule = {
    between: () => [
      new Date(Date.UTC(2026, 0, 12, 14, 30)),
      new Date(Date.UTC(2026, 0, 19, 14, 30)),
    ],
    toString: () => 'FREQ=WEEKLY',
  }
  const events = [vevent({ rrule: fakeRrule })]

  const out = expandRecurringEvents(events, TZ)

  assert.equal(out.length, 2)
  // 14:30Z == 09:30 local (EST); each occurrence re-anchors to 09:30 local → 14:30Z.
  assert.equal(out[0].start.toISOString(), '2026-01-12T14:30:00.000Z')
  assert.equal(out[1].start.toISOString(), '2026-01-19T14:30:00.000Z')
  assert.equal(out[0].uid, 'evt-1:2026-01-12')
  assert.equal(out[0].rrule, undefined)
})

test('expandRecurringEvents passes through non-recurring events unchanged in count', () => {
  const out = expandRecurringEvents([vevent(), vevent({ uid: 'evt-2', start: new Date('2026-02-01T15:00:00.000Z') })], TZ)
  assert.equal(out.length, 2)
})

// ── classifyFetchError ──────────────────────────────────────────────────────

test('classifyFetchError maps error text to a user-facing message', () => {
  assert.match(classifyFetchError(new Error('Request failed with status 404')).message, /not found/i)
  assert.match(classifyFetchError(new Error('401 Unauthorized')).message, /access denied/i)
  assert.match(classifyFetchError(new Error('getaddrinfo ENOTFOUND host')).message, /could not reach/i)
  assert.equal(classifyFetchError(new Error('weird')).message, 'Could not fetch the calendar feed.')
  assert.equal(classifyFetchError(new Error('weird')).status, 'error')
})

// ── Title cleanup (#121) ────────────────────────────────────────────────────

test('cleanTitle strips the D2L trailing status markers and nothing else', () => {
  assert.equal(cleanTitle('Homework 5 - ENGR 13300 - Due'), 'Homework 5 - ENGR 13300')
  assert.equal(cleanTitle('Quiz 2 - Availability Ends'), 'Quiz 2')
  assert.equal(cleanTitle('Homework 3 - Availability Starts'), 'Homework 3')
  assert.equal(cleanTitle('Lab 1 - available'), 'Lab 1')
  assert.equal(cleanTitle('HW1 - Due - Due'), 'HW1')
  // Whitespace is normalised; the course code and bracket prefix are kept
  // until real feed samples (Step 0) say otherwise.
  assert.equal(cleanTitle('  Project   2  '), 'Project 2')
  assert.equal(cleanTitle('[CS 18000] Project 2 - Due'), '[CS 18000] Project 2')
  // Not markers: no " - " separator, or the word inside the title.
  assert.equal(cleanTitle('CS 180 Lecture'), 'CS 180 Lecture')
  assert.equal(cleanTitle('Reading due Friday'), 'Reading due Friday')
  assert.equal(cleanTitle('Due'), 'Due')
  // A title that is only a marker falls back to the raw summary.
  assert.equal(cleanTitle('- Due'), '- Due')
  assert.equal(cleanTitle(null), '')
})

test('planSync stores the cleaned title but classifies and dedupes on the raw summary (#121)', () => {
  const source = purdueSource({ source_type: 'brightspace_ical', source_url: 'https://x.brightspace.com/feed.ics' })
  const feed = {
    lab: vevent({ uid: 'l', summary: 'Lab Report - Week 4 - Due', start: new Date('2026-01-19T04:59:00.000Z'), end: new Date('2026-01-19T04:59:00.000Z') }),
    labDup: vevent({ uid: 'l2', summary: 'Lab Report - Week 4 - Due', start: new Date('2026-01-19T04:59:00.000Z'), end: new Date('2026-01-19T04:59:00.000Z') }),
    quiz: vevent({ uid: 'q', summary: 'Quiz 2 - ENGR 13300 - Due', start: new Date('2026-01-21T04:59:00.000Z'), end: new Date('2026-01-21T04:59:00.000Z') }),
  }
  const plan = planSync(feed, source)

  assert.deepEqual(
    plan.itemsToInsert.map((i) => [i.title, i.category, i.raw_json.summary]),
    [
      ['Lab Report - Week 4', 'lab', 'Lab Report - Week 4 - Due'],
      ['Quiz 2 - ENGR 13300', 'quiz', 'Quiz 2 - ENGR 13300 - Due'],
    ],
  )
  assert.equal(plan.meta.duplicateCount, 1)
})

test('planSync leaves Purdue class titles untouched (#121)', () => {
  const plan = planSync({ a: vevent({ summary: 'CS 180 Lecture' }) }, purdueSource())
  assert.equal(plan.itemsToInsert[0].title, 'CS 180 Lecture')
})

// ── Import limits ───────────────────────────────────────────────────────────

// A rule with one occurrence a day for `days` days, counting its expansions.
function dailyRule(days, counter) {
  return {
    options: { freq: 'DAILY', byHour: [9], byMinute: [30] },
    between: () => {
      counter.calls += 1
      return Array.from({ length: days }, (_, i) => new Date(Date.UTC(2026, 0, 12 + i, 14, 30)))
    },
  }
}

test('countFeedEvents counts VEVENT begin lines only', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'SUMMARY:one', 'END:VEVENT',
    'begin:vevent', 'SUMMARY:two', 'END:VEVENT',
    'BEGIN:VTODO', 'END:VTODO',
    // A trailing space still counts; text that only mentions it, inline or on
    // a folded line, does not.
    'BEGIN:VEVENT ', 'DESCRIPTION:BEGIN:VEVENT', ' BEGIN:VEVENT', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n')
  assert.equal(countFeedEvents(text), 3)
  assert.equal(countFeedEvents(text.replaceAll('\r\n', '\n')), 3)
  assert.equal(countFeedEvents(''), 0)
  assert.equal(countFeedEvents(null), 0)
  assert.equal(MAX_FEED_EVENTS, 5000)
  assert.match(FEED_TOO_MANY_EVENTS, /more than 5,000 events/)
})

test('planSync refuses a feed whose events repeat into more than 5,000 items, and stops expanding past the limit', () => {
  assert.equal(MAX_FEED_ITEMS, 5000)
  const counter = { calls: 0 }
  const feed = (events) =>
    Object.fromEntries(
      Array.from({ length: events }, (_, i) => [`e${i}`, vevent({ uid: `evt-${i}`, summary: `Daily ${i}`, rrule: dailyRule(600, counter) })]),
    )

  // 8 rules of 600 days: 4,800 items, under the limit.
  const under = planSync(feed(8), purdueSource())
  assert.equal(under.sourceStatus, 'ready')
  assert.equal(under.itemsToInsert.length, 4800)

  // 20 rules of 600 days would be 12,000. Expansion stops inside the ninth
  // rule, at the 5,001st occurrence, and the plan writes nothing.
  counter.calls = 0
  const over = planSync(feed(20), purdueSource())
  assert.equal(counter.calls, 9)
  assert.equal(over.sourceStatus, 'error')
  assert.equal(over.statusMessage, FEED_TOO_MANY_ITEMS)
  assert.deepEqual(over.itemsToInsert, [])
  assert.equal(over.meta.rawCount, 20)
  assert.equal(over.meta.itemCount, 0)
})

test('a rule that repeats within a day keeps its first occurrence and is never expanded', () => {
  for (const options of [
    { freq: 'HOURLY' },
    { freq: 'MINUTELY' },
    { freq: 'SECONDLY' },
    { freq: 'DAILY', byHour: [1, 2] },
    { freq: 'WEEKLY', byMinute: [0, 30] },
    { freq: 'DAILY', bySecond: [0, 1] },
  ]) {
    let calls = 0
    const rrule = { options, between: () => { calls += 1; return [] } }
    const out = expandRecurringEvents([vevent({ rrule })], TZ)
    assert.equal(calls, 0, JSON.stringify(options))
    assert.deepEqual(out.map((e) => [e.uid, e.start.toISOString()]), [['evt-1', '2026-01-12T14:30:00.000Z']], JSON.stringify(options))
  }
  // One time a day, or no options to read, expands as before.
  for (const options of [{ freq: 'DAILY', byHour: [9], byMinute: [30] }, undefined]) {
    const counter = { calls: 0 }
    const rrule = { ...dailyRule(3, counter), options }
    assert.equal(expandRecurringEvents([vevent({ rrule })], TZ).length, 3)
    assert.equal(counter.calls, 1)
  }
})

test('raw_json keeps the same text limits as the columns', () => {
  const plan = planSync(
    { a: vevent({ uid: 'u'.repeat(900), summary: 's'.repeat(900), description: 'd'.repeat(20000), location: 'l'.repeat(900) }) },
    purdueSource(),
  )
  const [item] = plan.itemsToInsert
  assert.deepEqual(
    Object.fromEntries(Object.entries(item.raw_json).map(([key, text]) => [key, text.length])),
    { uid: 500, summary: 500, description: 5000, location: 500 },
  )
  assert.equal(item.description.length, 5000)
  assert.equal(item.external_uid.length, 500)
  // Text within the limits is kept as it was, so a stored row still compares unchanged.
  assert.deepEqual(planSync({ a: vevent() }, purdueSource()).itemsToInsert[0].raw_json, {
    uid: 'evt-1',
    summary: 'CS 180 Lecture',
    description: 'Intro to programming',
    location: 'LWSN B155',
  })
})

test("classifyFetchError keeps the message of the server's own refusals", () => {
  for (const message of [FEED_TOO_LARGE, FEED_TOO_MANY_EVENTS, PROVIDER_NOT_ALLOWED]) {
    assert.deepEqual(classifyFetchError(new FeedRefusedError(message)), { status: 'error', message })
  }
  // Any other error reads as before, even one with the same words.
  assert.equal(classifyFetchError(new Error(FEED_TOO_LARGE)).message, 'Could not fetch the calendar feed.')
})
