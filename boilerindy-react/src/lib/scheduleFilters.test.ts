import { describe, expect, test } from 'vitest'
import {
  isLikelyExamItem,
  isOnlineMeetingNoise,
  shouldExcludeFromSchedule,
  isLikelyClassMeeting,
  filterClassItemsForSchedulePage,
} from './scheduleFilters'

// Pure schedule-classification logic used by Home + Schedule.
describe('scheduleFilters', () => {
  test('flags exam-type items', () => {
    expect(isLikelyExamItem({ title: 'Final Exam' })).toBe(true)
    expect(isLikelyExamItem({ title: 'CS 101 Lecture' })).toBe(false)
    expect(isLikelyExamItem(null)).toBe(false)
  })

  test('flags online-meeting noise', () => {
    expect(isOnlineMeetingNoise({ title: 'Zoom Meeting' })).toBe(true)
    expect(isOnlineMeetingNoise({ title: 'Online session' })).toBe(true)
    expect(isOnlineMeetingNoise({ title: 'ET 215 Lecture' })).toBe(false)
  })

  test('excludes exams and online noise, keeps real meetings', () => {
    expect(shouldExcludeFromSchedule({ title: 'Midterm' })).toBe(true)
    expect(shouldExcludeFromSchedule({ title: 'Online session' })).toBe(true)
    expect(shouldExcludeFromSchedule(null)).toBe(true)
    expect(shouldExcludeFromSchedule({ title: 'Lecture', description: 'lecture' })).toBe(false)
  })

  test('identifies real class meetings', () => {
    expect(isLikelyClassMeeting({ title: 'CS 30200', description: 'Lecture' })).toBe(true)
    expect(isLikelyClassMeeting({ title: 'Final Exam', description: 'exam' })).toBe(false)
  })

  test('filterClassItemsForSchedulePage drops noise + null rows', () => {
    const items = [
      { title: 'CS Lecture', description: 'lecture' },
      { title: 'Final Exam' },
      null,
    ]
    const out = filterClassItemsForSchedulePage(items)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('CS Lecture')
  })

  // A Summer 2026 schedule of 34 imported meetings rendered as "No weekly classes
  // scheduled" because all 34 were online sections and the noise check matched
  // \bonline\b anywhere in the title.
  test('keeps real online sections, flags only bare shells', () => {
    expect(isOnlineMeetingNoise({ title: 'CS 25000 Online Lecture' })).toBe(false)
    expect(isOnlineMeetingNoise({ title: 'ENGL 10600 - Online' })).toBe(false)
    expect(isOnlineMeetingNoise({ title: 'Online' })).toBe(true)
    expect(isOnlineMeetingNoise({ title: '  online  ' })).toBe(true)
    expect(isOnlineMeetingNoise({ title: 'Online Meeting' })).toBe(true)
  })

  // The exam check searched the description as well, so one syllabus blurb
  // mentioning a final removed every lecture in that course.
  test('exam check reads the title, not the description', () => {
    expect(
      isLikelyExamItem({ title: 'CS 25000 Lecture', description: 'Final exam is Dec 12' }),
    ).toBe(false)
    expect(isLikelyExamItem({ title: 'CS 25000 Final Exam', description: '' })).toBe(true)
  })

  test('filterClassItemsForSchedulePage never empties a schedule that has data', () => {
    // Every row looks like noise. Showing them beats showing nothing.
    const items = [{ title: 'Zoom Meeting' }, { title: 'Midterm' }]
    expect(filterClassItemsForSchedulePage(items)).toHaveLength(2)
    // Genuinely empty input stays empty.
    expect(filterClassItemsForSchedulePage([])).toHaveLength(0)
    expect(filterClassItemsForSchedulePage([null])).toHaveLength(0)
  })
})
