import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeScheduleOverrides,
  classSeriesKeyFromRow,
  applyScheduleOverridesToRows,
  manualClassesAsRows,
  applyHmInZone,
  MAX_MANUAL_CLASSES,
} from '../src/scheduleOverrides.mjs'

const TZ = 'America/Indiana/Indianapolis'

test('normalizeScheduleOverrides keeps valid fields and drops junk', () => {
  const out = normalizeScheduleOverrides({
    series: {
      'CS 30200||ET 202': {
        code: '  CS 30200  ',
        room: 'SL 120',
        startHm: '9:05',
        endHm: '25:99',
        days: ['Monday', 'Funday'],
        hidden: true,
      },
      // No usable fields, so the whole entry goes away.
      'empty||': { nope: 1 },
    },
    manual: [
      { id: 'a', code: 'MA 16500', startHm: '14:30', endHm: '15:45', days: ['Tuesday'] },
      { id: 'b', code: 'missing times', days: ['Monday'] },
    ],
  })

  assert.deepEqual(out.series['CS 30200||ET 202'], {
    code: 'CS 30200',
    room: 'SL 120',
    startHm: '09:05',
    endHm: '23:59',
    days: ['Monday'],
    hidden: true,
  })
  assert.equal(out.series['empty||'], undefined)
  assert.equal(out.manual.length, 1)
  assert.equal(out.manual[0].name, 'Class meeting')
})

test('normalizeScheduleOverrides tolerates garbage input', () => {
  assert.deepEqual(normalizeScheduleOverrides(null), { series: {}, manual: [] })
  assert.deepEqual(normalizeScheduleOverrides({ series: [], manual: 'x' }), { series: {}, manual: [] })
})

test('normalizeScheduleOverrides caps the number of manual classes', () => {
  const manual = Array.from({ length: MAX_MANUAL_CLASSES + 25 }, (_, i) => ({
    id: `id-${i}`,
    code: 'CS 101',
    startHm: '09:00',
    endHm: '10:00',
    days: ['Monday'],
  }))
  assert.equal(normalizeScheduleOverrides({ manual }).manual.length, MAX_MANUAL_CLASSES)
})

test('classSeriesKeyFromRow matches the client key shape', () => {
  assert.equal(
    classSeriesKeyFromRow({ title: 'CS 30200', description: 'Operating Systems', location: 'ET 202' }),
    'CS 30200|Operating Systems|ET 202',
  )
  assert.equal(classSeriesKeyFromRow({ title: 'X' }), 'X||')
})

test('applyScheduleOverridesToRows drops hidden series and rewrites edits', () => {
  const rows = [
    { id: '1', title: 'GONE', description: '', location: '', category: 'class', start_time: '2026-09-22T14:30:00.000Z' },
    { id: '2', title: 'CS 30200', description: 'OS', location: 'ET 202', category: 'class', start_time: '2026-09-22T18:30:00.000Z', end_time: '2026-09-22T19:45:00.000Z' },
  ]
  const overrides = normalizeScheduleOverrides({
    series: {
      'GONE||': { hidden: true },
      'CS 30200|OS|ET 202': { room: 'SL 120' },
    },
  })

  const out = applyScheduleOverridesToRows(rows, overrides, TZ)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, '2')
  assert.equal(out[0].location, 'SL 120')
})

test('applyScheduleOverridesToRows leaves non-class rows alone', () => {
  const rows = [
    { id: '1', title: 'Essay', description: '', location: '', category: 'assignment', start_time: '2026-09-22T14:30:00.000Z' },
  ]
  const overrides = normalizeScheduleOverrides({ series: { 'Essay||': { hidden: true } } })
  assert.equal(applyScheduleOverridesToRows(rows, overrides, TZ).length, 1)
})

test('applyHmInZone moves the wall-clock time in the campus timezone', () => {
  // 18:30Z is 2:30pm Eastern on this date; retime it to 4:00pm local.
  const out = applyHmInZone('2026-09-22T18:30:00.000Z', '16:00', TZ)
  const label = new Date(out).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
  assert.equal(label, '4:00 PM')
})

test('manualClassesAsRows expands weekly entries onto matching days only', () => {
  const manual = normalizeScheduleOverrides({
    manual: [{ id: 'm1', code: 'MA 16500', name: 'Calc', startHm: '10:00', endHm: '11:00', days: ['Tuesday'] }],
  }).manual

  // Tue Sep 22 2026 through the following Monday: exactly one Tuesday.
  const rows = manualClassesAsRows(manual, new Date('2026-09-22T04:00:00.000Z'), new Date('2026-09-28T04:00:00.000Z'), TZ)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'MA 16500')
  assert.equal(rows[0].manual, true)
  assert.equal(
    new Date(rows[0].start_time).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' }),
    'Tuesday',
  )
})

test('manualClassesAsRows returns nothing when there are no manual classes', () => {
  assert.deepEqual(manualClassesAsRows([], new Date(), new Date(), TZ), [])
})
