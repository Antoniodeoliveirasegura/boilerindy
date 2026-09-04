import { test, expect, sampleParkingSnapshot } from './fixtures/mock-backend.js'

// Parking Status (#14). Drives the real /parking page against the mocked
// GET /api/parking/garages: live garages show counts and a status, a garage
// with no counts is presented as missing data rather than full, the permit
// block renders, and the degraded snapshot shows its banner.

test.describe('Parking status', () => {
  test('renders live garages with counts, status, and permit rules', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/parking')

    await expect(page.getByRole('heading', { name: 'Campus Parking' })).toBeVisible()

    const blackford = page.locator('[data-garage-id="blackford"]')
    await expect(blackford).toContainText('Blackford Garage')
    await expect(blackford).toContainText('975 of 1,143 open')
    await expect(blackford).toContainText('Open')
    await expect(blackford).toHaveAttribute('data-garage-status', 'open')

    const gateway = page.locator('[data-garage-id="gateway"]')
    await expect(gateway).toContainText('Filling up')
    await expect(gateway).toContainText('378 of 1,333 open')

    // No counts means "no live count", never "full".
    const barnhill = page.locator('[data-garage-id="barnhill"]')
    await expect(barnhill).toContainText('No live count')
    await expect(barnhill).toContainText('Counts unavailable')
    await expect(barnhill).not.toContainText('Full')

    // Header summary adds up the garages that reported counts.
    await expect(page.getByText('1,353 spaces open across 2 garages')).toBeVisible()

    await expect(page.getByRole('heading', { name: 'Student permits' })).toBeVisible()
    await expect(page.getByText('ST commuter student permit')).toBeVisible()
    await expect(page.getByRole('link', { name: /IU Parking Portal/ })).toHaveAttribute('href', /parkingiu\.t2hosted\.com/)
  })

  test('a degraded snapshot shows the outage banner and the garage list without counts', async ({ page, mockApi }) => {
    mockApi.login()
    const degraded = sampleParkingSnapshot({ ok: false, error: 'timeout' })
    degraded.garages = degraded.garages.map((g) => ({
      ...g,
      capacity: null,
      occupied: null,
      available: null,
      percentFull: null,
      status: 'unknown',
      icon: null,
      updatedAt: null,
      stale: true,
    }))
    mockApi.seedParking(degraded)
    await page.goto('/parking')

    await expect(page.locator('[data-parking-degraded]')).toContainText('Live counts are unavailable right now')
    await expect(page.locator('[data-garage-id]')).toHaveCount(3)
    await expect(page.getByText('No live counts right now')).toBeVisible()
  })

  test('the campus map can open with the parking layer on', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/map?layer=parking')

    const parkingToggle = page.getByRole('button', { name: 'Parking' }).first()
    await expect(parkingToggle).toHaveAttribute('aria-pressed', 'true')
    // Three sample garages become three live pins with their counts.
    await expect(page.locator('.parking-count-tooltip')).toHaveCount(3)
  })
})
