import { test, expect } from './fixtures/mock-backend.js'

// /delete-account and /support (#193): the public URLs Google Play's Data
// Safety form and the App Store listing point at, so both must work for a
// visitor who is signed out and may not have the app at all.

test.describe('Delete account and support pages', () => {
  test('explains deletion and offers the email fallback to a signed-out visitor', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/delete-account')

    await expect(page.getByRole('heading', { level: 1, name: 'Delete your account' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Delete from the app' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'privacy@boilerindy.app', exact: true })).toHaveAttribute(
      'href',
      'mailto:privacy@boilerindy.app?subject=Delete%20my%20BoilerIndy%20account',
    )
  })

  test('support is linked from the site footer', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/privacy')
    await page.getByRole('link', { name: 'Support', exact: true }).click()

    await expect(page).toHaveURL(/\/support$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Support' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'support@boilerindy.app', exact: true })).toHaveAttribute(
      'href',
      'mailto:support@boilerindy.app',
    )
  })
})
