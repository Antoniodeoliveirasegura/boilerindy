import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCourseCode,
  coursesFromClassItems,
  validateStudyGroupInput,
  MAX_GROUP_TITLE,
} from '../src/studyGroups.mjs'

// Issue #33 — the course-code normalizer is the shared piece (#17 reuses it).

test('extracts a spaced course code', () => {
  assert.equal(normalizeCourseCode('CS 18000 - Problem Solving'), 'CS 18000')
})

test('extracts a run-together code and uppercases the department', () => {
  assert.equal(normalizeCourseCode('cs18000 Lecture'), 'CS 18000')
  assert.equal(normalizeCourseCode('Lecture for ma16500'), 'MA 16500')
})

test('handles 4-letter departments', () => {
  assert.equal(normalizeCourseCode('ENGL 10600 Writing'), 'ENGL 10600')
})

test('returns empty string when no code is present', () => {
  assert.equal(normalizeCourseCode('Office Hours'), '')
  assert.equal(normalizeCourseCode(null), '')
  assert.equal(normalizeCourseCode('CS 999'), '')
})

test('coursesFromClassItems returns distinct sorted codes', () => {
  const items = [
    { title: 'CS 18000 Lecture' },
    { title: 'cs18000 Lab' },
    { title: 'MA 16500' },
    { title: 'Office Hours' },
  ]
  assert.deepEqual(coursesFromClassItems(items), ['CS 18000', 'MA 16500'])
})

test('validateStudyGroupInput requires a valid course code', () => {
  assert.match(validateStudyGroupInput({ courseCode: 'nope', title: 'x' }).error, /valid course code/)
})

test('validateStudyGroupInput normalizes and coerces', () => {
  const { value, error } = validateStudyGroupInput({
    courseCode: 'cs18000',
    title: '  Tuesday group ',
    description: 'Meet at lib',
    meetingInfo: 'Library 2pm',
    capacity: 6,
  })
  assert.equal(error, undefined)
  assert.equal(value.course_code, 'CS 18000')
  assert.equal(value.title, 'Tuesday group')
  assert.equal(value.capacity, 6)
})

test('validateStudyGroupInput rejects bad capacity and long title', () => {
  assert.match(validateStudyGroupInput({ courseCode: 'CS 18000', title: 'x', capacity: 1 }).error, /Capacity/)
  const long = 'a'.repeat(MAX_GROUP_TITLE + 1)
  assert.match(validateStudyGroupInput({ courseCode: 'CS 18000', title: long }).error, /Title is required/)
})
