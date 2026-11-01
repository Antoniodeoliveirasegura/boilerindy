import { test, expect } from './fixtures/mock-backend.js'

// Issue #34: IU's emergency alert for the Indianapolis campus in a banner
// above every page AppLayout renders, signed in or out, in IU's words with
// PurdueALERT's sign-up; nothing while CAMPUS_ALERTS is off (the mock's
// default) or nothing is active. Hiding one alert lasts for the tab.

const PREVIEW_MESSAGE =
  "You're previewing live campus data. Create a free account to save favorites and get stop alerts."
const SIGNUP = 'https://www.purdue.edu/ehps/emergency-preparedness/purduealert-text/'

function activeAlert(overrides = {}) {
  return {
    enabled: true,
    active: true,
    alert: {
      id: '17892038570001397900001',
      source: 'IU Indianapolis',
      sentAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      headline: 'IU Indy emergency: Dangerous situation near Sports Complex Garage',
      message: 'IU Indianapolis emergency: A dangerous situation is occurring on campus near Sports Complex Garage and Riverwalk Garage. Avoid the area and trust your instincts.',
      instruction: null,
      severity: 'Severe',
      level: 'danger',
      test: false,
      ...overrides,
    },
    checkedAt: new Date().toISOString(),
    stale: false,
  }
}

test.describe('Campus alert banner', () => {
  test('a signed-out visitor on a preview page sees the active alert, and can hide it for the tab', async ({ page, mockApi }) => {
    mockApi.seedCampusAlert(activeAlert())
    await page.goto('/dining')
    const banner = page.getByRole('region', { name: 'Campus alert' })
    await expect(banner.getByRole('alert')).toContainText('Dangerous situation near Sports Complex Garage')
    await expect(banner.getByRole('alert')).toContainText('Avoid the area and trust your instincts.')
    await expect(banner).toContainText('IU Indianapolis alert ·')
    await expect(banner.getByRole('link', { name: 'Get PurdueALERT texts' })).toHaveAttribute('href', SIGNUP)

    await banner.getByRole('button', { name: 'Hide this alert' }).click()
    await expect(banner).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('preview-bar')).toContainText(PREVIEW_MESSAGE)
    await expect(page.getByRole('region', { name: 'Campus alert' })).toHaveCount(0)

    // IU's next message has a new id and shows again.
    mockApi.seedCampusAlert(activeAlert({ id: '17892038570001397900002', headline: 'IU Indy final alert: There is no longer a threat near the Sports Complex Garage.' }))
    await page.reload()
    await expect(page.getByRole('region', { name: 'Campus alert' })).toContainText('There is no longer a threat')
  })

  test('a signed-in student sees it above the dashboard', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedCampusAlert(activeAlert())
    await page.goto('/dashboard')
    const banner = page.getByRole('region', { name: 'Campus alert' })
    await expect(banner.getByRole('alert')).toContainText('Dangerous situation near Sports Complex Garage')
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('nothing shows while the read is off or IU has given the all clear', async ({ page, mockApi }) => {
    await page.goto('/dining')
    await expect(page.getByTestId('preview-bar')).toContainText(PREVIEW_MESSAGE)
    await expect(page.getByRole('region', { name: 'Campus alert' })).toHaveCount(0)

    mockApi.seedCampusAlert({ enabled: true, active: false, alert: null, checkedAt: new Date().toISOString(), stale: false })
    await page.reload()
    await expect(page.getByTestId('preview-bar')).toContainText(PREVIEW_MESSAGE)
    await expect(page.getByRole('region', { name: 'Campus alert' })).toHaveCount(0)
  })
})
