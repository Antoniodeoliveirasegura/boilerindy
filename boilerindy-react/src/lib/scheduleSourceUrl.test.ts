import { describe, expect, test } from 'vitest'
import { checkScheduleSourceUrl } from './scheduleSourceUrl'

// Issue #120 - the paste box should explain a wrong link before the API does.

describe('checkScheduleSourceUrl', () => {
  test('accepts a UniTime export link for the class schedule', () => {
    const r = checkScheduleSourceUrl('purdue', '  https://timetable.mypurdue.purdue.edu/Timetabling/export?x=abc123  ')
    expect(r).toEqual({ ok: true, url: 'https://timetable.mypurdue.purdue.edu/Timetabling/export?x=abc123' })
  })

  test('accepts a Brightspace feed link', () => {
    const r = checkScheduleSourceUrl('brightspace', 'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=t')
    expect(r.ok).toBe(true)
  })

  test('rejects an empty box and non-links with a specific hint', () => {
    expect(checkScheduleSourceUrl('purdue', '')).toEqual({ ok: false, reason: 'Paste the calendar link first.' })
    const r = checkScheduleSourceUrl('purdue', 'my schedule')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/starting with https:\/\//)
  })

  test('names the expected host when the link is from somewhere else', () => {
    const r = checkScheduleSourceUrl('purdue', 'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=t')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('The class schedule link comes from timetable.mypurdue.purdue.edu. This one is from purdue.brightspace.com.')

    const b = checkScheduleSourceUrl('brightspace', 'https://timetable.mypurdue.purdue.edu/Timetabling/export?x=1')
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toMatch(/come from purdue\.brightspace\.com\. This one is from timetable\.mypurdue\.purdue\.edu\./)
  })

  test('does not let a look-alike host through', () => {
    expect(checkScheduleSourceUrl('purdue', 'https://purdue.edu.evil.example/x').ok).toBe(false)
    expect(checkScheduleSourceUrl('purdue', 'https://notpurdue.edu/x').ok).toBe(false)
  })

  test('catches the schedule page itself being pasted instead of the export link', () => {
    const r = checkScheduleSourceUrl('purdue', 'https://timetable.mypurdue.purdue.edu/Timetabling/personal')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Personal Schedule page itself/)
  })

  test('rejects non-http schemes', () => {
    const r = checkScheduleSourceUrl('brightspace', 'webcal://purdue.brightspace.com/feed.ics')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/https:\/\//)
  })
})
