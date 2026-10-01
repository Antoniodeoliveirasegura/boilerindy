import { test, expect } from './fixtures/mock-backend.js'

// Issue #367 - every page was titled just "BoilerIndy". Pages render their own
// <title>; React puts it ahead of the static one in index.html and removes it
// on unmount, so the landing page shows the static default again.

const DEFAULT_TITLE = 'BoilerIndy - campus app for Purdue Indianapolis students'

test.describe('Page titles', () => {
  test('a public page titles the tab, and the landing page gets the default back', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/privacy')
    await expect(page).toHaveTitle('Privacy policy - BoilerIndy')

    // Client-side navigation: the privacy page unmounts and takes its title along.
    await page.getByRole('link', { name: /back to boilerindy/i }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page).toHaveTitle(DEFAULT_TITLE)
  })

  test('a signed-in page titles the tab', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')
    await expect(page).toHaveTitle('Dashboard - BoilerIndy')
  })
})
