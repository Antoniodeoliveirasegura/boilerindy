import { test, expect } from './fixtures/mock-backend.js'

// Connect calendar sources (#120): the paste box is the production path for
// both feeds, so the page has to tell a student where the link comes from and
// catch the obvious wrong paste (the other provider's link) before the API
// round trip. The mock backend never sees a request in this test: the
// client-side check in lib/scheduleSourceUrl.ts stops the submit.

test.describe('Connect calendar sources', () => {
  test('shows provider steps and rejects a link from the other provider inline', async ({ page, mockApi }) => {
    mockApi.login()

    await page.goto('/setup')
    await expect(page.getByRole('heading', { name: 'Add Calendar Source' })).toBeVisible()

    // Brightspace is selected by default: its steps and its "open" link show.
    const steps = page.getByTestId('source-steps')
    await expect(steps).toContainText('How to get the link')
    await expect(steps).toContainText('Open the Calendar tool and choose Subscribe.')
    await expect(steps.getByRole('link', { name: 'Open Brightspace' })).toHaveAttribute('href', 'https://purdue.brightspace.com/')

    // Switch to the class schedule: the steps and link follow the provider.
    await page.getByRole('button', { name: /^Schedule/ }).click()
    await expect(steps).toContainText('choose Export, then iCalendar')
    await expect(steps.getByRole('link', { name: 'Open Purdue Timetabling' })).toHaveAttribute(
      'href',
      'https://timetable.mypurdue.purdue.edu/Timetabling/personal',
    )

    // Pasting a Brightspace link into the class-schedule box is the common
    // mistake; the hint names the expected host and nothing is submitted.
    const box = page.getByLabel('iCalendar Feed URL')
    await box.fill('https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=abc')
    await page.getByRole('button', { name: 'Connect Schedule' }).click()
    const hint = page.getByRole('alert')
    await expect(hint).toHaveText(
      'The class schedule link comes from timetable.mypurdue.purdue.edu. This one is from purdue.brightspace.com.',
    )
    await expect(box).toHaveAttribute('aria-invalid', 'true')
    await page.screenshot({ path: test.info().outputPath('connect-sources-hint.png'), fullPage: true })

    // Typing again clears the hint; the schedule page itself gets its own hint.
    await box.fill('https://timetable.mypurdue.purdue.edu/Timetabling/personal')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: 'Connect Schedule' }).click()
    await expect(page.getByRole('alert')).toContainText('That is the Personal Schedule page itself.')
  })
})
