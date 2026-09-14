import { test, expect } from './fixtures/mock-backend.js'

// Service worker updates (#220): once a page is controlled by the worker, a
// new worker version must install, wait, and surface the refresh prompt
// instead of activating silently. The preview build registers the real
// worker; a "new version" is produced by registering the same script under a
// different URL for the same scope, which the browser treats as a changed
// worker and installs behind the active one (Playwright's request routing
// does not reach the worker script fetch, so the script itself is not edited).

test.describe('Service worker update prompt', () => {
  test('a new worker version surfaces the refresh prompt', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')
    await page.waitForFunction(() => Boolean(navigator.serviceWorker && navigator.serviceWorker.controller), null, { timeout: 20000 })
    await expect(page.getByTestId('sw-update-toast')).toHaveCount(0)

    await page.evaluate(() => navigator.serviceWorker.register('/sw.js?v=e2e-next'))

    const toast = page.getByTestId('sw-update-toast')
    await expect(toast).toBeVisible({ timeout: 20000 })
    await expect(toast).toContainText('A new version of BoilerIndy is ready.')
    await expect(toast.getByRole('button', { name: 'Refresh' })).toBeVisible()

    // The prompt is dismissible; the waiting worker stays put.
    await toast.getByRole('button', { name: 'Later' }).click()
    await expect(page.getByTestId('sw-update-toast')).toHaveCount(0)
    const waiting = await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))
    expect(waiting).toBe(true)
  })
})
