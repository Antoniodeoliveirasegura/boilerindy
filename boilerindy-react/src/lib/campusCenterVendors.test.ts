import { describe, expect, test } from 'vitest'
import {
  CAMPUS_CENTER_SLUG,
  CAMPUS_CENTER_VENDORS,
  CAMPUS_CENTER_VENDORS_CHECKED,
  CAMPUS_CENTER_VENDORS_SOURCE,
  campusCenterVendorsFor,
  checkedLabel,
  vendorsByFloor,
} from './campusCenterVendors'
import { OFFICIAL_HOURS_URL } from './dining'

// Issue #477: the Campus Center's food court vendors, a hand-kept list from
// the Campus Center's own page, shown on the Dining page in place of a menu.

describe('the Campus Center vendor list', () => {
  test('ten vendors, each named once, with a floor and what it serves', () => {
    expect(CAMPUS_CENTER_VENDORS).toHaveLength(10)
    expect(new Set(CAMPUS_CENTER_VENDORS.map((v) => v.name)).size).toBe(10)
    for (const vendor of CAMPUS_CENTER_VENDORS) {
      expect(vendor.name.trim()).not.toBe('')
      expect(vendor.floor).toMatch(/^Level [12]/)
      expect(vendor.serves.trim()).not.toBe('')
    }
  })

  test('grouped by floor in walking order', () => {
    const floors = vendorsByFloor()
    expect(floors.map((f) => f.floor)).toEqual(['Level 1, Citizens Commons', 'Level 1', 'Level 2'])
    expect(floors[0].vendors.map((v) => v.name)).toEqual(['Chick-fil-A', "Copperhead Jack's", 'Panda Express', 'Pizza Hut', 'The Market'])
    expect(floors[2].vendors.map((v) => v.name)).toEqual(['Caribou Coffee', 'The Daily Bagel'])
    expect(vendorsByFloor([])).toEqual([])
  })

  test('only the Campus Center gets them', () => {
    expect(campusCenterVendorsFor({ id: 'campus-center', slug: CAMPUS_CENTER_SLUG })).toBe(CAMPUS_CENTER_VENDORS)
    expect(campusCenterVendorsFor({ id: 'campus-center' })).toBe(CAMPUS_CENTER_VENDORS)
    expect(campusCenterVendorsFor({ id: 'tower-dining', slug: 'tower-dining' })).toEqual([])
    expect(campusCenterVendorsFor(null)).toEqual([])
  })

  test('the source and the hours links, and when the list was checked', () => {
    expect(CAMPUS_CENTER_VENDORS_SOURCE).toMatch(/^https:\/\/studentaffairs\.indianapolis\.iu\.edu\/campus-center\//)
    // Dine On Campus moved from /iui to /iuindy in July 2025; the official page still links the old slug.
    expect(OFFICIAL_HOURS_URL).toBe('https://dineoncampus.com/iuindy/hours-of-operation')
    expect(CAMPUS_CENTER_VENDORS_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(checkedLabel('2026-10-17')).toBe('Oct 17, 2026')
  })
})
