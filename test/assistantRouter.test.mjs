import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchIntent,
  formatNextClass,
  formatClassesToday,
  formatDiningOpen,
  formatAssignments,
} from '../src/assistantRouter.mjs'

const TZ = 'America/Indiana/Indianapolis'

// Issue #45 — the intent matcher routes common asks to DB answers (no Gemini).

test('matchIntent recognizes class questions', () => {
  assert.equal(matchIntent("when's my next class?"), 'next_class')
  assert.equal(matchIntent('What classes do I have today'), 'classes_today')
})

test('matchIntent recognizes dining questions', () => {
  assert.equal(matchIntent('is the dining hall open?'), 'dining_open')
  assert.equal(matchIntent("what's on the menu today"), 'dining_open')
})

test('matchIntent recognizes assignment questions', () => {
  assert.equal(matchIntent('any homework due soon?'), 'assignments')
  assert.equal(matchIntent("what's due this week"), 'assignments')
})

test('matchIntent returns null for open-ended questions', () => {
  assert.equal(matchIntent('what should I major in?'), null)
  assert.equal(matchIntent(''), null)
  assert.equal(matchIntent(null), null)
})

test('formatNextClass picks the soonest future class', () => {
  const now = new Date('2026-06-16T09:00:00-04:00')
  const items = [
    { title: 'CS 18000', location: 'LWSN', startTime: '2026-06-16T13:00:00-04:00' },
    { title: 'MA 16500', location: 'UNIV', startTime: '2026-06-16T10:00:00-04:00' },
    { title: 'Past', startTime: '2026-06-16T08:00:00-04:00' },
  ]
  const reply = formatNextClass(items, now, TZ)
  assert.match(reply, /MA 16500/)
  assert.match(reply, /UNIV/)
  assert.doesNotMatch(reply, /CS 18000/)
})

test('formatNextClass returns null when nothing is upcoming', () => {
  const now = new Date('2026-06-16T23:00:00-04:00')
  assert.equal(formatNextClass([{ title: 'X', startTime: '2026-06-16T08:00:00-04:00' }], now, TZ), null)
})

test('formatClassesToday lists todays classes or says none', () => {
  const now = new Date('2026-06-16T09:00:00-04:00')
  const reply = formatClassesToday([{ title: 'CS 18000', startTime: '2026-06-16T13:00:00-04:00' }], now, TZ)
  assert.match(reply, /1 class today/)
  assert.equal(formatClassesToday([], now, TZ), 'You have no classes scheduled for today.')
})

test('formatDiningOpen lists open halls and handles closed/empty', () => {
  const data = { locations: [{ name: 'Tower', is_open: true, hours: '7a-9p' }, { name: 'Earhart', is_open: false }] }
  assert.match(formatDiningOpen(data), /Tower/)
  assert.doesNotMatch(formatDiningOpen(data), /Earhart/)
  assert.match(formatDiningOpen({ locations: [{ name: 'X', is_open: false }] }), /No dining locations are open/)
  assert.equal(formatDiningOpen(null), null)
})

test('formatAssignments lists upcoming deadlines or says none', () => {
  const now = new Date('2026-06-16T09:00:00-04:00')
  const reply = formatAssignments([{ title: 'Essay', startTime: '2026-06-17T23:59:00-04:00' }], now, TZ)
  assert.match(reply, /Essay/)
  assert.equal(formatAssignments([], now, TZ), 'You have no upcoming assignments on your calendar.')
})
