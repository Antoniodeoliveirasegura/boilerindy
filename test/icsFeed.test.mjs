// Tests for the pure ICS feed generator (issue #48). The interface IS the test
// surface: event descriptors go in, an RFC 5545 string comes out. No DB, no
// network — just values and string assertions on the escaping/folding rules.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  escapeIcsText,
  foldLine,
  formatIcsUtc,
  formatIcsDate,
  buildCalendarFeed,
} from '../src/icsFeed.mjs'

// ── escapeIcsText ────────────────────────────────────────────────────────────

test('escapeIcsText escapes commas, semicolons, and backslashes', () => {
  assert.equal(escapeIcsText('CS 180, Lab; review'), 'CS 180\\, Lab\\; review')
  assert.equal(escapeIcsText('path\\to\\thing'), 'path\\\\to\\\\thing')
})

test('escapeIcsText turns newlines into literal \\n', () => {
  assert.equal(escapeIcsText('line one\nline two'), 'line one\\nline two')
  assert.equal(escapeIcsText('crlf\r\nhere'), 'crlf\\nhere')
})

test('escapeIcsText leaves colons and unicode intact', () => {
  assert.equal(escapeIcsText('Office hours: 3pm — café ☕'), 'Office hours: 3pm — café ☕')
})

test('escapeIcsText handles null and undefined as empty string', () => {
  assert.equal(escapeIcsText(null), '')
  assert.equal(escapeIcsText(undefined), '')
})

// ── foldLine ─────────────────────────────────────────────────────────────────

test('foldLine leaves short lines untouched', () => {
  assert.equal(foldLine('SUMMARY:CS 180'), 'SUMMARY:CS 180')
})

test('foldLine folds long lines at 75 octets with CRLF + space', () => {
  const line = 'DESCRIPTION:' + 'x'.repeat(200)
  const folded = foldLine(line)
  const physical = folded.split('\r\n')
  assert.ok(physical.length > 1, 'expected multiple physical lines')
  // First line <= 75 octets; continuations start with a space.
  assert.ok(Buffer.byteLength(physical[0], 'utf8') <= 75)
  for (const cont of physical.slice(1)) {
    assert.equal(cont[0], ' ')
    assert.ok(Buffer.byteLength(cont, 'utf8') <= 75)
  }
  // Unfolding (strip CRLF + leading space) restores the original.
  assert.equal(folded.replace(/\r\n /g, ''), line)
})

test('foldLine never splits a multi-byte character', () => {
  const line = 'X-NOTE:' + '☕'.repeat(40) // 3 bytes each
  const folded = foldLine(line)
  for (const physical of folded.split('\r\n')) {
    // A split emoji would corrupt UTF-8; round-tripping proves it stayed whole.
    assert.equal(Buffer.from(physical, 'utf8').toString('utf8'), physical)
  }
  assert.equal(folded.replace(/\r\n /g, ''), line)
})

// ── date formatting ──────────────────────────────────────────────────────────

test('formatIcsUtc renders a Z-suffixed UTC date-time', () => {
  assert.equal(formatIcsUtc(new Date('2026-01-12T14:30:00.000Z')), '20260112T143000Z')
})

test('formatIcsDate renders a campus-local date-only value', () => {
  // 2026-01-13T02:00Z is still Jan 12 in Indiana (UTC-5), proving tz anchoring.
  assert.equal(formatIcsDate(new Date('2026-01-13T02:00:00.000Z')), '20260112')
})

// ── buildCalendarFeed ────────────────────────────────────────────────────────

test('buildCalendarFeed wraps events in a VCALENDAR with CRLF endings', () => {
  const ics = buildCalendarFeed({
    events: [
      {
        uid: 'evt-1',
        summary: 'CS 180 Lecture',
        start: new Date('2026-01-12T14:30:00.000Z'),
        end: new Date('2026-01-12T15:20:00.000Z'),
        location: 'LWSN B155',
        dtstamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
  })
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/)
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/)
  assert.match(ics, /\r\nX-WR-CALNAME:BoilerIndy\r\n/)
  assert.match(ics, /\r\nUID:evt-1@boilerindy\r\n/)
  assert.match(ics, /\r\nDTSTART:20260112T143000Z\r\n/)
  assert.match(ics, /\r\nDTEND:20260112T152000Z\r\n/)
  assert.match(ics, /\r\nSUMMARY:CS 180 Lecture\r\n/)
  assert.match(ics, /\r\nLOCATION:LWSN B155\r\n/)
})

test('buildCalendarFeed emits VALUE=DATE for all-day tasks with exclusive end', () => {
  const ics = buildCalendarFeed({
    events: [
      {
        uid: 'manual-7',
        summary: 'Essay due',
        start: new Date('2026-03-05T16:00:00.000Z'),
        allDay: true,
        dtstamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
  })
  assert.match(ics, /\r\nDTSTART;VALUE=DATE:20260305\r\n/)
  assert.match(ics, /\r\nDTEND;VALUE=DATE:20260306\r\n/)
})

test('buildCalendarFeed escapes summaries with commas and newlines', () => {
  const ics = buildCalendarFeed({
    events: [
      {
        uid: 'evt-2',
        summary: 'Lab 3, part 1',
        description: 'Bring:\n- laptop\n- charger',
        start: new Date('2026-01-12T14:30:00.000Z'),
        end: new Date('2026-01-12T15:20:00.000Z'),
        dtstamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
  })
  assert.match(ics, /\r\nSUMMARY:Lab 3\\, part 1\r\n/)
  assert.match(ics, /DESCRIPTION:Bring:\\n- laptop\\n- charger/)
})

test('buildCalendarFeed omits optional fields when absent', () => {
  const ics = buildCalendarFeed({
    events: [
      {
        uid: 'evt-3',
        summary: 'No location event',
        start: new Date('2026-01-12T14:30:00.000Z'),
        end: new Date('2026-01-12T15:20:00.000Z'),
        dtstamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
  })
  assert.doesNotMatch(ics, /\r\nLOCATION:/)
  assert.doesNotMatch(ics, /\r\nDESCRIPTION:/)
})
