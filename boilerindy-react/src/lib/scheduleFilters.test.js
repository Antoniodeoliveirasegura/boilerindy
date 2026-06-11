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
})
