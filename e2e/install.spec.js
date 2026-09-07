import { test, expect } from './fixtures/mock-backend.js'

// /install (#9 follow-up): the public "add BoilerIndy to your phone" guide.
// Headless Chromium on Linux reports itself as a desktop, so the Computer
// steps are selected by default; the tabs switch the content.

test.describe('Install guide', () => {
  test('renders the walkthrough for a signed-out visitor and switches platforms', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/install')

    await expect(page.getByRole('heading', { name: 'Add BoilerIndy to your phone' })).toBeVisible()
    await expect(page.getByTestId('install-tab-desktop')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('install-steps')).toContainText('Install BoilerIndy')

    await page.getByTestId('install-tab-ios').click()
    await expect(page.getByTestId('install-tab-ios')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('install-steps')).toContainText('Open as Web App')

    await page.getByTestId('install-tab-android').click()
    await expect(page.getByTestId('install-steps')).toContainText('Add to Home screen')
    await expect(page.getByTestId('install-done')).toHaveCount(0)
  })

  test('is linked from the sign-in page', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login')
    await page.getByRole('link', { name: 'Add BoilerIndy to your Home Screen' }).click()
    await expect(page).toHaveURL(/\/install$/)
    await expect(page.getByTestId('install-page')).toBeVisible()
  })
})
