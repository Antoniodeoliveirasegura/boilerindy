import { test, expect } from './fixtures/mock-backend.js'

// Mobile layout guard (issue #162). At a phone-width viewport the Schedule
// weekday strip and the Transit route chips must scroll inside their own row
// instead of widening the page. The page-level check is the same measurement
// the issue was filed with: documentElement.scrollWidth must not exceed
// clientWidth once the page has settled.

test.use({ viewport: { width: 390, height: 844 } })

// One meeting on each weekday (Mon 2026-09-07 .. Fri 2026-09-11), late morning
// Eastern, so the weekday is the same in UTC and in every US timezone.
const weekOfClasses = [
  ['2026-09-07', 'CS 25100 Data Structures', 'LWSN B155'],
  ['2026-09-08', 'MA 26100 Multivariate Calculus', 'UNIV 101'],
  ['2026-09-09', 'CS 25100 Data Structures', 'LWSN B155'],
  ['2026-09-10', 'MA 26100 Multivariate Calculus', 'UNIV 101'],
  ['2026-09-11', 'CS 25100 Data Structures', 'LWSN B155'],
].map(([day, title, location], i) => ({
  id: `class-${i + 1}`,
  title,
  startTime: `${day}T15:30:00.000Z`,
  endTime: `${day}T16:20:00.000Z`,
  location,
  category: 'class',
}))

// TransLoc GetRoutes rows in the shape buildTranslocRouteIdMap reads (RouteID,
// Description, MapLineColor): the six JAGLINE routes plus a variant that maps
// back onto Route 3.
const translocRoutes = [
  { RouteID: 31, Description: 'Route 1 - Crimson', MapLineColor: '#990000' },
  { RouteID: 19, Description: 'Route 2 - Gray', MapLineColor: '#83786F' },
  { RouteID: 32, Description: 'Route 3 - Yellow', MapLineColor: '#F1BE48' },
  { RouteID: 27, Description: 'Route 4 - Blue', MapLineColor: '#006298' },
  { RouteID: 33, Description: 'Route 5 - Purple', MapLineColor: '#66435A' },
  { RouteID: 34, Description: 'Route 7 - Orange', MapLineColor: '#e68217' },
  { RouteID: 22, Description: 'Route 3 - Yellow Express', MapLineColor: '#F1BE48' },
]

const translocStops = [
  { RouteID: 31, RouteStopID: 1001, Latitude: 39.7742, Longitude: -86.1761, Description: 'Campus Center' },
  { RouteID: 31, RouteStopID: 1002, Latitude: 39.7768, Longitude: -86.1739, Description: 'Library' },
]

const translocVehicles = [
  { VehicleID: 501, RouteID: 31, Latitude: 39.7745, Longitude: -86.1756, GroundSpeed: 12, Name: '501' },
  { VehicleID: 502, RouteID: 19, Latitude: 39.7751, Longitude: -86.1748, GroundSpeed: 0, Name: '502' },
]

const pageFitsViewport = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

const scrollsHorizontally = (locator) => locator.evaluate((el) => el.scrollWidth > el.clientWidth)

// Let in-flight fetches settle, then give React one more frame to commit
// before measuring.
async function settle(page) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(250)
}

test.describe('Mobile layout (390px)', () => {
  test('the schedule weekday strip scrolls inside its card instead of widening the page', async ({
    page,
    mockApi,
  }) => {
    mockApi.login()
    mockApi.seedClasses(weekOfClasses, { selectedTermLabel: 'Fall 2026', totalInTerm: 5 })
    await page.goto('/schedule')

    await expect(page.getByRole('heading', { name: 'Class Schedule' })).toBeVisible()
    await expect(page.getByText(/Fall 2026/)).toBeVisible()

    // All five weekday buttons render (short labels at this width) and the row
    // they sit in is the element that overflows, not the page.
    const dayButtons = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day) =>
      page.getByRole('button', { name: new RegExp(`^${day}`) }),
    )
    for (const button of dayButtons) {
      await expect(button).toBeVisible()
    }
    const strip = dayButtons[0].locator('..')
    expect(await scrollsHorizontally(strip)).toBe(true)

    await settle(page)
    expect(await pageFitsViewport(page)).toBe(true)
  })

  test('the transit route chips scroll inside their row instead of widening the page', async ({
    page,
    mockApi,
  }) => {
    mockApi.login()
    mockApi.seedTransit({ routes: translocRoutes, stops: translocStops, vehicles: translocVehicles })
    // Keep the basemap offline: tile fetches (https://{s}.basemaps.cartocdn.com)
    // are the only non-mocked network traffic on this page and would otherwise
    // gate networkidle on CARTO.
    await page.route(/basemaps\.cartocdn\.com/, (route) => route.abort())
    await page.goto('/transit')

    await expect(page.getByRole('heading', { name: 'Campus Transit' })).toBeVisible()
    const allRoutes = page.getByRole('button', { name: 'All Routes (2)' })
    await expect(allRoutes).toBeVisible()

    // "All Routes" plus one chip per JAGLINE route, all rendered, in a row that
    // scrolls rather than wraps at this width.
    const chips = page.locator('button.pill')
    await expect(chips).toHaveCount(7)
    await expect(chips.last()).toBeVisible()
    const strip = allRoutes.locator('..')
    expect(await scrollsHorizontally(strip)).toBe(true)

    await settle(page)
    expect(await pageFitsViewport(page)).toBe(true)
  })

  test('quick-action captions stay readable in the 2x2 dashboard grid', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')

    const campusMap = page.getByRole('link', { name: /Campus Map/ })
    await expect(campusMap).toBeVisible()
    const caption = campusMap.getByText('Find any building')
    await expect(caption).toBeVisible()

    // Wrapped, not clipped: the whole caption fits inside its own box.
    expect(
      await caption.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight),
    ).toBe(true)

    await settle(page)
    expect(await pageFitsViewport(page)).toBe(true)
  })
})
