import { describe, expect, it } from 'vitest'
import { hasEnded, isOngoing, listedTime, listingLink, runsFromEarlierDay, untilLabel } from './campusEvents'

// Issue #30: the shared campus events' link out, and the timing both pages
// give every row, so a listing that runs for days stays listed until it ends.
// Times are built in local time, so the day boundaries hold in any time zone.

const NOW = new Date(2026, 9, 14, 15, 0) // Wednesday 3:00 PM, local time
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString()
const shortDate = (date: Date) => date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const clock = (date: Date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

describe('listingLink', () => {
  it('links a shared row to its listing and names the host', () => {
    expect(listingLink({ shared: true, sourceUrl: 'https://events.iu.edu/event/yoga' })).toEqual({
      href: 'https://events.iu.edu/event/yoga',
      host: 'events.iu.edu',
    })
    expect(listingLink({ shared: true, sourceUrl: 'http://www.example.edu/e/1' })?.host).toBe('example.edu')
  })

  it('gives nothing for the student own rows, a missing link or anything but http(s)', () => {
    expect(listingLink({ sourceUrl: 'https://events.iu.edu/event/yoga' })).toBeNull()
    expect(listingLink({ shared: true, sourceUrl: null })).toBeNull()
    expect(listingLink({ shared: true, sourceUrl: 'javascript:alert(1)' })).toBeNull()
    expect(listingLink({ shared: true, sourceUrl: 'not a url' })).toBeNull()
  })
})

describe('timing by the end', () => {
  const later = { startTime: local(14, 18), endTime: local(14, 20) }
  const running = { startTime: local(14, 14), endTime: local(14, 16) }
  const over = { startTime: local(14, 9), endTime: local(14, 10) }
  const exhibit = { startTime: local(1, 10), endTime: local(31, 17) }
  const startedNoEnd = { startTime: local(14, 14) }
  const allDayToday = { startTime: local(14, 0), allDay: true }

  it('a row is over once its end has passed; with no end, at its start, or at the end of its day when all day', () => {
    expect(hasEnded(later, NOW)).toBe(false)
    expect(hasEnded(running, NOW)).toBe(false)
    expect(hasEnded(over, NOW)).toBe(true)
    expect(hasEnded(exhibit, NOW)).toBe(false)
    expect(hasEnded(startedNoEnd, NOW)).toBe(true)
    expect(hasEnded(allDayToday, NOW)).toBe(false)
    expect(hasEnded({ startTime: local(13, 0), allDay: true }, NOW)).toBe(true)
  })

  it('ongoing means started and not over; from an earlier day only when it began before today', () => {
    expect([later, running, over, exhibit].map((item) => isOngoing(item, NOW))).toEqual([false, true, false, true])
    expect([later, running, over, exhibit].map((item) => runsFromEarlierDay(item, NOW))).toEqual([false, false, false, true])
  })

  it('lists a row at its start, or at now when it has been running since an earlier day', () => {
    expect(listedTime(running, NOW)).toBe(running.startTime)
    expect(listedTime(later, NOW)).toBe(later.startTime)
    expect(listedTime(exhibit, NOW)).toBe(NOW.toISOString())
  })

  it('says until when: a time today, a date later, and "ends today" for an end at midnight tonight', () => {
    expect(untilLabel(running, NOW)).toBe(`until ${clock(new Date(running.endTime))}`)
    expect(untilLabel(exhibit, NOW)).toBe(`until ${shortDate(new Date(2026, 9, 31))}`)
    expect(untilLabel({ startTime: local(13, 0), endTime: local(15, 0) }, NOW)).toBe('ends today')
    // A midnight end closes the day before it: Friday's midnight is Thursday.
    expect(untilLabel({ startTime: local(13, 0), endTime: local(17, 0) }, NOW)).toBe(`until ${shortDate(new Date(2026, 9, 16))}`)
  })
})
