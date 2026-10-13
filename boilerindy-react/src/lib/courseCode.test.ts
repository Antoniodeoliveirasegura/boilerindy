import { describe, expect, test } from 'vitest'
import { splitCourseCode } from './courseCode'

// Home, Schedule and Assignments put a leading course code on a plate. The
// rule is pinned here so the three pages keep splitting titles the same way.

describe('splitCourseCode', () => {
  test('splits a Purdue code off the front of a title', () => {
    expect(splitCourseCode('CS 25100 Data Structures')).toEqual({ code: 'CS 25100', rest: 'Data Structures' })
    expect(splitCourseCode('MA 16100 Lecture')).toEqual({ code: 'MA 16100', rest: 'Lecture' })
    expect(splitCourseCode('PHYS 17200L Lab')).toEqual({ code: 'PHYS 17200L', rest: 'Lab' })
    expect(splitCourseCode('CS25100 Project 2')).toEqual({ code: 'CS25100', rest: 'Project 2' })
    expect(splitCourseCode('ENGR 13100 Homework 4')).toEqual({ code: 'ENGR 13100', rest: 'Homework 4' })
  })

  test('keeps the rest of the title, punctuation and all, trimmed', () => {
    expect(splitCourseCode('  CS 25100   - Lab 3  ')).toEqual({ code: 'CS 25100', rest: '- Lab 3' })
    expect(splitCourseCode('CS 25100\tQuiz 1')).toEqual({ code: 'CS 25100', rest: 'Quiz 1' })
  })

  test('takes a title that is only a code, with an empty rest', () => {
    expect(splitCourseCode('CS 25100')).toEqual({ code: 'CS 25100', rest: '' })
    expect(splitCourseCode(' ECE 20001 ')).toEqual({ code: 'ECE 20001', rest: '' })
  })

  test('needs 5 digits: 3 and 4 digit numbers do not count', () => {
    expect(splitCourseCode('CS 251 Data Structures')).toBeNull()
    expect(splitCourseCode('CS 2510 Data Structures')).toBeNull()
    expect(splitCourseCode('CS 251000 Data Structures')).toBeNull()
  })

  test('needs a 2 to 5 letter capital subject', () => {
    expect(splitCourseCode('C 25100 Data Structures')).toBeNull()
    expect(splitCourseCode('COMPSC 25100 Data Structures')).toBeNull()
    expect(splitCourseCode('cs 25100 Data Structures')).toBeNull()
  })

  test('needs whitespace or the end right after the code', () => {
    expect(splitCourseCode('CS 25100: Project 2')).toBeNull()
    expect(splitCourseCode('CS 25100-Lab 3')).toBeNull()
    expect(splitCourseCode('CS 25100AB Notes')).toBeNull()
  })

  test('returns null for titles without a code, and for no title', () => {
    expect(splitCourseCode('Career fair')).toBeNull()
    expect(splitCourseCode('Office hours CS 25100')).toBeNull()
    expect(splitCourseCode('')).toBeNull()
    expect(splitCourseCode(null)).toBeNull()
    expect(splitCourseCode(undefined)).toBeNull()
  })
})
