import { describe, expect, test } from 'vitest'
import {
  ALL_MEALS,
  comingUpLine,
  favoritesComingUp,
  headlinersFor,
  DIET_FILTERS,
  DIET_FILTERS_KEY,
  DIET_LABEL_NOTE,
  HOURS_NOT_LISTED,
  diningDirectionsUrl,
  emptyMenuState,
  feedNotice,
  filterStations,
  headerBlurb,
  locationMenus,
  macroLine,
  nutritionRows,
  openState,
  readDietFilters,
  snapshotWeekday,
  splitStations,
  statusDotClass,
  statusLine,
  todaysMealHeading,
  weeklyHoursCell,
  writeDietFilters,
} from './dining'

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

  // Issue #465: a day the feed flags closed but that has a published menu.
  test('a status that is not known is never called open or closed', () => {
    expect(statusLine({ is_open: null, hours: HOURS_NOT_LISTED, opens_at: null, closes_at: null })).toBe('Menu posted · hours not listed')
    expect(openState({ is_open: null })).toBe('unknown')
    expect(openState({ is_open: true })).toBe('open')
    expect(openState({ is_open: false })).toBe('closed')
    // An older snapshot never sent null; a missing flag keeps reading as closed.
    expect(openState({})).toBe('closed')
    expect(statusDotClass({ is_open: null })).toBe('status-unknown')
    expect(statusDotClass({ is_open: true })).toBe('status-open')
    expect(statusDotClass({ is_open: false })).toBe('status-closed')
  })
})

describe('weeklyHoursCell', () => {
  test('prints listed hours as they are and mutes closed and unlisted days', () => {
    expect(weeklyHoursCell('7:00 AM - 9:00 PM')).toEqual({ label: '7:00 AM - 9:00 PM', muted: false })
    expect(weeklyHoursCell('Closed')).toEqual({ label: 'Closed', muted: true })
    expect(weeklyHoursCell(HOURS_NOT_LISTED)).toEqual({ label: 'Not listed', muted: true })
    expect(weeklyHoursCell(undefined)).toEqual({ label: 'Not posted', muted: false })
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
    const weekend = { hours: HOURS_NOT_LISTED, weekly_hours: { Saturday: HOURS_NOT_LISTED }, meal: 'Menus: breakfast, lunch, dinner' }
    expect(headerBlurb(weekend, 'Saturday')).toBe('Today: Hours not listed · Menus: breakfast, lunch, dinner')
  })
})

// Issue #466: one menu per meal, specials ahead of the every-day stations.
describe('locationMenus', () => {
  const grill = { name: 'Daily Grill', everyday: true, items: [{ name: 'Cheeseburger' }] }
  test('uses the per-meal menus, or one combined view for an older snapshot', () => {
    const menus = [{ meal: 'lunch', stations: [grill] }]
    expect(locationMenus({ menus, stations: [grill] })).toBe(menus)
    expect(locationMenus({ stations: [grill] })).toEqual([{ meal: ALL_MEALS, stations: [grill] }])
    expect(locationMenus({ menus: [], stations: [] })).toEqual([])
    expect(locationMenus({})).toEqual([])
  })
})

describe('splitStations', () => {
  test('keeps feed order inside each group and treats a missing flag as a special', () => {
    const soup = { name: 'Chef Made Soups', everyday: false, items: [] }
    const grill = { name: 'Daily Grill', everyday: true, items: [] }
    const pizza = { name: 'Pizza', everyday: true, items: [] }
    const old = { name: 'Homestyle', items: [] }
    expect(splitStations([grill, soup, pizza, old])).toEqual({ specials: [soup, old], everyday: [grill, pizza] })
  })
})

describe('todaysMealHeading', () => {
  test('names the meal when it is a real one', () => {
    expect(todaysMealHeading('lunch')).toBe("Today's lunch")
    expect(todaysMealHeading('breakfast')).toBe("Today's breakfast")
    expect(todaysMealHeading(ALL_MEALS)).toBe("Today's menu")
    expect(todaysMealHeading(null)).toBe("Today's menu")
  })
})

// Issue #467: the Nutrislice site is deactivated and only its API answers, so
// the page says when the feed looks abandoned.
describe('feedNotice', () => {
  test('explains an empty week and a feed not updated for weeks, and says nothing otherwise', () => {
    expect(feedNotice({ menu_source: { stale: true, reason: 'empty_week', last_updated: '2026-10-10T04:26:22Z' } })).toBe(
      'No menu is posted for this week. The campus menu feed may have moved, so check the official menu.',
    )
    expect(feedNotice({ menu_source: { stale: true, reason: 'not_updated', last_updated: '2026-10-10T04:26:22Z' } })).toBe(
      'The campus menu feed has not been updated since Oct 10, so this menu may be out of date.',
    )
    expect(feedNotice({ menu_source: { stale: true, reason: 'not_updated', last_updated: null } })).toBe(
      'The campus menu feed has not been updated in weeks, so this menu may be out of date.',
    )
    expect(feedNotice({ menu_source: { stale: false, reason: null, last_updated: '2026-10-10T04:26:22Z' } })).toBeNull()
    expect(feedNotice({ menu_source: null })).toBeNull()
    expect(feedNotice({})).toBeNull()
  })
})

// Issue #468: diet filters from the feed's own labels, never an allergen filter.
describe('diet filters', () => {
  const grill = {
    name: 'Daily Grill',
    items: [
      { name: 'Veggie Burger', icons: ['Vegetarian'] },
      { name: 'Black Bean Burger', icons: ['Vegan', 'Vegetarian', 'Avoiding Gluten'] },
      { name: 'Cheeseburger', icons: [] },
    ],
  }
  const soups = { name: 'Chef Made Soups', items: [{ name: 'Chicken Miso Soup', icons: ['Good Source of Protein'] }] }

  test('the labels are the feed\'s diet labels, and the note says they are not allergen information', () => {
    expect([...DIET_FILTERS]).toEqual(['Vegetarian', 'Vegan', 'Avoiding Gluten'])
    expect(DIET_LABEL_NOTE).toContain('not allergen information')
    expect(DIET_LABEL_NOTE).toContain('ask dining staff about allergies')
  })

  test('filterStations keeps the dishes with every chosen label and drops stations left empty', () => {
    expect(filterStations([grill, soups], [])).toEqual([grill, soups])
    expect(filterStations([grill, soups], ['Vegetarian'])).toEqual([{ ...grill, items: grill.items.slice(0, 2) }])
    expect(filterStations([grill, soups], ['Vegan', 'Avoiding Gluten'])).toEqual([{ ...grill, items: [grill.items[1]] }])
    expect(filterStations([soups], ['Vegan'])).toEqual([])
  })

  test('the choice is saved per device, read back defensively', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    writeDietFilters(['Vegan', 'Peanut Free', 'Vegetarian'], storage)
    expect(store.get(DIET_FILTERS_KEY)).toBe('["Vegetarian","Vegan"]')
    expect(readDietFilters(storage)).toEqual(['Vegetarian', 'Vegan'])
    store.set(DIET_FILTERS_KEY, '{oops')
    expect(readDietFilters(storage)).toEqual([])
    store.set(DIET_FILTERS_KEY, '"Vegan"')
    expect(readDietFilters(storage)).toEqual([])
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(readDietFilters(broken)).toEqual([])
    expect(() => writeDietFilters(['Vegan'], broken)).not.toThrow()
    expect(readDietFilters(null)).toEqual([])
  })
})

describe('nutritionRows and macroLine', () => {
  test('the main facts in label order, then vitamins and minerals, only what the feed has', () => {
    const rows = nutritionRows({ calories: 326, g_protein: 21, g_fat: 14.25, mg_sodium: 610, mg_iron: 1.6, mcg_vitamin_d: 0 })
    expect(rows.main).toEqual([
      { key: 'calories', label: 'Calories', value: '326' },
      { key: 'g_fat', label: 'Total fat', value: '14.3 g' },
      { key: 'mg_sodium', label: 'Sodium', value: '610 mg' },
      { key: 'g_protein', label: 'Protein', value: '21 g' },
    ])
    expect(rows.minor).toEqual([
      { key: 'mg_iron', label: 'Iron', value: '1.6 mg' },
      { key: 'mcg_vitamin_d', label: 'Vitamin D', value: '0 mcg' },
    ])
    expect(nutritionRows(null)).toEqual({ main: [], minor: [] })
  })

  test('macroLine reads the compact facts a menu item carries', () => {
    expect(macroLine({ protein: 17, carbs: 0, fat: 13, sodium: 53 })).toBe('Protein 17 g · Carbs 0 g · Fat 13 g · Sodium 53 mg')
    expect(macroLine({ protein: 4.25 })).toBe('Protein 4.3 g')
    expect(macroLine({})).toBe('')
  })
})

// Issue #469: what is coming up, from GET /api/dining/upcoming.
describe('what is coming up', () => {
  const norm = (name: string) => name.trim().toLowerCase()
  const upcoming = {
    ok: true,
    today: '2026-10-14',
    days: [
      { date: '2026-10-14', tentative: false, holiday: null, meals: [{ meal: 'lunch', location: 'Tower Dining', headliners: [{ name: 'Honey Garlic Fried Chicken', image: 'https://x.test/a.jpg' }], specials: ['Banana Pudding'] }] },
      { date: '2026-10-15', tentative: false, holiday: null, meals: [{ meal: 'dinner', location: 'Tower Dining', headliners: [{ name: 'Jamaican Jerk Chicken', image: null }], specials: [] }] },
      { date: '2026-10-20', tentative: false, holiday: null, meals: [{ meal: 'lunch', location: 'Tower Dining', headliners: [], specials: ['Chicken Miso Soup'] }] },
      { date: '2026-11-19', tentative: true, holiday: null, meals: [{ meal: 'lunch', location: 'Tower Dining', headliners: [{ name: 'Butter Chicken', image: null }, { name: 'Jamaican Jerk Chicken', image: null }], specials: [] }] },
    ],
  }

  test('headlinersFor reads one day and meal', () => {
    expect(headlinersFor(upcoming, '2026-10-14', 'lunch')).toEqual([{ name: 'Honey Garlic Fried Chicken', image: 'https://x.test/a.jpg' }])
    expect(headlinersFor(upcoming, '2026-10-14', 'dinner')).toEqual([])
    expect(headlinersFor(upcoming, '2026-10-18', 'lunch')).toEqual([])
    expect(headlinersFor(null, '2026-10-14', 'lunch')).toEqual([])
  })

  test('favoritesComingUp finds each favorite\'s next day after today, soonest first, headliner or special', () => {
    const favorites = ['jamaican jerk chicken', 'butter chicken', 'chicken miso soup', 'honey garlic fried chicken']
    expect(favoritesComingUp(favorites, upcoming, '2026-10-14', norm)).toEqual([
      { name: 'Jamaican Jerk Chicken', date: '2026-10-15', meal: 'dinner', location: 'Tower Dining', tentative: false },
      { name: 'Chicken Miso Soup', date: '2026-10-20', meal: 'lunch', location: 'Tower Dining', tentative: false },
      { name: 'Butter Chicken', date: '2026-11-19', meal: 'lunch', location: 'Tower Dining', tentative: true },
    ])
    expect(favoritesComingUp([], upcoming, '2026-10-14', norm)).toEqual([])
    expect(favoritesComingUp(favorites, null, '2026-10-14', norm)).toEqual([])
  })

  test('comingUpLine: tomorrow, a weekday within a week, a date beyond it marked tentative', () => {
    expect(comingUpLine({ name: 'Jamaican Jerk Chicken', date: '2026-10-15', tentative: false }, '2026-10-14')).toBe('Jamaican Jerk Chicken is back tomorrow')
    expect(comingUpLine({ name: 'Chicken Miso Soup', date: '2026-10-20', tentative: false }, '2026-10-14')).toBe('Chicken Miso Soup is back Tuesday')
    expect(comingUpLine({ name: 'Butter Chicken', date: '2026-11-19', tentative: true }, '2026-10-14')).toBe('Butter Chicken: Thu, Nov 19 (tentative)')
  })
})
