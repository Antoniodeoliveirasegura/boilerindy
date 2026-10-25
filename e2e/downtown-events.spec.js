import { test, expect } from './fixtures/mock-backend.js'

// Issue #30: White River State Park's calendar, the first source beyond
// campus. While CAMPUS_EVENTS_DOWNTOWN is on the server sends its rows with the
// shared campus events, as sourceKey wrsp_events with the label "Downtown"
// (src/campusEventsFeed.mjs), and Events and Free Food give them a Downtown
// pill of their own, so a museum night never reads as a campus event. Signed
// out, /free-food does the same from GET /api/campus-events/free-food.

const HOUR = 60 * 60 * 1000
const inHours = (hours) => new Date(Date.now() + hours * HOUR).toISOString()

// The client shape of src/campusEventsFeed.mjs.
function sharedEvent(overrides) {
  return {
    sourceId: null,
    description: null,
    location: 'Campus Center 450',
    category: 'campus_event',
    externalUid: null,
    sourceType: 'campus',
    allDay: false,
    freeFood: false,
    shared: true,
    sourceKey: 'purdue_events',
    sourceLabel: 'Purdue event',
    ...overrides,
  }
}
const downtown = (overrides) =>
  sharedEvent({ location: 'Indiana State Museum, 650 West Washington Street, Indianapolis', sourceKey: 'wrsp_events', sourceLabel: 'Downtown', ...overrides })

const LEAP = sharedEvent({
  id: 'campus:leap',
  title: 'LEAP Retreat',
  startTime: inHours(26),
  endTime: inHours(30),
  sourceUrl: 'https://events.purdue.edu/event/leap-retreat',
})
const FUEL_UP = sharedEvent({
  id: 'campus:fuel-up',
  title: 'Boiler Fuel Up',
  startTime: inHours(20),
  endTime: inHours(22),
  freeFood: true,
  sourceUrl: 'https://events.purdue.edu/event/boiler-fuel-up',
})
const TWILIGHT = downtown({
  id: 'campus:twilight',
  title: 'Twilight Tales: Beyond the Grave (18+)',
  startTime: inHours(28),
  endTime: inHours(30),
  sourceUrl: 'https://whiteriverstatepark.org/event/twilight-tales-strange-encounters-2/',
})
const PANCAKES = downtown({
  id: 'campus:pancakes',
  title: 'Free Pancake Breakfast at the Museum',
  startTime: inHours(44),
  endTime: inHours(46),
  freeFood: true,
  sourceUrl: 'https://whiteriverstatepark.org/event/pancake-breakfast/',
})

test.describe('Downtown events', () => {
  test('signed in, a downtown row says Downtown, reads as an Event and has its own pill on Events and Free Food', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.setOnboarding({ linkedSourceCount: 0 })
    mockApi.seedSharedEvents([LEAP, TWILIGHT, FUEL_UP, PANCAKES])

    await page.goto('/events')
    const twilight = page.getByRole('button', { name: /Twilight Tales/ })
    await expect(twilight.getByText('Downtown', { exact: true })).toBeVisible()
    await expect(twilight.getByText('Event', { exact: true })).toBeVisible()
    await expect(twilight.getByText('Campus Event')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /LEAP Retreat/ }).getByText('Campus Event')).toBeVisible()

    const sources = page.getByRole('group', { name: 'Event source' })
    await expect(sources.getByRole('button')).toHaveText(['All sources', 'Purdue (2)', 'Downtown (2)'])
    await sources.getByRole('button', { name: 'Downtown (2)' }).click()
    await expect(page.getByRole('button', { name: /LEAP Retreat/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Free Pancake Breakfast/ })).toBeVisible()

    await twilight.click()
    const listing = page.getByRole('link', { name: 'View on whiteriverstatepark.org' })
    await expect(listing).toHaveAttribute('href', TWILIGHT.sourceUrl)
    await expect(listing).toHaveAttribute('target', '_blank')

    await page.goto('/free-food')
    await expect(page.getByRole('heading', { name: 'Free Food' })).toBeVisible()
    await expect(page.getByText('Free Pancake Breakfast at the Museum')).toBeVisible()
    await expect(page.getByText('Twilight Tales: Beyond the Grave (18+)')).toHaveCount(0)
    const freeFoodSources = page.getByRole('group', { name: 'Event source' })
    await expect(freeFoodSources.getByRole('button')).toHaveText(['All sources', 'Purdue (1)', 'Downtown (1)'])
    await freeFoodSources.getByRole('button', { name: 'Downtown (1)' }).click()
    await expect(page.getByText('Boiler Fuel Up')).toHaveCount(0)
    await expect(page.getByRole('listitem').filter({ hasText: 'Free Pancake Breakfast at the Museum' }).getByText('Downtown', { exact: true })).toBeVisible()
  })

  test('signed out, /free-food lists a downtown event with free food under the same Downtown pill', async ({ page, mockApi }) => {
    mockApi.seedSharedEvents([FUEL_UP, LEAP, PANCAKES])
    const perUser = []
    page.on('request', (request) => {
      const { pathname } = new URL(request.url())
      if (pathname.startsWith('/api/me')) perUser.push(pathname)
    })

    await page.goto('/free-food')
    await expect(page.getByTestId('preview-bar')).toBeVisible()
    await expect(page.getByText('2 upcoming events on campus calendars that mention free food')).toBeVisible()
    const pancakes = page.getByRole('listitem').filter({ hasText: 'Free Pancake Breakfast at the Museum' })
    await expect(pancakes.getByText('Downtown', { exact: true })).toBeVisible()
    await expect(pancakes.getByRole('link', { name: 'View on whiteriverstatepark.org' })).toHaveAttribute('href', PANCAKES.sourceUrl)

    const sources = page.getByRole('group', { name: 'Event source' })
    await expect(sources.getByRole('button')).toHaveText(['All sources', 'Purdue (1)', 'Downtown (1)'])
    await sources.getByRole('button', { name: 'Downtown (1)' }).click()
    await expect(page.getByText('Boiler Fuel Up')).toHaveCount(0)
    await expect(pancakes).toBeVisible()

    await page.waitForLoadState('networkidle')
    expect(perUser).toEqual([])
  })
})
