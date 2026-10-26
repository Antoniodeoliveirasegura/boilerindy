import { describe, expect, it } from 'vitest'
import {
  activeSourceFilter,
  eventSourceCounts,
  eventSourceOf,
  followedEventCount,
  hasEnded,
  isOngoing,
  isDowntownEvent,
  listedTime,
  listingLink,
  matchesSourceFilter,
  runsFromEarlierDay,
  untilLabel,
} from './campusEvents'

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

describe('the source pills', () => {
  const purdue = { shared: true, sourceKey: 'purdue_events' }
  const boilerlink = { shared: true, sourceKey: 'boilerlink' }
  const purdueme = { shared: true, sourceKey: 'purdueme' }
  const iu = { shared: true, sourceKey: 'iu_events' }
  const thespot = { shared: true, sourceKey: 'thespot' }
  const jaguars = { shared: true, sourceKey: 'iu_athletics' }
  const park = { shared: true, sourceKey: 'wrsp_events' }
  const mine = {}

  it("sorts each row by school: Purdue's calendars, IU's, or the student's own", () => {
    expect([purdue, boilerlink, purdueme, iu, thespot, jaguars, mine].map(eventSourceOf)).toEqual(['purdue', 'purdue', 'purdue', 'iu', 'iu', 'iu', 'mine'])
    expect(eventSourceOf({ shared: true, sourceKey: 'somewhere_else' })).toBeNull()
    expect(eventSourceOf({ shared: true })).toBeNull()
  })

  it('counts the sources present in a fixed order, and none while no row is shared', () => {
    expect(eventSourceCounts([mine, iu, purdue, thespot, mine, iu])).toEqual([
      { id: 'purdue', label: 'Purdue', count: 1 },
      { id: 'iu', label: 'IU', count: 3 },
      { id: 'mine', label: 'My calendar', count: 2 },
    ])
    expect(eventSourceCounts([iu, { shared: true, sourceKey: 'somewhere_else' }])).toEqual([{ id: 'iu', label: 'IU', count: 1 }])
    expect(eventSourceCounts([mine, mine])).toEqual([])
    expect(eventSourceCounts([])).toEqual([])
  })

  // Issue #30: White River State Park's rows are no school's; they get a
  // Downtown pill, after the schools and before the student's own calendar.
  it('gives the downtown rows their own pill, and a downtown row reads as downtown alone', () => {
    expect(eventSourceOf(park)).toBe('downtown')
    expect(eventSourceCounts([mine, park, iu, park, purdue])).toEqual([
      { id: 'purdue', label: 'Purdue', count: 1 },
      { id: 'iu', label: 'IU', count: 1 },
      { id: 'downtown', label: 'Downtown', count: 2 },
      { id: 'mine', label: 'My calendar', count: 1 },
    ])
    const counts = eventSourceCounts([purdue, park])
    expect(activeSourceFilter('downtown', counts)).toBe('downtown')
    expect(activeSourceFilter('downtown', eventSourceCounts([purdue, iu]))).toBe('all')
    expect(matchesSourceFilter(park, 'downtown')).toBe(true)
    expect(matchesSourceFilter(purdue, 'downtown')).toBe(false)
    expect(matchesSourceFilter(park, 'purdue')).toBe(false)
    expect([park, purdue, iu, mine, { sourceKey: 'wrsp_events' }].map(isDowntownEvent)).toEqual([true, false, false, false, false])
  })

  it('keeps a pick only while its source has rows and there is a second source to switch to', () => {
    const counts = eventSourceCounts([purdue, iu, mine])
    expect(activeSourceFilter('iu', counts)).toBe('iu')
    expect(activeSourceFilter('all', counts)).toBe('all')
    expect(activeSourceFilter('mine', eventSourceCounts([purdue, iu]))).toBe('all')
    expect(activeSourceFilter('iu', eventSourceCounts([iu]))).toBe('all')
  })

  it('matches a row against the pick; all matches every row, an unknown shared source included', () => {
    expect(matchesSourceFilter(iu, 'iu')).toBe(true)
    expect(matchesSourceFilter(thespot, 'iu')).toBe(true)
    expect(matchesSourceFilter(purdue, 'iu')).toBe(false)
    expect(matchesSourceFilter(mine, 'mine')).toBe(true)
    expect(matchesSourceFilter({ shared: true, sourceKey: 'somewhere_else' }, 'all')).toBe(true)
    expect(matchesSourceFilter({ shared: true, sourceKey: 'somewhere_else' }, 'purdue')).toBe(false)
  })
})

// Issue #16: "Clubs I follow", beside the source pills. The server marks each
// shared row of a student's read with `followed`, and leaves it out when it
// cannot say (signed out, or before README step 48).
describe('the Clubs I follow pill', () => {
  const followed = { shared: true, sourceKey: 'boilerlink', followed: true }
  const notFollowed = { shared: true, sourceKey: 'boilerlink', followed: false }
  const calendar = { shared: true, sourceKey: 'purdue_events', followed: false }
  const unmarked = { shared: true, sourceKey: 'boilerlink' }
  const mine = {}

  it('counts the followed clubs\' rows, and is not there when no shared row says', () => {
    expect(followedEventCount([followed, notFollowed, calendar, mine, followed])).toBe(2)
    expect(followedEventCount([notFollowed, calendar, mine])).toBe(0)
    expect(followedEventCount([unmarked, mine])).toBeNull()
    expect(followedEventCount([mine, { followed: true }])).toBeNull()
    expect(followedEventCount([])).toBeNull()
  })

  it('stays picked while its pill shows, even with none to list, and reads as all once it is gone', () => {
    const counts = eventSourceCounts([followed, calendar, mine])
    expect(activeSourceFilter('following', counts, 2)).toBe('following')
    expect(activeSourceFilter('following', counts, 0)).toBe('following')
    expect(activeSourceFilter('following', [], 0)).toBe('following')
    expect(activeSourceFilter('following', counts, null)).toBe('all')
    expect(activeSourceFilter('following', counts)).toBe('all')
    // The source pills keep their own rule.
    expect(activeSourceFilter('purdue', counts, 2)).toBe('purdue')
  })

  it('lists only the shared rows of followed clubs', () => {
    expect([followed, notFollowed, calendar, unmarked, mine].map((item) => matchesSourceFilter(item, 'following'))).toEqual([
      true, false, false, false, false,
    ])
    // A student's own row never matches, whatever it carries.
    expect(matchesSourceFilter({ followed: true }, 'following')).toBe(false)
  })
})
