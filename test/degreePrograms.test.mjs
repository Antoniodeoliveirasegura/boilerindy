// Tests for the degree-planner data + matching helpers (issue #18). Pure
// functions — no DB, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEGREE_PROGRAMS,
  listPrograms,
  getProgram,
  extractCourseCode,
  extractCourseCodes,
  matchProgress,
} from '../src/degreePrograms.mjs'

test('listPrograms returns id/name/degree for every program', () => {
  const list = listPrograms()
  assert.equal(list.length, DEGREE_PROGRAMS.length)
  for (const p of list) {
    assert.ok(p.id && p.name && p.degree)
  }
})

test('getProgram resolves a known id and null otherwise', () => {
  assert.equal(getProgram('computer-science').name, 'Computer Science')
  assert.equal(getProgram('nope'), null)
})

test('extractCourseCode normalizes spacing and case', () => {
  assert.equal(extractCourseCode('CS 18000 Problem Solving'), 'CS 18000')
  assert.equal(extractCourseCode('cs18000'), 'CS 18000')
  assert.equal(extractCourseCode('Intro to stuff'), null)
})

test('extractCourseCodes finds alternates inside a name', () => {
  assert.deepEqual(extractCourseCodes('MA 16100 (or MA 16500)'), ['MA 16100', 'MA 16500'])
})

test('matchProgress marks passed required courses done (credit-weighted)', () => {
  const cs = getProgram('computer-science')
  const taken = [
    { courseName: 'CS 18000 Problem Solving', letterGrade: 'A', creditHours: 4 },
    { courseName: 'CS 18200 Foundations', letterGrade: 'B', creditHours: 3 },
  ]
  const p = matchProgress(cs, taken)
  assert.equal(p.doneCourses, 2)
  assert.equal(p.doneCredits, 7)
  const core = p.groups.find((g) => g.name === 'Computer Science Core')
  assert.equal(core.doneCount, 2)
  assert.equal(core.courses.find((c) => c.code === 'CS 18000').done, true)
  assert.equal(core.courses.find((c) => c.code === 'CS 24000').done, false)
})

test('matchProgress excludes failed/withdrawn courses', () => {
  const cs = getProgram('computer-science')
  const p = matchProgress(cs, [
    { courseName: 'CS 18000', letterGrade: 'F', creditHours: 4 },
    { courseName: 'CS 24000', letterGrade: 'W', creditHours: 3 },
  ])
  assert.equal(p.doneCourses, 0)
})

test('matchProgress accepts an "or" alternate course', () => {
  const cs = getProgram('computer-science')
  // The Math group lists "MA 16100 (or MA 16500)"; taking the alternate counts.
  const p = matchProgress(cs, [{ courseName: 'MA 16500 Honors Calc I', letterGrade: 'A', creditHours: 5 }])
  const math = p.groups.find((g) => g.name === 'Mathematics')
  assert.equal(math.courses.find((c) => c.code === 'MA 16100').done, true)
})

test('matchProgress counts a Pass as completed but not GPA-affecting', () => {
  const cs = getProgram('computer-science')
  const p = matchProgress(cs, [{ courseName: 'CS 19300 Tools', letterGrade: 'P', creditHours: 1 }])
  assert.equal(p.doneCourses, 1)
})

test('every program has a source url and at least one requirement group', () => {
  for (const p of DEGREE_PROGRAMS) {
    assert.ok(/^https?:\/\//.test(p.sourceUrl), `${p.id} has a source url`)
    assert.ok(p.requirementGroups.length > 0)
    assert.ok(p.totalCredits > 0)
  }
})
