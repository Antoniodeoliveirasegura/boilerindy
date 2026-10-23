import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_SIGNUP_REF,
  campusDayOf,
  campusWeekOf,
  countSignups,
  formatSignupReport,
  signupReportCsv,
} from '../src/signupRefReport.mjs'

// The counts scripts/signup-refs.mjs prints: sign-ups per marketing link and
// per campus week, from users.signup_ref and created_at only.

const ROWS = [
  { signup_ref: null, created_at: '2026-09-30T15:00:00.000Z' },
  { signup_ref: 'flyer-a', created_at: '2026-10-19T15:00:00.000Z' },
  { signup_ref: 'flyer-a', created_at: '2026-10-20T15:00:00.000Z' },
  { signup_ref: 'amb-jane', created_at: '2026-10-21T15:00:00.000Z' },
  { signup_ref: 'flyer-b', created_at: '2026-10-21T16:00:00.000Z' },
  { signup_ref: null, created_at: '2026-10-22T15:00:00.000Z' },
  { created_at: '2026-10-22T16:00:00.000Z' },
]

test('a day and its week are read on the campus calendar, weeks starting Monday', () => {
  // Monday 2026-10-19 at midnight in Indianapolis (EDT, UTC-4).
  assert.equal(campusWeekOf('2026-10-19T04:00:00.000Z'), '2026-10-19')
  // A minute before that is Sunday night on campus, so the week before, even
  // though it is already Monday in UTC.
  assert.equal(campusDayOf('2026-10-19T03:59:00.000Z'), '2026-10-18')
  assert.equal(campusWeekOf('2026-10-19T03:59:00.000Z'), '2026-10-12')
  assert.equal(campusWeekOf('2026-10-25T23:00:00.000Z'), '2026-10-19')
  // Across the switch to EST (2026-11-01) and a year end.
  assert.equal(campusWeekOf('2026-11-02T04:59:00.000Z'), '2026-10-26')
  assert.equal(campusWeekOf('2026-11-02T05:00:00.000Z'), '2026-11-02')
  assert.equal(campusWeekOf('2027-01-01T12:00:00.000Z'), '2026-12-28')
  for (const bad of [null, undefined, '', 'not a date']) {
    assert.equal(campusDayOf(bad), null, String(bad))
    assert.equal(campusWeekOf(bad), null, String(bad))
  }
})

test('counts per link and per week, the untagged last, empty weeks listed', () => {
  assert.deepEqual(countSignups(ROWS), {
    total: 7,
    byRef: [
      { ref: 'flyer-a', signups: 2 },
      { ref: 'amb-jane', signups: 1 },
      { ref: 'flyer-b', signups: 1 },
      { ref: NO_SIGNUP_REF, signups: 3 },
    ],
    byWeek: [
      { weekOf: '2026-09-28', signups: 1, byRef: [{ ref: NO_SIGNUP_REF, signups: 1 }] },
      { weekOf: '2026-10-05', signups: 0, byRef: [] },
      { weekOf: '2026-10-12', signups: 0, byRef: [] },
      {
        weekOf: '2026-10-19',
        signups: 6,
        byRef: [
          { ref: 'flyer-a', signups: 2 },
          { ref: 'amb-jane', signups: 1 },
          { ref: 'flyer-b', signups: 1 },
          { ref: NO_SIGNUP_REF, signups: 2 },
        ],
      },
    ],
  })
})

test('since keeps sign-ups from that campus date on', () => {
  const counts = countSignups(ROWS, { since: '2026-10-20' })
  assert.equal(counts.total, 5)
  // Tied links sort by name.
  assert.deepEqual(counts.byRef, [
    { ref: 'amb-jane', signups: 1 },
    { ref: 'flyer-a', signups: 1 },
    { ref: 'flyer-b', signups: 1 },
    { ref: NO_SIGNUP_REF, signups: 2 },
  ])
  assert.deepEqual(counts.byWeek.map((w) => w.weekOf), ['2026-10-19'])
  // 11 PM on the evening before, campus time, is still the day before.
  assert.equal(countSignups([{ signup_ref: 'x', created_at: '2026-10-20T03:00:00.000Z' }], { since: '2026-10-20' }).total, 0)
})

test('a stored value that breaks the slug rule counts as no ref, and a row without a date is left out', () => {
  const counts = countSignups([
    { signup_ref: 'Jane@Example.com', created_at: '2026-10-20T15:00:00.000Z' },
    { signup_ref: 'flyer-a', created_at: null },
    { signup_ref: 'flyer-a', created_at: 'garbage' },
    null,
  ])
  assert.equal(counts.total, 1)
  assert.deepEqual(counts.byRef, [{ ref: NO_SIGNUP_REF, signups: 1 }])
  assert.deepEqual(countSignups([]), { total: 0, byRef: [], byWeek: [] })
})

test('the text report: a line per link, then a line per week with its links', () => {
  assert.equal(
    formatSignupReport(countSignups(ROWS)),
    [
      'Sign-ups by link, all time: 7',
      'Weeks start Monday, campus time. (none) is a sign-up without a tagged link,',
      'and every account created before sign-up links were saved.',
      '',
      'By link',
      '  Link      Sign-ups',
      '  flyer-a          2',
      '  amb-jane         1',
      '  flyer-b          1',
      '  (none)           3',
      '',
      'By week',
      '  Week of     Sign-ups  By link',
      '  2026-09-28         1  (none) 1',
      '  2026-10-05         0',
      '  2026-10-12         0',
      '  2026-10-19         6  flyer-a 2, amb-jane 1, flyer-b 1, (none) 2',
      '',
    ].join('\n'),
  )
  assert.equal(formatSignupReport(countSignups([])), 'No sign-ups all time.\n')
  assert.equal(formatSignupReport(countSignups([]), { since: '2026-10-01' }), 'No sign-ups since 2026-10-01.\n')
  assert.match(formatSignupReport(countSignups(ROWS), { since: '2026-09-01' }), /^Sign-ups by link, since 2026-09-01: 7\n/)
})

test('the CSV: a row per week, a column per link after the total, empty weeks included', () => {
  assert.equal(
    signupReportCsv(countSignups(ROWS)),
    [
      'week_of,signups,flyer-a,amb-jane,flyer-b,(none)',
      '2026-09-28,1,0,0,0,1',
      '2026-10-05,0,0,0,0,0',
      '2026-10-12,0,0,0,0,0',
      '2026-10-19,6,2,1,1,2',
      '',
    ].join('\n'),
  )
  assert.equal(signupReportCsv(countSignups([])), 'week_of,signups\n')
})

test('the report carries links and numbers only, whatever else a row holds', () => {
  const rows = [{ signup_ref: 'flyer-a', created_at: '2026-10-20T15:00:00.000Z', email: 'pete@example.com', display_name: 'Pete Purdue' }]
  const counts = countSignups(rows)
  for (const out of [JSON.stringify(counts), formatSignupReport(counts), signupReportCsv(counts)]) {
    assert.ok(!/pete|purdue/i.test(out), out)
  }
})
