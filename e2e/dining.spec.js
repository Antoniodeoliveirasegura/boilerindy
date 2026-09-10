import { test, expect, sampleDining, sampleDiningLocation } from './fixtures/mock-backend.js'

// Campus Dining (#119). Drives the real /dining page against the mocked
// GET /api/dining: Tower's stations, live status line and directions link, the
// Campus Center presented as a food court rather than a broken menu, a dining
// hall with nothing posted, the feed being down (no invented hours), a stale
// snapshot, and favorites surviving a reload.

test.describe('Campus dining', () => {
  test('Tower shows its stations, a live status line, real weekly hours and directions', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dining')

    await expect(page.getByRole('heading', { name: 'Campus Dining' })).toBeVisible()
    await expect(page.getByText('Menu for Wednesday, 2026-09-09')).toBeVisible()
    await expect(page.locator('[data-dining-location="tower-dining"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-dining-status]')).toHaveText('Open now · until 9:00 PM')
    await expect(page.locator('[data-dining-blurb]')).toContainText('Today: 7:00 AM - 9:00 PM · Menus: breakfast, lunch, dinner')

    const grill = page.locator('[data-dining-station="Daily Grill"]')
    await expect(grill).toContainText('Silver Star Burger')
    await expect(grill).toContainText('190 cal')
    await expect(grill).toContainText('Avoiding Gluten')
    await expect(page.locator('[data-dining-station]')).toHaveCount(2)

    await expect(page.getByRole('link', { name: 'Get Directions' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=University%20Tower%2C%20911%20W%20North%20St%2C%20Indianapolis%2C%20IN%2046202',
    )

    // Weekly hours: both halls, the campus weekday highlighted, weekends closed.
    await expect(page.locator('[data-dining-hours-for]')).toHaveCount(2)
    const todayCells = page.locator('[data-hours-today]')
    await expect(todayCells).toHaveCount(2)
    await expect(todayCells.first()).toContainText('Wed')
    await expect(page.locator('[data-dining-hours-for="tower-dining"]')).toContainText('Closed')
    await expect(page.getByText('7:00 - 10:30 AM')).toHaveCount(0)
  })

  test('the Campus Center is a food court, not a hall with a missing menu', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dining')
    await page.locator('[data-dining-location="campus-center"]').click()

    await expect(page.locator('[data-dining-selected="campus-center"]')).toBeVisible()
    await expect(page.getByText('Food court', { exact: true })).toBeVisible()
    await expect(page.locator('[data-dining-status]')).toHaveText('Closed · opens 7:00 AM')
    const empty = page.locator('[data-dining-empty="retail"]')
    await expect(empty).toContainText('Food court and retail vendors')
    await expect(empty).toContainText('Campus Center vendors serve from their own counters')
    await expect(page.getByText('No menu posted')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Get Directions' })).toHaveAttribute('href', /420%20University%20Blvd/)
  })

  test('a dining hall with nothing posted today says so, and keeps its real hours', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedDining({
      snapshot: sampleDining({
        locations: [sampleDiningLocation({ stations: [], menusPublished: false, meal: 'Menu not posted yet' })],
      }),
    })
    await page.goto('/dining')

    await expect(page.locator('[data-dining-empty="no-menu"]')).toContainText('No menu posted for today')
    await expect(page.locator('[data-dining-blurb]')).toContainText('Menu not posted yet')
    await expect(page.locator('[data-dining-hours-for="tower-dining"]')).toContainText('7:00 AM - 9:00 PM')
  })

  test('when the feed is down the page says so and invents nothing', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedDining({ unavailable: true })
    await page.goto('/dining')

    await expect(page.locator('[data-dining-error]')).toContainText('Live menus are temporarily unavailable.')
    await expect(page.locator('[data-dining-error]')).not.toContainText('sample')
    await expect(page.locator('[data-dining-location]')).toHaveCount(0)
    await expect(page.locator('[data-dining-no-hours]')).toContainText('Hours are not posted right now')
    await expect(page.getByText('7:00 - 10:30 AM')).toHaveCount(0)
    await expect(page.getByText('Breakfast', { exact: true })).toHaveCount(0)
  })

  test('a stale snapshot is labelled while the menu still renders', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedDining({ snapshot: sampleDining({ cached: true, stale: true }) })
    await page.goto('/dining')

    await expect(page.locator('[data-dining-stale]')).toContainText('last menu we fetched (2026-09-09)')
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toBeVisible()
    await expect(page.getByText('· cached')).toHaveCount(0)
  })

  test('starring an item lists it under favorites and survives a reload', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dining')

    const star = page.getByRole('button', { name: 'Add Silver Star Burger to favorites' })
    await star.click()
    await expect(page.getByRole('button', { name: 'Remove Silver Star Burger from favorites' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-dining-favorites]')).toContainText('Silver Star Burger')
    await expect(page.locator('[data-dining-favorites]')).toContainText('Tower Dining')

    await page.reload()
    await expect(page.locator('[data-dining-favorites]')).toContainText('Silver Star Burger')
    await page.getByRole('button', { name: 'Remove Silver Star Burger from favorites' }).click()
    await expect(page.locator('[data-dining-favorites]')).toHaveCount(0)
  })
})
