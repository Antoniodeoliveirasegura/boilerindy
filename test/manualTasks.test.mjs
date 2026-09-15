import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDueAt, parseTaskTitle, MAX_TASK_TITLE } from '../src/manualTasks.mjs'

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
