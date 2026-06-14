// Tests for the pure grade-tracker validator + GPA math (issue #10). Untrusted
// input in, safe values out — no DB, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  gradePoints,
  isGpaLetter,
  normalizeGrade,
  normalizeGrades,
  computeGpa,
  summarizeGrades,
  DEFAULT_CREDIT_HOURS,
  DEFAULT_TERM,
  MAX_CREDIT_HOURS,
} from '../gradeTracker.mjs'

test('gradePoints maps the Purdue 4.0 scale, null for non-GPA/unknown', () => {
  assert.equal(gradePoints('A'), 4.0)
  assert.equal(gradePoints('A+'), 4.0)
  assert.equal(gradePoints('B-'), 2.7)
  assert.equal(gradePoints('F'), 0.0)
  assert.equal(gradePoints('P'), null)
  assert.equal(gradePoints('Z'), null)
})

test('isGpaLetter distinguishes scale grades from P/W/I', () => {
  assert.equal(isGpaLetter('C+'), true)
  assert.equal(isGpaLetter('W'), false)
  assert.equal(isGpaLetter('P'), false)
})

test('normalizeGrade trims, clamps credits, and requires a valid letter', () => {
  const g = normalizeGrade({ courseName: '  CS 101 ', term: ' Fall 2025 ', creditHours: 3, letterGrade: 'A-' })
  assert.deepEqual(g, { id: null, courseName: 'CS 101', term: 'Fall 2025', creditHours: 3, letterGrade: 'A-' })
})

test('normalizeGrade rejects missing name or unknown grade', () => {
  assert.equal(normalizeGrade({ courseName: '', letterGrade: 'A' }), null)
  assert.equal(normalizeGrade({ courseName: 'X', letterGrade: 'Q' }), null)
  assert.equal(normalizeGrade(null), null)
})

test('normalizeGrade applies defaults for missing term/credits', () => {
  const g = normalizeGrade({ courseName: 'Bio', letterGrade: 'B' })
  assert.equal(g.term, DEFAULT_TERM)
  assert.equal(g.creditHours, DEFAULT_CREDIT_HOURS)
})

test('normalizeGrade clamps out-of-range credit hours', () => {
  assert.equal(normalizeGrade({ courseName: 'A', letterGrade: 'A', creditHours: -5 }).creditHours, DEFAULT_CREDIT_HOURS)
  assert.equal(normalizeGrade({ courseName: 'A', letterGrade: 'A', creditHours: 999 }).creditHours, MAX_CREDIT_HOURS)
})

test('normalizeGrades drops invalid entries', () => {
  const out = normalizeGrades([
    { courseName: 'Good', letterGrade: 'A' },
    { courseName: '', letterGrade: 'A' },
    'nonsense',
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].courseName, 'Good')
})

test('computeGpa: credit-weighted average over GPA grades only', () => {
  const { gpa, credits } = computeGpa([
    { creditHours: 3, letterGrade: 'A' }, // 4.0 * 3 = 12
    { creditHours: 1, letterGrade: 'B' }, // 3.0 * 1 = 3
  ])
  assert.equal(credits, 4)
  assert.equal(gpa, 3.75) // 15 / 4
})

test('computeGpa excludes non-GPA grades and zero-credit rows', () => {
  const { gpa, credits } = computeGpa([
    { creditHours: 3, letterGrade: 'A' },
    { creditHours: 3, letterGrade: 'P' }, // pass — excluded
    { creditHours: 0, letterGrade: 'F' }, // zero credit — excluded
  ])
  assert.equal(credits, 3)
  assert.equal(gpa, 4.0)
})

test('computeGpa returns null gpa when nothing is countable', () => {
  assert.equal(computeGpa([]).gpa, null)
  assert.equal(computeGpa([{ creditHours: 3, letterGrade: 'W' }]).gpa, null)
})

test('summarizeGrades groups by term with per-term + cumulative GPA', () => {
  const s = summarizeGrades([
    { courseName: 'a', term: 'Fall', creditHours: 3, letterGrade: 'A' },
    { courseName: 'b', term: 'Fall', creditHours: 3, letterGrade: 'B' },
    { courseName: 'c', term: 'Spring', creditHours: 4, letterGrade: 'A' },
  ])
  assert.equal(s.terms.length, 2)
  const fall = s.terms.find((t) => t.term === 'Fall')
  assert.equal(fall.gpa, 3.5) // (4+3)/2
  assert.equal(fall.credits, 6)
  // cumulative: (4*3 + 3*3 + 4*4) / 10 = 37/10 = 3.7
  assert.equal(s.gpa, 3.7)
  assert.equal(s.credits, 10)
})
