// Tests for the pure schedule-sync core. The interface IS the test surface:
// a parsed feed goes in, a deterministic plan comes out. No DB, no network,
// no mocks - just values.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planSync,
  classifyFetchError,
  expandRecurringEvents,
  detectTimezoneFromFeed,
  icalText,
} from '../src/scheduleSync.mjs'

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
  assert.deepEqual(titles, ['HW1 - Due'])
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
