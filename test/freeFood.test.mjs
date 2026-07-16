// Tests for the pure free-food matcher (issue #46). Title + description go in,
// a boolean comes out - no DB, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hasFreeFood } from '../src/freeFood.mjs'

test('matches obvious free-food phrases in the title', () => {
  assert.equal(hasFreeFood('Club fair - free pizza!', ''), true)
  assert.equal(hasFreeFood('Game night with snacks', null), true)
  assert.equal(hasFreeFood('Lunch provided', undefined), true)
})

test('matches free-food keywords in the description', () => {
  assert.equal(hasFreeFood('CS Club meeting', 'Come hang out, refreshments will be served.'), true)
  assert.equal(hasFreeFood('Info session', 'Donuts and coffee in the morning.'), true)
})

test('is case-insensitive', () => {
  assert.equal(hasFreeFood('FREE FOOD at the union', ''), true)
  assert.equal(hasFreeFood('Catered Reception', ''), true)
})

test('does not match unrelated events', () => {
  assert.equal(hasFreeFood('Calculus midterm review', 'Bring your notes and a calculator.'), false)
  assert.equal(hasFreeFood('Career fair', 'Network with employers in the ballroom.'), false)
})

test('respects word boundaries (no false positive on substrings)', () => {
  // "pizza" should not match inside an unrelated word like "pizzazz".
  assert.equal(hasFreeFood('Add some pizzazz to your resume', ''), false)
})

test('handles empty / missing input', () => {
  assert.equal(hasFreeFood('', ''), false)
  assert.equal(hasFreeFood(undefined, undefined), false)
  assert.equal(hasFreeFood(null, null), false)
})
