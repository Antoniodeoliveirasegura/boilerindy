import { test, expect } from './fixtures/mock-backend.js'

// Issue #366 - signed-out visitors can open the live dining and transit pages
// to see the product is real before they hand over an email. Same URL and same
// page a student gets; the per-user pieces are hidden and the preview bar sits
// in the navbar's place. The trap this guards: one per-user request from a
// signed-out page answers 401, and authRequest then sends the visitor to
// /login with a false "session expired" banner. The mock answers those paths
// 401 signed out, as the server does, and no request to them may be made.

const PREVIEW_MESSAGE =
  "You're previewing live campus data. Create a free account to save favorites and get stop alerts."

// TransLoc rows in the shape the page reads: Crimson (canonical id 31) with two
// stops and one bus.
const translocRoutes = [{ RouteID: 31, Description: 'Route 1 - Crimson', MapLineColor: '#990000' }]
const translocStops = [
  { RouteID: 31, RouteStopID: 1001, Latitude: 39.7742, Longitude: -86.1761, Description: 'Campus Center' },
  { RouteID: 31, RouteStopID: 1002, Latitude: 39.7768, Longitude: -86.1739, Description: 'Library' },
]
const translocVehicles = [{ VehicleID: 501, RouteID: 31, Latitude: 39.7745, Longitude: -86.1756, GroundSpeed: 12, Name: '501' }]

const PER_USER_PREFIXES = ['/api/me/', '/api/assistant', '/api/spotlight/']

function recordPerUserRequests(page) {
  const seen = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (PER_USER_PREFIXES.some((prefix) => pathname.startsWith(prefix))) seen.push(`${request.method()} ${pathname}`)
  })
  return seen
}

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
    await expect(page).toHaveURL(/\/transit$/)
    expect(perUser).toEqual([])
    // The saved stop is untouched, there for the student when they sign in.
    expect(await page.evaluate(() => localStorage.getItem('transit-my-stop-31'))).toBe('"1002"')
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

      // The bar stays inside the 64 px navbar slot.
      const box = await bar.boundingBox()
      expect(box?.height).toBe(64)
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

  test('transit keeps the my-stop bell', async ({ page }) => {
    await page.goto('/transit')
    await page.locator('button.pill', { hasText: 'Crimson' }).click()
    await expect(page.getByText(/Bell = your stop/)).toBeVisible()
    await page.getByTitle('Set as my stop (chime at the stop before)').click()
    await expect(page.getByText('My stop', { exact: true })).toBeVisible()
    await expect(page.getByTestId('preview-bar')).toHaveCount(0)
  })
})
