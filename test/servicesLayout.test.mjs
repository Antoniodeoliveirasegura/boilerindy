// Tests for the pure Services-board layout normalizer. Mirrors
// dashboardLayout.test.mjs: untrusted input goes in, a safe canonical layout
// comes out - no DB, no network. Confirms the shared widgetLayout factory
// behaves correctly for the Services catalogue.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WIDGET_IDS,
  normalizeLayout,
  defaultLayout,
  allowedSizesFor,
  DEFAULT_LAYOUT,
} from '../src/servicesLayout.mjs'

test('normalizeLayout drops unknown widget ids', () => {
  const out = normalizeLayout([{ id: 'academic-support' }, { id: 'totally-made-up' }])
  assert.ok(out.some((w) => w.id === 'academic-support'))
  assert.ok(!out.some((w) => w.id === 'totally-made-up'))
})

test('normalizeLayout de-duplicates by id (first wins)', () => {
  const out = normalizeLayout([
    { id: 'health-and-wellness', size: 'full' },
    { id: 'health-and-wellness', size: 'half' },
  ])
  const dupe = out.filter((w) => w.id === 'health-and-wellness')
  assert.equal(dupe.length, 1)
  assert.equal(dupe[0].size, 'full')
})

test('normalizeLayout clamps invalid sizes to "half"', () => {
  const out = normalizeLayout([{ id: 'academic-support', size: 'gigantic' }])
  assert.equal(out.find((w) => w.id === 'academic-support').size, 'half')
})

test('allowedSizesFor: every Services widget is half..full (no quarter)', () => {
  for (const id of WIDGET_IDS) {
    assert.deepEqual(allowedSizesFor(id), ['half', 'three-quarter', 'full'])
  }
})

test('normalizeLayout clamps below-min quarter up to half', () => {
  const out = normalizeLayout([{ id: 'in-app-shortcuts', size: 'quarter' }])
  assert.equal(out.find((w) => w.id === 'in-app-shortcuts').size, 'half')
})

test('normalizeLayout preserves caller order then appends missing widgets hidden', () => {
  const out = normalizeLayout([{ id: 'transit-and-dining' }, { id: 'academic-support' }])
  assert.equal(out[0].id, 'transit-and-dining')
  assert.equal(out[1].id, 'academic-support')
  assert.equal(out.length, WIDGET_IDS.length)
  assert.equal(new Set(out.map((w) => w.id)).size, WIDGET_IDS.length)
  // The appended ones are hidden.
  assert.equal(out.find((w) => w.id === 'health-and-wellness').visible, false)
})

test('normalizeLayout honours explicit visible:false and defaults to visible', () => {
  const out = normalizeLayout([
    { id: 'academic-support', visible: false },
    { id: 'transit-and-dining' },
  ])
  assert.equal(out.find((w) => w.id === 'academic-support').visible, false)
  assert.equal(out.find((w) => w.id === 'transit-and-dining').visible, true)
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

test('In-App Shortcuts leads the default layout at full width', () => {
  const out = defaultLayout()
  assert.equal(out[0].id, 'in-app-shortcuts')
  assert.equal(out[0].size, 'full')
  assert.equal(out[0].visible, true)
})

test('every default layout entry is a valid, known widget', () => {
  for (const w of DEFAULT_LAYOUT) {
    assert.ok(WIDGET_IDS.includes(w.id), `${w.id} is in the catalogue`)
  }
})
