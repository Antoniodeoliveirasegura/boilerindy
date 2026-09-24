import { test, expect, sampleDining } from './fixtures/mock-backend.js'

// Customizable home dashboard (issue #52). Exercises the real Home UI against
// the stateful mock of GET/PUT /api/me/dashboard: a new user gets the default
// layout, and hide / add / reorder edits all survive a full page reload (the
// mock persists the PUT body the same way the DB would).

const widgetOrder = (page) =>
  page.locator('[data-widget-id]').evaluateAll((els) => els.map((el) => el.dataset.widgetId))

test.describe('Dashboard customization', () => {
  test('a new user sees the default widgets', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')

    // Quick actions and the schedule card are visible by default.
    await expect(page.getByRole('link', { name: /Campus Map/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible()

    // calendar-feed ships hidden by default, so it is not in the grid.
    await expect(page.locator('[data-widget-id="calendar-feed"]')).toHaveCount(0)
  })

  test('hiding then re-adding a widget persists across reload', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')

    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
    await expect(page.locator('[data-widget-id="dining"]')).toHaveCount(1)

    // Hide the Dining snapshot widget; it leaves the grid and joins the picker.
    await page.getByRole('button', { name: 'Hide Dining snapshot' }).click()
    await expect(page.locator('[data-widget-id="dining"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Dining snapshot' })).toBeVisible()

    // Reload: the saved layout (dining hidden) is reloaded from the server.
    await page.reload()
    await expect(page.getByRole('link', { name: /Campus Map/ })).toBeVisible()
    await expect(page.locator('[data-widget-id="dining"]')).toHaveCount(0)

    // Re-add it from the picker, and confirm it sticks after another reload.
    await page.getByRole('button', { name: 'Customize' }).click()
    await page.getByRole('button', { name: 'Dining snapshot' }).click()
    await expect(page.locator('[data-widget-id="dining"]')).toHaveCount(1)

    await page.reload()
    await expect(page.getByText('Dining Snapshot')).toBeVisible()
  })

  test('reordering a widget persists across reload', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')

    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()

    const before = await widgetOrder(page)
    expect(before.indexOf('board')).toBeGreaterThan(before.indexOf('dining'))

    // Move the Student board widget up one slot (it swaps with Dining).
    await page.getByRole('button', { name: 'Move Student board up' }).click()
    await expect
      .poll(async () => {
        const order = await widgetOrder(page)
        return order.indexOf('board') < order.indexOf('dining')
      })
      .toBe(true)

    // The new order is restored from the server after a reload.
    await page.reload()
    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
    const after = await widgetOrder(page)
    expect(after.indexOf('board')).toBeLessThan(after.indexOf('dining'))
  })

  test('reset uses a styled in-app dialog and restores defaults', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')

    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()

    // Hide a default-visible widget so we can prove Reset brings it back.
    await page.getByRole('button', { name: 'Hide Dining snapshot' }).click()
    await expect(page.locator('[data-widget-id="dining"]')).toHaveCount(0)

    // Reset opens the custom dialog (an accessible role=dialog), not window.confirm.
    await page.getByRole('button', { name: 'Reset' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Reset dashboard?')).toBeVisible()

    // Confirm → dialog closes and defaults are restored (Dining is back).
    await dialog.getByRole('button', { name: 'Reset' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('[data-widget-id="dining"]')).toHaveCount(1)
  })
})

// Issue #251 - the client data cache. The dashboard paints from the last
// persisted snapshot before the network answers, and Home and Transit share
// one cache entry per dataset instead of each fetching their own.
test.describe('Client data cache', () => {
  test('a reload paints the persisted dining snapshot before the delayed response arrives', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedDining({ snapshot: sampleDining() })
    await page.goto('/dashboard')
    const widget = page.locator('[data-widget-id="dining"]')
    await expect(widget.getByText('Silver Star Burger')).toBeVisible()
    // The persister writes on a short throttle; wait for the row to be stored
    // rather than for a fixed time.
    await expect
      .poll(() => page.evaluate(() => (localStorage.getItem('boilerindy-query-cache') || '').includes('Silver Star Burger')))
      .toBe(true)

    // A later page.route runs first; fallback() hands the request on to the
    // fixture's handler once the delay has passed.
    await page.route('**/api/dining*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await route.fallback()
    })
    await page.reload()
    await expect(widget.getByText('Silver Star Burger')).toBeVisible({ timeout: 2500 })
  })

  test('Home and Transit share the transit cache: one routes request across both pages', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedTransit({
      routes: [{ RouteID: 31, Description: 'Route 1 - Crimson', MapLineColor: '#990000' }],
      stops: [{ RouteID: 31, RouteStopID: 1001, Latitude: 39.7742, Longitude: -86.1761, Description: 'Campus Center' }],
      vehicles: [{ VehicleID: 501, RouteID: 31, Latitude: 39.7745, Longitude: -86.1756, GroundSpeed: 12, Name: '501' }],
    })
    const routeRequests = []
    page.on('request', (request) => {
      if (request.url().includes('/api/transit/routes')) routeRequests.push(request.url())
    })

    await page.goto('/dashboard')
    await expect(page.getByText('Live shuttles')).toBeVisible()
    await expect.poll(() => routeRequests.length).toBe(1)

    await page.locator('a[href="/transit"]').first().click()
    await expect(page.getByRole('heading', { name: 'Campus Transit' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(routeRequests).toHaveLength(1)
  })
})
