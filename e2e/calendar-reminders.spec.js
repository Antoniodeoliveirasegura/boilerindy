import { test, expect } from './fixtures/mock-backend.js'

// Calendar reminders (Antoniodeoliveirasegura/boilerindy-app#150). "Don't ask
// again" on Setup used to be saved only in that browser (pih-skip-setup); the
// account keeps it now, so a student who turned reminders off is not sent to
// setup anywhere, Settings can turn them back on, and a browser that saved the
// choice before the account kept it carries it over once.

const profileSave = (page) =>
  page.waitForRequest((req) => req.method() === 'PATCH' && new URL(req.url()).pathname === '/api/me/profile')

test.describe('Calendar reminders', () => {
  test.beforeEach(({ mockApi }) => {
    mockApi.setOnboarding({ linkedSourceCount: 0, classCount: 0, needsScheduleSource: true })
  })

  test('with reminders off on the account, signing in without a calendar lands on the dashboard', async ({ page, mockApi }) => {
    mockApi.logout()
    mockApi.setUser({ calendarRemindersOff: true })
    await page.goto('/login')

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Finish Setup' })).toHaveCount(0)
  })

  test("Don't ask again saves the choice on the account, and Settings turns reminders back on", async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/setup')

    const saved = profileSave(page)
    await page.getByRole('button', { name: 'Don’t ask again' }).click()
    expect((await saved).postDataJSON()).toEqual({ calendarRemindersOff: true })
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect.poll(() => mockApi.state.user.calendarRemindersOff).toBe(true)
    await expect(page.getByRole('heading', { name: 'Finish Setup' })).toHaveCount(0)

    await page.goto('/settings')
    const box = page.getByRole('checkbox', { name: /remind me to connect calendars/i })
    await expect(box).not.toBeChecked()
    const back = profileSave(page)
    await box.click()
    expect((await back).postDataJSON()).toEqual({ calendarRemindersOff: false })
    await expect(page.getByText('Calendar reminders turned on.')).toBeVisible()
    await expect(box).toBeChecked()

    // Reminders are on again, so Home asks again.
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: 'Finish Setup' })).toBeVisible()
  })

  test('a choice this browser saved before the account kept it is sent to the account once', async ({ page, mockApi }) => {
    await page.addInitScript(() => localStorage.setItem('pih-skip-setup', '1'))
    mockApi.login()
    const saves = []
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && new URL(req.url()).pathname === '/api/me/profile') saves.push(req.postDataJSON())
    })

    const carried = profileSave(page)
    await page.goto('/dashboard')
    expect((await carried).postDataJSON()).toEqual({ calendarRemindersOff: true })
    await expect.poll(() => mockApi.state.user.calendarRemindersOff).toBe(true)
    await expect(page.getByRole('heading', { name: 'Finish Setup' })).toHaveCount(0)

    // Turned back on in the app later: this browser's old flag does not undo it.
    mockApi.state.user.calendarRemindersOff = false
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Finish Setup' })).toBeVisible()
    expect(saves).toEqual([{ calendarRemindersOff: true }])
  })

  test("before the migration, Don't ask again holds in this browser and reaches the account on a later visit", async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.setCalendarRemindersMissing()
    await page.goto('/setup')

    const refused = page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === '/api/me/profile',
    )
    await page.getByRole('button', { name: 'Don’t ask again' }).click()
    expect((await refused).status()).toBe(503)
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Finish Setup' })).toHaveCount(0)
    expect(mockApi.state.user.calendarRemindersOff).toBe(false)

    // The migration has run: the next visit sends the choice again.
    mockApi.setCalendarRemindersMissing(false)
    const carried = profileSave(page)
    await page.reload()
    expect((await carried).postDataJSON()).toEqual({ calendarRemindersOff: true })
    await expect.poll(() => mockApi.state.user.calendarRemindersOff).toBe(true)
    await expect(page.getByRole('heading', { name: 'Finish Setup' })).toHaveCount(0)
  })
})
