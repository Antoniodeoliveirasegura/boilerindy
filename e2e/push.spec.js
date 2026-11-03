import { test, expect } from './fixtures/mock-backend.js'

// Push notifications (#9). Drives the Settings card against the mocked
// /api/push/* endpoints. Headless Chromium has no push service and the
// permission prompt cannot be automated, so the subscribe flow itself is not
// exercised: these cover the account-level controls and the two states where
// the server cannot offer push at all.

test.describe('Push notifications settings card', () => {
  test('shows the controls when push is enabled and saves reminder changes', async ({ page, mockApi }) => {
    mockApi.login()
    await page.context().grantPermissions(['notifications'])
    await page.goto('/settings')

    const card = page.getByTestId('push-card')
    await expect(card.getByText('Push notifications', { exact: true })).toBeVisible()
    await expect(page.getByTestId('push-status')).toContainText('On for 0 devices')
    // Headless Chromium reports Notification.permission as "denied" even after
    // grantPermissions, so the card (correctly) shows the blocked copy there;
    // headed runs get the device button. Neither path clicks it: there is no
    // push service to subscribe with.
    const permission = await page.evaluate(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission))
    if (permission === 'denied') {
      await expect(card).toContainText('Notifications are blocked for BoilerIndy in this browser')
      await expect(page.getByTestId('push-enable')).toHaveCount(0)
    } else if (permission === 'unsupported') {
      await expect(card).toContainText('does not support push notifications')
    } else {
      await expect(page.getByTestId('push-enable')).toBeVisible()
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

  test('turns favorite-dish alerts on, and says when the server is not set up for them (issue #469)', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/settings')
    const dining = page.getByTestId('push-dining-toggle')
    await expect(dining).not.toBeChecked()
    await expect(dining).toBeEnabled()
    await expect(page.getByTestId('push-dining-note')).toContainText('One notification a day')
    const put = page.waitForRequest((req) => req.method() === 'PUT' && req.url().includes('/api/push/settings'))
    await dining.check()
    expect((await put).postDataJSON()).toEqual({ diningFavoriteAlerts: true })
    await expect.poll(() => mockApi.state.push.settings.diningFavoriteAlerts).toBe(true)
    await page.reload()
    await expect(page.getByTestId('push-dining-toggle')).toBeChecked()

    mockApi.seedPush({ diningAlertsAvailable: false })
    await page.reload()
    await expect(page.getByTestId('push-dining-toggle')).toBeDisabled()
    await expect(page.getByTestId('push-dining-note')).toContainText('Not available yet')
  })

  // Issue #550, README step 53: the choices by kind, saved on the account.
  test('sets the evening list, the reminder before each item and quiet hours, once the server has them', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedPush({ kindsAvailable: true, settings: { deadlineItems: false } })
    await page.goto('/settings')

    const digest = page.getByTestId('push-digest-select')
    await expect(digest).toHaveValue('1080')
    // Times inside quiet hours (11:00 PM to 8:00 AM) are offered but cannot be picked.
    await expect(digest.locator('option[value="420"]')).toBeDisabled()
    await expect(digest.locator('option[value="1200"]')).toBeEnabled()
    const putDigest = page.waitForRequest((req) => req.method() === 'PUT' && req.url().includes('/api/push/settings'))
    await digest.selectOption('1200')
    expect((await putDigest).postDataJSON()).toEqual({ digestMinute: 1200 })
    await expect.poll(() => mockApi.state.push.settings.digestMinute).toBe(1200)

    // The lead time waits for the reminder before each item.
    await expect(page.getByTestId('push-lead-select')).toBeDisabled()
    await page.getByTestId('push-items-toggle').check()
    await expect.poll(() => mockApi.state.push.settings.deadlineItems).toBe(true)
    await expect(page.getByTestId('push-lead-select')).toBeEnabled()

    // Quiet hours: a new start goes as a pair; off clears both.
    const putQuiet = page.waitForRequest((req) => req.method() === 'PUT' && req.url().includes('/api/push/settings'))
    await page.getByTestId('push-quiet-start').selectOption('1320')
    expect((await putQuiet).postDataJSON()).toEqual({ quietStart: 1320, quietEnd: 480 })
    await expect.poll(() => mockApi.state.push.settings.quietStart).toBe(1320)
    await page.getByTestId('push-quiet-toggle').uncheck()
    await expect.poll(() => mockApi.state.push.settings.quietEnd).toBe(null)
    await expect(page.getByTestId('push-quiet-start')).toHaveCount(0)

    // Classes come from the app, so the website only says how they are set.
    await expect(page.getByTestId('push-classes-note')).toContainText('Sent by the BoilerIndy app on your phone')

    await page.reload()
    await expect(page.getByTestId('push-digest-select')).toHaveValue('1200')
    await expect(page.getByTestId('push-items-toggle')).toBeChecked()
    await expect(page.getByTestId('push-quiet-toggle')).not.toBeChecked()
  })

  test('shows the card as before while the server has no choices by kind', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/settings')
    await expect(page.getByTestId('push-lead-select')).toBeEnabled()
    await expect(page.getByTestId('push-digest-select')).toHaveCount(0)
    await expect(page.getByTestId('push-quiet-toggle')).toHaveCount(0)
    await expect(page.getByTestId('push-classes-note')).toHaveCount(0)
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
