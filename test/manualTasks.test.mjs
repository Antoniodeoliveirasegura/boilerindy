import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapManualTaskRow,
  parseDueAt,
  parseManualTaskCreate,
  parseManualTaskUpdate,
  parseTaskTitle,
  MAX_TASK_TITLE,
} from '../src/manualTasks.mjs'

// Issue #216 - POST and PATCH /api/me/tasks/manual share one due-date and title
// rule: null or '' means no deadline (and clears one on update), a malformed
// dueAt is a 400 instead of being silently dropped.

test('parseDueAt on create: absent, null and empty string all mean no deadline', () => {
  assert.deepEqual(parseDueAt(undefined, { mode: 'create' }), { ok: true, value: null })
  assert.deepEqual(parseDueAt(null, { mode: 'create' }), { ok: true, value: null })
  assert.deepEqual(parseDueAt('', { mode: 'create' }), { ok: true, value: null })
})

test('parseDueAt on update: absent leaves the column alone, null and empty string clear it', () => {
  assert.deepEqual(parseDueAt(undefined, { mode: 'update' }), { ok: true, value: undefined })
  assert.deepEqual(parseDueAt(null, { mode: 'update' }), { ok: true, value: null })
  assert.deepEqual(parseDueAt('', { mode: 'update' }), { ok: true, value: null })
})

test('parseDueAt normalises a valid timestamp to ISO in both modes', () => {
  for (const mode of ['create', 'update']) {
    assert.deepEqual(parseDueAt('2026-09-20T12:00:00Z', { mode }), { ok: true, value: '2026-09-20T12:00:00.000Z' })
    assert.deepEqual(parseDueAt('2026-09-20T08:00:00-04:00', { mode }), {
      ok: true,
      value: '2026-09-20T12:00:00.000Z',
    })
  }
})

test('parseDueAt rejects an unparseable string in both modes', () => {
  for (const mode of ['create', 'update']) {
    assert.deepEqual(parseDueAt('2026-13-45', { mode }), { ok: false, message: 'Invalid dueAt date' })
    assert.deepEqual(parseDueAt('nope', { mode }), { ok: false, message: 'Invalid dueAt date' })
  }
})

test('parseDueAt rejects a non-string in both modes', () => {
  for (const mode of ['create', 'update']) {
    for (const value of [1758369600000, { at: '2026-09-20' }, true, ['2026-09-20T12:00:00Z']]) {
      assert.deepEqual(parseDueAt(value, { mode }), { ok: false, message: 'dueAt must be an ISO timestamp string' })
    }
  }
})

test('parseTaskTitle trims a valid title', () => {
  assert.deepEqual(parseTaskTitle('  Finish lab write-up  ', { required: true }), {
    ok: true,
    value: 'Finish lab write-up',
  })
  assert.deepEqual(parseTaskTitle(' Read chapter 3 ', { required: false }), { ok: true, value: 'Read chapter 3' })
})

test('parseTaskTitle requires a title on create', () => {
  const message = `Title is required (max ${MAX_TASK_TITLE} characters)`
  for (const value of [undefined, null, '', '   ']) {
    assert.deepEqual(parseTaskTitle(value, { required: true }), { ok: false, message })
  }
})

test('parseTaskTitle on update: absent leaves the title alone, a supplied blank is rejected', () => {
  const message = `Title is required (max ${MAX_TASK_TITLE} characters)`
  assert.deepEqual(parseTaskTitle(undefined, { required: false }), { ok: true, value: undefined })
  assert.deepEqual(parseTaskTitle('', { required: false }), { ok: false, message })
  assert.deepEqual(parseTaskTitle('   ', { required: false }), { ok: false, message })
  assert.deepEqual(parseTaskTitle(null, { required: false }), { ok: false, message })
})

test('parseTaskTitle caps the title at MAX_TASK_TITLE characters', () => {
  assert.equal(MAX_TASK_TITLE, 500)
  const atCap = 'a'.repeat(MAX_TASK_TITLE)
  assert.deepEqual(parseTaskTitle(atCap, { required: true }), { ok: true, value: atCap })
  // Surrounding whitespace does not count toward the cap.
  assert.deepEqual(parseTaskTitle(`  ${atCap}  `, { required: true }), { ok: true, value: atCap })
  for (const required of [true, false]) {
    assert.equal(parseTaskTitle('a'.repeat(MAX_TASK_TITLE + 1), { required }).ok, false)
  }
})

// The route bodies: server.mjs and e2e/fixtures/mock-backend.js store and
// return exactly what these helpers produce.

const TITLE_MESSAGE = `Title is required (max ${MAX_TASK_TITLE} characters)`
const NOW = '2026-09-16T15:00:00.000Z'

test('parseManualTaskCreate builds the row POST inserts', () => {
  assert.deepEqual(parseManualTaskCreate({ title: ' Lab report ', dueAt: '2026-09-20T08:00:00-04:00' }), {
    ok: true,
    row: { title: 'Lab report', due_at: '2026-09-20T12:00:00.000Z' },
  })
  assert.deepEqual(parseManualTaskCreate({ title: 'Lab report' }), { ok: true, row: { title: 'Lab report', due_at: null } })
  assert.deepEqual(parseManualTaskCreate({ title: 'Lab report', dueAt: null }), {
    ok: true,
    row: { title: 'Lab report', due_at: null },
  })
})

test('parseManualTaskCreate rejects a missing title before looking at dueAt', () => {
  assert.deepEqual(parseManualTaskCreate(undefined), { ok: false, message: TITLE_MESSAGE })
  assert.deepEqual(parseManualTaskCreate({ title: '', dueAt: 42 }), { ok: false, message: TITLE_MESSAGE })
  assert.deepEqual(parseManualTaskCreate({ title: 'Lab report', dueAt: 'nope' }), {
    ok: false,
    message: 'Invalid dueAt date',
  })
})

test('parseManualTaskUpdate: dueAt null or empty string clears the deadline and touches nothing else', () => {
  assert.deepEqual(parseManualTaskUpdate({ dueAt: null }, { now: NOW }), { ok: true, updates: { due_at: null } })
  assert.deepEqual(parseManualTaskUpdate({ dueAt: '' }, { now: NOW }), { ok: true, updates: { due_at: null } })
})

test('parseManualTaskUpdate sets only the fields the body supplies', () => {
  assert.deepEqual(parseManualTaskUpdate({ completed: true }, { now: NOW }), { ok: true, updates: { completed_at: NOW } })
  assert.deepEqual(parseManualTaskUpdate({ completed: false }, { now: NOW }), { ok: true, updates: { completed_at: null } })
  assert.deepEqual(parseManualTaskUpdate({ title: ' Lab report ', dueAt: '2026-09-20T12:00:00Z' }, { now: NOW }), {
    ok: true,
    updates: { title: 'Lab report', due_at: '2026-09-20T12:00:00.000Z' },
  })
})

test('parseManualTaskUpdate fails the whole request when one field is malformed', () => {
  assert.deepEqual(parseManualTaskUpdate({ completed: true, dueAt: 'nope' }, { now: NOW }), {
    ok: false,
    message: 'Invalid dueAt date',
  })
  assert.deepEqual(parseManualTaskUpdate({ completed: true, dueAt: 1758369600000 }, { now: NOW }), {
    ok: false,
    message: 'dueAt must be an ISO timestamp string',
  })
  assert.deepEqual(parseManualTaskUpdate({ completed: true, title: '   ' }, { now: NOW }), {
    ok: false,
    message: TITLE_MESSAGE,
  })
})

test('parseManualTaskUpdate rejects a body with nothing to update', () => {
  for (const body of [undefined, null, {}, { completed: 'yes' }]) {
    assert.deepEqual(parseManualTaskUpdate(body, { now: NOW }), { ok: false, message: 'No valid fields to update' })
  }
})

test('mapManualTaskRow returns a cleared deadline as startTime: null', () => {
  const row = { id: 'task-1', user_id: 'user-1', title: 'Lab report', due_at: null, completed_at: null }
  assert.deepEqual(mapManualTaskRow(row), {
    id: 'task-1',
    title: 'Lab report',
    startTime: null,
    endTime: null,
    category: 'manual_task',
    sourceType: 'manual',
    description: null,
    location: null,
    externalUid: null,
    sourceId: null,
    completedAt: null,
    isManual: true,
  })
  assert.equal(mapManualTaskRow({ ...row, due_at: '2026-09-20T12:00:00+00:00' }).startTime, '2026-09-20T12:00:00+00:00')
})
