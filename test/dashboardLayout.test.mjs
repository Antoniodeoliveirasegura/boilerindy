// Tests for the pure dashboard-layout normalizer (issue #52). Untrusted input
// goes in, a safe canonical layout comes out — no DB, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WIDGET_IDS,
  normalizeLayout,
  defaultLayout,
  allowedSizesFor,
  DEFAULT_LAYOUT,
} from '../src/dashboardLayout.mjs'

test('normalizeLayout drops unknown widget ids', () => {
  const out = normalizeLayout([{ id: 'next-class' }, { id: 'totally-made-up' }])
  assert.ok(out.some((w) => w.id === 'next-class'))
  assert.ok(!out.some((w) => w.id === 'totally-made-up'))
})

test('normalizeLayout de-duplicates by id (first wins)', () => {
  const out = normalizeLayout([
    { id: 'dining', size: 'full' },
    { id: 'dining', size: 'quarter' },
  ])
  const dining = out.filter((w) => w.id === 'dining')
  assert.equal(dining.length, 1)
  assert.equal(dining[0].size, 'full')
})

test('normalizeLayout clamps invalid sizes to "half"', () => {
  const out = normalizeLayout([{ id: 'board', size: 'gigantic' }])
  assert.equal(out.find((w) => w.id === 'board').size, 'half')
})

test('allowedSizesFor: most widgets are half..full, quick-actions is quarter..full', () => {
  assert.deepEqual(allowedSizesFor('board'), ['half', 'three-quarter', 'full'])
  assert.deepEqual(allowedSizesFor('next-class'), ['half', 'three-quarter', 'full'])
  assert.deepEqual(allowedSizesFor('quick-actions'), [
    'quarter',
    'half',
    'three-quarter',
    'full',
  ])
})

test('normalizeLayout clamps below-min quarter up to half for ordinary widgets', () => {
  const out = normalizeLayout([{ id: 'board', size: 'quarter' }])
  assert.equal(out.find((w) => w.id === 'board').size, 'half')
})

test('normalizeLayout keeps quarter for quick-actions (its vertical width)', () => {
  const out = normalizeLayout([{ id: 'quick-actions', size: 'quarter' }])
  assert.equal(out.find((w) => w.id === 'quick-actions').size, 'quarter')
})

test('normalizeLayout migrates legacy sizes (normal -> half, wide -> full)', () => {
  const out = normalizeLayout([
    { id: 'board', size: 'normal' },
    { id: 'week-ahead', size: 'wide' },
  ])
  assert.equal(out.find((w) => w.id === 'board').size, 'half')
  assert.equal(out.find((w) => w.id === 'week-ahead').size, 'full')
})

test('normalizeLayout preserves caller order then appends missing widgets hidden', () => {
  const out = normalizeLayout([{ id: 'dining' }, { id: 'next-class' }])
  // Caller-specified widgets keep their order at the front.
  assert.equal(out[0].id, 'dining')
  assert.equal(out[1].id, 'next-class')
  // Every catalogue widget is present exactly once.
  assert.equal(out.length, WIDGET_IDS.length)
  assert.equal(new Set(out.map((w) => w.id)).size, WIDGET_IDS.length)
  // The appended ones are hidden.
  assert.equal(out.find((w) => w.id === 'week-ahead').visible, false)
})

test('normalizeLayout honours explicit visible:false and defaults to visible', () => {
  const out = normalizeLayout([
    { id: 'board', visible: false },
    { id: 'dining' },
  ])
  assert.equal(out.find((w) => w.id === 'board').visible, false)
  assert.equal(out.find((w) => w.id === 'dining').visible, true)
})

test('normalizeLayout treats non-array input as empty (returns full default catalogue)', () => {
  for (const bad of [null, undefined, 42, 'nope', {}]) {
    const out = normalizeLayout(bad)
    assert.equal(out.length, WIDGET_IDS.length)
  }
})

test('defaultLayout returns a fresh copy, not the shared reference', () => {
  const a = defaultLayout()
  assert.notEqual(a, DEFAULT_LAYOUT)
  assert.notEqual(a[0], DEFAULT_LAYOUT[0])
  a[0].size = 'mutated'
  assert.notEqual(DEFAULT_LAYOUT[0].size, 'mutated')
})

test('every default layout entry is a valid, known widget', () => {
  for (const w of DEFAULT_LAYOUT) {
    assert.ok(WIDGET_IDS.includes(w.id), `${w.id} is in the catalogue`)
  }
})
