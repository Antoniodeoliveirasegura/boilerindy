import { describe, expect, test } from 'vitest'
import { diningDirectionsUrl, emptyMenuState, headerBlurb, snapshotWeekday, statusLine } from './dining'

// Issue #119 - the Dining page formats the server snapshot with these helpers;
// keep them honest about closed halls, retail halls and missing data.

describe('statusLine', () => {
  test('describes every open / closed shape the server sends', () => {
    expect(statusLine({ is_open: true, hours: '7:00 AM - 9:00 PM', closes_at: '9:00 PM', opens_at: null })).toBe('Open now · until 9:00 PM')
    expect(statusLine({ is_open: true, hours: 'Open 24 hours', open24h: true })).toBe('Open 24 hours')
    expect(statusLine({ is_open: true, hours: 'Hours unavailable' })).toBe('Open now')
    expect(statusLine({ is_open: false, hours: '7:00 AM - 9:00 PM', opens_at: '7:00 AM' })).toBe('Closed · opens 7:00 AM')
    expect(statusLine({ is_open: false, hours: '7:00 AM - 9:00 PM', opens_at: null })).toBe('Closed')
    expect(statusLine({ is_open: false, hours: 'Closed today' })).toBe('Closed today')
  })
})

describe('emptyMenuState', () => {
  test('retail halls get an intentional state, dining halls a "not posted yet" one', () => {
    const retail = emptyMenuState({ kind: 'retail', name: 'Campus Center' })
    expect(retail.kind).toBe('retail')
    expect(retail.title).toBe('Food court and retail vendors')
    expect(retail.body).toContain('Campus Center vendors')
    const hall = emptyMenuState({ kind: 'dining-hall', name: 'Tower Dining' })
    expect(hall.kind).toBe('no-menu')
    expect(hall.title).toBe('No menu posted for today')
    expect(emptyMenuState({ name: 'Unknown' }).kind).toBe('no-menu')
  })
})

describe('diningDirectionsUrl', () => {
  test('uses the street address, falling back to the name in Indianapolis', () => {
    expect(diningDirectionsUrl({ address: 'University Tower, 911 W North St, Indianapolis, IN 46202', name: 'Tower Dining' })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=University%20Tower%2C%20911%20W%20North%20St%2C%20Indianapolis%2C%20IN%2046202',
    )
    expect(diningDirectionsUrl({ address: null, name: 'Campus Center' })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=Campus%20Center%2C%20Indianapolis%2C%20IN',
    )
  })
})

describe('snapshotWeekday', () => {
  test('prefers the campus day from the snapshot over the browser day', () => {
    const seoulThursday = new Date('2026-09-10T00:30:00+09:00')
    expect(snapshotWeekday({ weekday: 'Wednesday' }, seoulThursday)).toBe('Wednesday')
    expect(snapshotWeekday({ weekday: 'Someday' }, new Date(2026, 8, 9, 12))).toBe('Wednesday')
    expect(snapshotWeekday(null, new Date(2026, 8, 12, 12))).toBe('Saturday')
  })
})

describe('headerBlurb', () => {
  test('uses the weekly row for the campus day and appends the menu hint', () => {
    const loc = { hours: '7:00 AM - 9:00 PM', weekly_hours: { Wednesday: '7:00 AM - 9:00 PM', Saturday: 'Closed' }, meal: 'Menus: lunch' }
    expect(headerBlurb(loc, 'Wednesday')).toBe('Today: 7:00 AM - 9:00 PM · Menus: lunch')
    expect(headerBlurb(loc, 'Saturday')).toBe('Today: Closed · Menus: lunch')
    expect(headerBlurb({ hours: undefined, weekly_hours: null, meal: '' }, 'Monday')).toBe('Today: Hours not posted')
  })
})
