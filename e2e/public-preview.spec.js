import { test, expect } from './fixtures/mock-backend.js'

// Issue #366 - signed-out visitors can open the live dining and transit pages,
// the campus map and the free food on campus calendars, to see the product is
// real before they hand over an email. Same URL and same page a student gets;
// the per-user pieces are hidden and the preview bar sits in the navbar's
// place. The trap this guards: one per-user request from a signed-out page
// answers 401, and authRequest then sends the visitor to /login with a false
// "session expired" banner. The mock answers those paths 401 signed out, as
// the server does, and no request to them may be made.

const PREVIEW_MESSAGE =
  "You're previewing live campus data. Create a free account to save favorites and get stop alerts."
const MAP_MESSAGE = "You're previewing the campus map. Create a free account to find each of your classes on it."
const FREE_FOOD_MESSAGE = "You're previewing free food on campus. Create a free account to add events from your own calendar."

// TransLoc rows in the shape the page reads: Crimson (canonical id 31) with two
// stops and one bus.
const translocRoutes = [{ RouteID: 31, Description: 'Route 1 - Crimson', MapLineColor: '#990000' }]
const translocStops = [
  { RouteID: 31, RouteStopID: 1001, Latitude: 39.7742, Longitude: -86.1761, Description: 'Campus Center' },
  { RouteID: 31, RouteStopID: 1002, Latitude: 39.7768, Longitude: -86.1739, Description: 'Library' },
]
const translocVehicles = [{ VehicleID: 501, RouteID: 31, Latitude: 39.7745, Longitude: -86.1756, GroundSpeed: 12, Name: '501' }]

// Purdue's building layer, as the map reads it from ArcGIS: two buildings.
const square = (lng, lat, size = 0.001) => ({
  type: 'Polygon',
  coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]],
})
const buildingShapes = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { BUILDING_NAME: 'Engineering and Technology', PU_ABBR: 'ETPI', BuildingLabels: 'ET', add_full: '799 W MICHIGAN ST' },
      geometry: square(-86.1745, 39.7745),
    },
    {
      type: 'Feature',
      properties: { BUILDING_NAME: 'University Library', PU_ABBR: 'UL', BuildingLabels: 'UL', add_full: '755 W MICHIGAN ST' },
      geometry: square(-86.1765, 39.7735),
    },
  ],
}

// Shared campus events in the client shape of src/campusEventsFeed.mjs: two
// with free food, one from each school's calendar, and one without.
const HOUR = 60 * 60 * 1000
const inHours = (hours) => new Date(Date.now() + hours * HOUR).toISOString()
function sharedEvent(overrides) {
  return {
    sourceId: null,
    description: null,
    location: 'Campus Center 450',
    category: 'campus_event',
    externalUid: null,
    sourceType: 'campus',
    allDay: false,
    freeFood: true,
    shared: true,
    sourceKey: 'purdue_events',
    sourceLabel: 'Purdue event',
    ...overrides,
  }
}
const FUEL_UP = sharedEvent({
  id: 'campus:fuel-up',
  title: 'Boiler Fuel Up',
  startTime: inHours(20),
  endTime: inHours(22),
  sourceUrl: 'https://events.purdue.edu/event/boiler-fuel-up',
})
const CHILI = sharedEvent({
  id: 'campus:chili',
  title: 'United Way Chili Cook-off',
  startTime: inHours(50),
  endTime: inHours(52),
  sourceKey: 'iu_events',
  sourceLabel: 'IU event',
  sourceUrl: 'https://events.iu.edu/event/chili-cook-off',
})
const LEAP = sharedEvent({
  id: 'campus:leap',
  title: 'LEAP Retreat',
  startTime: inHours(26),
  endTime: inHours(30),
  freeFood: false,
  sourceUrl: 'https://events.purdue.edu/event/leap-retreat',
})

const PER_USER_PREFIXES = ['/api/me/', '/api/assistant', '/api/spotlight/']

function recordPerUserRequests(page) {
  const seen = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (PER_USER_PREFIXES.some((prefix) => pathname.startsWith(prefix))) seen.push(`${request.method()} ${pathname}`)
  })
  return seen
}

function recordFreeFoodReads(page) {
  const seen = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/campus-events/free-food') seen.push(request.method())
  })
  return seen
}

async function serveBuildings(page) {
  await page.route(/Indianapolis_Building_Shapes/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildingShapes) }),
  )
}

// A garage pin is the map's one white-ringed circle marker.
const garagePins = (page) => page.locator('path.leaflet-interactive[stroke="#ffffff"]')

async function expectPreviewBar(page, path) {
  const bar = page.getByTestId('preview-bar')
  await expect(bar).toBeVisible()
  await expect(bar.getByRole('link', { name: 'BoilerIndy' })).toHaveAttribute('href', '/')
  await expect(bar.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/login?tab=signup')
  await expect(bar.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/login?next=${encodeURIComponent(path)}`)
  // Signed out there is no app navigation at all, only the bar.
  await expect(page.getByRole('navigation')).toHaveCount(0)
}

test.describe('Public preview, signed out', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    mockApi.logout()
    mockApi.seedTransit({ routes: translocRoutes, stops: translocStops, vehicles: translocVehicles })
    // Keep the Esri basemap offline.
    await page.route(/server\.arcgisonline\.com/, (route) => route.abort())
  })

  test('dining shows the live menu with no stars, favorites or AI pick', async ({ page }) => {
    const perUser = recordPerUserRequests(page)
    await page.goto('/dining')

    await expect(page.getByRole('heading', { name: 'Campus Dining' })).toBeVisible()
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toContainText('Silver Star Burger')
    await expect(page.locator('[data-dining-hours-for]')).toHaveCount(2)
    await expectPreviewBar(page, '/dining')
    await expect(page.getByTestId('preview-bar')).toContainText(PREVIEW_MESSAGE)

    await expect(page.getByRole('button', { name: /favorites/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /What should I eat/ })).toHaveCount(0)
    await expect(page.locator('[data-dining-favorites]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Refresh menus' })).toBeEnabled()

    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/dining$/)
    expect(perUser).toEqual([])
  })

  test('transit shows live buses and stops with no my-stop bell', async ({ page }) => {
    // A stop a signed-in student saved on this device earlier: signed out it is
    // never read, so no "My stop" tag shows and no chime can fire.
    await page.addInitScript(() => localStorage.setItem('transit-my-stop-31', JSON.stringify('1002')))
    const perUser = recordPerUserRequests(page)
    await page.goto('/transit')

    await expect(page.getByRole('heading', { name: 'Campus Transit' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'All Routes (1)' })).toBeVisible()
    await expect(page.locator('.leaflet-container')).toBeVisible()
    await expectPreviewBar(page, '/transit')

    await page.locator('button.pill', { hasText: 'Crimson' }).click()
    await expect(page.getByText('Stops on this route')).toBeVisible()
    await expect(page.getByText('Library', { exact: true })).toBeVisible()
    await expect(page.getByText('Green pulse = at stop · Filled = reached')).toBeVisible()
    await expect(page.getByText(/Bell = your stop/)).toHaveCount(0)
    await expect(page.getByTitle(/my stop|before/i)).toHaveCount(0)
    await expect(page.getByText('My stop', { exact: true })).toHaveCount(0)
    await expect(page.getByText(/Alert when bus reaches/)).toHaveCount(0)

    await page.waitForLoadState('networkidle')
    // Still on transit, not bounced to /login. The picked route is kept in the
    // URL (Back restores it), and Sign in carries it through.
    await expect(page).toHaveURL(/\/transit\?route=31$/)
    await expectPreviewBar(page, '/transit?route=31')
    expect(perUser).toEqual([])
    // The saved stop is untouched, there for the student when they sign in.
    expect(await page.evaluate(() => localStorage.getItem('transit-my-stop-31'))).toBe('"1002"')
  })

  test('the map shows the campus buildings and live garages with no per-user request', async ({ page }) => {
    await serveBuildings(page)
    const perUser = recordPerUserRequests(page)
    await page.goto('/map')

    await expect(page.getByRole('heading', { name: 'Campus Map', level: 1 })).toBeVisible()
    await expectPreviewBar(page, '/map')
    await expect(page.getByTestId('preview-bar')).toContainText(MAP_MESSAGE)

    // The building list, search and selection all work from Purdue's public layer.
    const list = page.locator('aside')
    await list.getByPlaceholder('Search buildings...').fill('library')
    await expect(list.getByRole('button', { name: /Engineering and Technology/ })).toHaveCount(0)
    await list.getByRole('button', { name: /University Library/ }).click()
    await expect(page.getByRole('heading', { level: 3, name: 'University Library' })).toBeVisible()

    // The live garages layer reads the public parking feed; a pin's popup has
    // directions, and no link to /parking, which needs an account.
    await page.getByRole('button', { name: 'Parking' }).first().click()
    await expect(page.locator('.parking-count-tooltip')).toHaveCount(3)
    await garagePins(page).first().click({ force: true })
    const popup = page.locator('.leaflet-popup')
    await expect(popup.getByRole('link', { name: 'Directions' })).toBeVisible()
    await expect(popup.getByRole('link', { name: 'All garages' })).toHaveCount(0)

    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/map$/)
    expect(perUser).toEqual([])
  })

  test('free food lists the campus calendars\' free food with the Purdue and IU pills, and no per-user request', async ({ page, mockApi }) => {
    mockApi.seedSharedEvents([FUEL_UP, LEAP, CHILI])
    const perUser = recordPerUserRequests(page)
    const freeFoodReads = recordFreeFoodReads(page)
    await page.goto('/free-food')

    await expect(page.getByRole('heading', { name: 'Free Food' })).toBeVisible()
    await expect(page.getByText('2 upcoming events on campus calendars that mention free food')).toBeVisible()
    await expectPreviewBar(page, '/free-food')
    await expect(page.getByTestId('preview-bar')).toContainText(FREE_FOOD_MESSAGE)

    await expect(page.getByText('Boiler Fuel Up')).toBeVisible()
    await expect(page.getByText('United Way Chili Cook-off')).toBeVisible()
    await expect(page.getByText('LEAP Retreat')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'View on events.purdue.edu' })).toHaveAttribute(
      'href',
      'https://events.purdue.edu/event/boiler-fuel-up',
    )

    // All sources, Purdue and IU; no My calendar, which a visitor has none of.
    const sources = page.getByRole('group', { name: 'Event source' })
    await expect(sources.getByRole('button')).toHaveText(['All sources', 'Purdue (1)', 'IU (1)'])
    await sources.getByRole('button', { name: 'IU (1)' }).click()
    await expect(page.getByText('Boiler Fuel Up')).toHaveCount(0)
    await expect(page.getByText('United Way Chili Cook-off')).toBeVisible()

    // Nothing that needs an account: no card to connect a calendar.
    await expect(page.getByText('Connect a calendar source')).toHaveCount(0)

    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/free-food$/)
    expect(perUser).toEqual([])
    expect(freeFoodReads).toEqual(['GET'])
  })

  test('the bar links go to sign-up without next, and sign-in back to the page', async ({ page }) => {
    await page.goto('/transit')
    await page.getByTestId('preview-bar').getByRole('link', { name: 'Create account' }).click()
    await expect(page).toHaveURL(/\/login\?tab=signup$/)
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()

    await page.goto('/dining')
    await page.getByTestId('preview-bar').getByRole('link', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/login\?next=%2Fdining$/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  })

  test('the landing page links to the dining preview', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'See live dining and buses' }).click()
    await expect(page).toHaveURL(/\/dining$/)
    await expect(page.getByRole('heading', { name: 'Campus Dining' })).toBeVisible()
    await expect(page.getByTestId('preview-bar')).toBeVisible()
  })

  test.describe('at phone width', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('the pitch moves to a card at the bottom and the page does not overflow', async ({ page }) => {
      await page.goto('/dining')
      await expect(page.locator('[data-dining-station="Daily Grill"]')).toBeVisible()

      const bar = page.getByTestId('preview-bar')
      await expect(bar.getByRole('link', { name: 'Create account' })).toBeVisible()
      await expect(bar.getByRole('link', { name: 'Sign in' })).toBeVisible()
      await expect(bar.getByText(PREVIEW_MESSAGE)).toBeHidden()
      const note = page.getByTestId('preview-note')
      await expect(note).toBeVisible()
      await expect(note).toContainText(PREVIEW_MESSAGE)

      // The bar stays inside the navbar slot, which is the navbar's own
      // 56 px phone header height.
      const box = await bar.boundingBox()
      expect(box?.height).toBe(56)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
        .toBe(true)
    })

    test('the map fills the phone between the bar and the pitch card', async ({ page }) => {
      await serveBuildings(page)
      await page.goto('/map')
      await expect(page.getByRole('button', { name: 'Search buildings' })).toBeVisible()
      const note = page.getByTestId('preview-note')
      await expect(note).toContainText(MAP_MESSAGE)

      // The map card ends above the pitch card, so neither the card nor a
      // picked building's details hide part of it.
      const map = await page.locator('.purdue-map').boundingBox()
      const card = await note.locator('[role="status"]').boundingBox()
      const bar = await page.getByTestId('preview-bar').boundingBox()
      expect(map && card && bar).toBeTruthy()
      expect(map.y).toBeGreaterThanOrEqual(bar.y + bar.height)
      expect(map.y + map.height).toBeLessThanOrEqual(card.y)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
        .toBe(true)
    })

    test('free food fits the phone with the pitch card', async ({ page, mockApi }) => {
      mockApi.seedSharedEvents([FUEL_UP, CHILI])
      await page.goto('/free-food')
      await expect(page.getByText('Boiler Fuel Up')).toBeVisible()
      await expect(page.getByTestId('preview-note')).toContainText(FREE_FOOD_MESSAGE)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
        .toBe(true)
    })
  })
})

test.describe('Public preview pages, signed in', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedTransit({ routes: translocRoutes, stops: translocStops, vehicles: translocVehicles })
    await page.route(/server\.arcgisonline\.com/, (route) => route.abort())
  })

  test('dining keeps the navbar, the stars and the AI pick', async ({ page }) => {
    await page.goto('/dining')
    await expect(page.getByRole('button', { name: 'Add Silver Star Burger to favorites' })).toBeVisible()
    await expect(page.getByRole('button', { name: /What should I eat/ })).toBeVisible()
    await expect(page.getByRole('navigation').first()).toBeVisible()
    await expect(page.getByTestId('preview-bar')).toHaveCount(0)
  })

  test('free food reads the calendar window, with the My calendar pill, and never the public read', async ({ page, mockApi }) => {
    mockApi.seedCalendarItems([
      { id: 'own-pizza', title: 'Pizza with the CS club', category: 'campus_event', startTime: inHours(30), freeFood: true },
    ])
    mockApi.seedSharedEvents([FUEL_UP, CHILI])
    const freeFoodReads = recordFreeFoodReads(page)
    await page.goto('/free-food')

    await expect(page.getByText('Pizza with the CS club')).toBeVisible()
    const sources = page.getByRole('group', { name: 'Event source' })
    await expect(sources.getByRole('button')).toHaveText(['All sources', 'Purdue (1)', 'IU (1)', 'My calendar (1)'])
    await expect(page.getByRole('navigation').first()).toBeVisible()
    await expect(page.getByTestId('preview-bar')).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    expect(freeFoodReads).toEqual([])
  })

  test('the map keeps the navbar, and a garage popup links to every garage', async ({ page }) => {
    await serveBuildings(page)
    await page.goto('/map?layer=parking')
    await expect(page.locator('.parking-count-tooltip')).toHaveCount(3)
    await garagePins(page).first().click({ force: true })
    await expect(page.locator('.leaflet-popup').getByRole('link', { name: 'All garages' })).toHaveAttribute('href', '/parking')
    await expect(page.getByRole('navigation').first()).toBeVisible()
    await expect(page.getByTestId('preview-bar')).toHaveCount(0)
  })

  test('transit keeps the my-stop bell', async ({ page }) => {
    await page.goto('/transit')
    await page.locator('button.pill', { hasText: 'Crimson' }).click()
    await expect(page.getByText(/Bell = your stop/)).toBeVisible()
    await page.getByTitle('Set as my stop (chime at the stop before)').click()
    await expect(page.getByText('My stop', { exact: true })).toBeVisible()
    await expect(page.getByTestId('preview-bar')).toHaveCount(0)
  })
})
