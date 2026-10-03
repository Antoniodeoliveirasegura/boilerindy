import { test, expect } from './fixtures/mock-backend.js'

// Issue #373 - a route pill read "(1) off": a live bus on a route whose static
// schedule said it was not running. The live feed wins over the schedule, and
// a route with no bus reporting outside its hours reads "not running now"
// instead of a bare "off".

const translocRoutes = [
  { RouteID: 31, Description: 'Route 1 - Crimson', MapLineColor: '#990000' },
  { RouteID: 32, Description: 'Route 3 - Yellow', MapLineColor: '#F1BE48' },
]

// One bus on Crimson (Mon-Fri only, no weekend peer), none on Yellow.
const translocVehicles = [{ VehicleID: 501, RouteID: 31, Latitude: 39.7745, Longitude: -86.1756, GroundSpeed: 12, Name: '501' }]

test.describe('Transit route pills', () => {
  test('a weekday route with a live bus on a Sunday shows as running', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedTransit({ routes: translocRoutes, stops: [], vehicles: translocVehicles })
    // Keep the basemap offline, as in mobile-layout.spec.js.
    await page.route(/basemaps\.cartocdn\.com/, (route) => route.abort())
    // Noon on Sunday 2026-09-27 in Indianapolis.
    await page.clock.setFixedTime(new Date('2026-09-27T12:00:00-04:00'))
    await page.goto('/transit')

    await expect(page.getByRole('button', { name: 'All Routes (1)' })).toBeVisible()

    const crimson = page.locator('button.pill', { hasText: 'Crimson' })
    await expect(crimson).toContainText('(1)')
    await expect(crimson).not.toHaveClass(/opacity-40/)
    await expect(crimson).not.toContainText('not running')

    const yellow = page.locator('button.pill', { hasText: 'Yellow' })
    await expect(yellow).toHaveClass(/opacity-40/)
    await expect(yellow).toContainText('not running now')

    await expect(page.locator('button.pill', { hasText: /\boff\b/ })).toHaveCount(0)
  })
})
