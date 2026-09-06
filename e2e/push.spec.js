import { test, expect } from './fixtures/mock-backend.js'

// Push notifications (#9). Drives the Settings card against the mocked
// /api/push/* endpoints. Headless Chromium has no push service and the
// permission prompt cannot be automated, so the subscribe flow itself is not
// exercised: these cover the account-level controls and the two states where
// the server cannot offer push at all.

test.describe('Push notifications settings card', () => {
  test('shows the controls when push is enabled and saves reminder changes', async ({ page, mockApi }) => {
    mockApi.login()
    // A fresh Playwright context reports Notification.permission as "denied",
    // which the card renders as the blocked state; grant it so the device
    // button appears (it is never clicked: there is no push service here).
    await page.context().grantPermissions(['notifications'])
    await page.goto('/settings')

    const card = page.getByTestId('push-card')
    await expect(card.getByText('Push notifications', { exact: true })).toBeVisible()
    await expect(page.getByTestId('push-status')).toContainText('On for 0 devices')
    const pushSupported = await page.evaluate(() => 'PushManager' in window && 'serviceWorker' in navigator)
    if (pushSupported) {
      await expect(page.getByTestId('push-enable')).toBeVisible()
    } else {
      await expect(card).toContainText('does not support push notifications')
    }
    await expect(page.getByTestId('push-test')).toBeDisabled()

    const toggle = page.getByTestId('push-deadline-toggle')
    const select = page.getByTestId('push-lead-select')
    await expect(toggle).toBeChecked()
    await expect(select).toHaveValue('60')

    const leadPut = page.waitForRequest((req) => req.method() === 'PUT' && req.url().includes('/api/push/settings'))
    await select.selectOption('120')
    expect((await leadPut).postDataJSON()).toEqual({ leadMinutes: 120 })
    await expect.poll(() => mockApi.state.push.settings.leadMinutes).toBe(120)

    await toggle.uncheck()
    await expect.poll(() => mockApi.state.push.settings.deadlineReminders).toBe(false)

    // Both changes come back from the (mock) server after a reload.
    await page.reload()
    await expect(page.getByTestId('push-lead-select')).toHaveValue('120')
    await expect(page.getByTestId('push-deadline-toggle')).not.toBeChecked()
  })

  test('explains when the server has no VAPID keys and offers no device button', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedPush({ config: { enabled: false } })
    await page.goto('/settings')

    await expect(page.getByTestId('push-status')).toContainText(
      'Push notifications are not switched on for this server yet.',
    )
    await expect(page.getByTestId('push-enable')).toHaveCount(0)
    await expect(page.getByTestId('push-lead-select')).toHaveCount(0)
  })

  test('surfaces the 503 message while the push tables are missing', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedPush({ notConfigured: true })
    await page.goto('/settings')

    await expect(page.getByTestId('push-status')).toContainText('the push tables are missing')
    await expect(page.getByTestId('push-enable')).toHaveCount(0)
    await expect(page.getByTestId('push-lead-select')).toHaveCount(0)
  })
})
