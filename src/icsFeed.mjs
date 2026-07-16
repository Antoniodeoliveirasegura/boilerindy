// icsFeed.mjs
//
// Pure RFC 5545 (iCalendar) generation for the subscribable calendar feed
// (issue #48). `node-ical` is parse-only, so the feed is built by hand here.
// This module touches no I/O: events go in, a `text/calendar` string comes out,
// which keeps the escaping/folding rules unit-testable without a DB or network.

const PRODID = '-//BoilerIndy//Calendar Feed//EN'
const CALENDAR_NAME = 'BoilerIndy'
// Date-only formatting (all-day events) is anchored to campus time so a task
// due late at night does not land on the wrong calendar day for the user.
const DATE_TZ = 'America/Indiana/Indianapolis'
const MAX_LINE_OCTETS = 75

/**
 * Escape a value for an iCalendar TEXT property (RFC 5545 §3.3.11):
 * backslash, semicolon, comma are escaped; newlines become the literal "\n".
 * Colons are intentionally NOT escaped - they are legal inside TEXT.
 */
export function escapeIcsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Fold a content line to <= 75 octets per RFC 5545 §3.1, counting UTF-8 bytes
 * and never splitting a multi-byte character. Continuation lines begin with a
 * single space. Returns one logical line; callers join lines with CRLF.
 */
export function foldLine(line) {
  const chars = Array.from(String(line))
  const segments = []
  let current = ''
  let bytes = 0

  for (const ch of chars) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    // Continuation lines spend one octet on the leading space.
    const budget = segments.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1
    if (bytes + chBytes > budget) {
      segments.push(current)
      current = ch
      bytes = chBytes
    } else {
      current += ch
      bytes += chBytes
    }
  }
  segments.push(current)

  return segments.join('\r\n ')
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** Format a Date as a UTC date-time value: 20260112T143000Z. */
export function formatIcsUtc(date) {
  const d = date instanceof Date ? date : new Date(date)
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  )
}

/** Format a Date as a campus-local date value: 20260112 (for all-day events). */
export function formatIcsDate(date, timeZone = DATE_TZ) {
  const d = date instanceof Date ? date : new Date(date)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  return `${get('year')}${get('month')}${get('day')}`
}

/** All-day DTEND is exclusive, so it points at the following day. */
function nextDayIcsDate(date, timeZone = DATE_TZ) {
  const ymd = formatIcsDate(date, timeZone)
  const year = Number(ymd.slice(0, 4))
  const month = Number(ymd.slice(4, 6))
  const day = Number(ymd.slice(6, 8))
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return (
    `${next.getUTCFullYear()}${pad2(next.getUTCMonth() + 1)}${pad2(next.getUTCDate())}`
  )
}

function prop(name, value) {
  return foldLine(`${name}:${value}`)
}

/**
 * Build a single VEVENT block as an array of lines.
 *
 * @param {object} ev
 * @param {string} ev.uid        Stable unique id (becomes "<uid>@boilerindy")
 * @param {string} ev.summary    Event title
 * @param {Date}   ev.start      Start instant
 * @param {Date}   [ev.end]      End instant (timed events)
 * @param {string} [ev.location]
 * @param {string} [ev.description]
 * @param {boolean}[ev.allDay]   When true, emit VALUE=DATE start/end
 * @param {Date}   ev.dtstamp    Generation timestamp
 */
function buildEvent(ev) {
  const lines = ['BEGIN:VEVENT']
  lines.push(prop('UID', `${ev.uid}@boilerindy`))
  lines.push(prop('DTSTAMP', formatIcsUtc(ev.dtstamp)))

  if (ev.allDay) {
    lines.push(prop('DTSTART;VALUE=DATE', formatIcsDate(ev.start)))
    lines.push(prop('DTEND;VALUE=DATE', nextDayIcsDate(ev.start)))
  } else {
    lines.push(prop('DTSTART', formatIcsUtc(ev.start)))
    const end = ev.end || ev.start
    lines.push(prop('DTEND', formatIcsUtc(end)))
  }

  lines.push(prop('SUMMARY', escapeIcsText(ev.summary)))
  if (ev.location) lines.push(prop('LOCATION', escapeIcsText(ev.location)))
  if (ev.description) lines.push(prop('DESCRIPTION', escapeIcsText(ev.description)))
  lines.push('END:VEVENT')
  return lines
}

/**
 * Render a complete VCALENDAR document with CRLF line endings.
 *
 * @param {object} options
 * @param {object[]} options.events     Event descriptors (see buildEvent)
 * @param {string} [options.calendarName=BoilerIndy]
 * @param {Date}   [options.now]        Default DTSTAMP for events without one
 * @returns {string} text/calendar payload
 */
export function buildCalendarFeed({ events = [], calendarName = CALENDAR_NAME, now = new Date() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    prop('PRODID', PRODID),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    prop('X-WR-CALNAME', escapeIcsText(calendarName)),
    prop('NAME', escapeIcsText(calendarName)),
  ]

  for (const ev of events) {
    lines.push(...buildEvent({ dtstamp: now, ...ev }))
  }

  lines.push('END:VCALENDAR')
  // RFC 5545 §3.1: lines are delimited by CRLF, including a trailing one.
  return lines.join('\r\n') + '\r\n'
}
