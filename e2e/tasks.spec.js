import { test, expect } from './fixtures/mock-backend.js'

// Assignment workflow: add a manual task, see it listed, then mark it complete.
// Exercises POST /api/me/tasks/manual, GET /api/me/tasks/meta, and
// PATCH /api/me/tasks/manual/:id through the real Assignments UI.

test.describe('Assignment workflow', () => {
  test('adds a manual task and marks it complete', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/assignments')

    await expect(page.getByRole('heading', { name: 'Assignments' })).toBeVisible()

    const title = 'E2E finish lab write-up'
    await page.getByLabel('Title').fill(title)
    // The due-date field defaults to the local calendar day (see the "east of
    // UTC" case below), so the task is due 23:59 local tonight, still in the
    // future, and the "past items" filter leaves it visible.
    await page.getByRole('button', { name: 'Add task' }).click()

    const taskCard = page.getByText(title)
    await expect(taskCard).toBeVisible()

    // Each task row has a checkbox button; before completion it offers "Mark as
    // done", after completion it flips to "Mark as not done".
    await page.getByRole('button', { name: 'Mark as done', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Mark as not done', exact: true })).toBeVisible()
    await expect(page.getByText(title)).toBeVisible()
  })

  test('keeps the task list empty before anything is added', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/assignments')

    await expect(page.getByRole('heading', { name: 'Assignments' })).toBeVisible()
    await expect(page.getByText('No items found')).toBeVisible()
  })
})

// The owner runs the app on KST (UTC+9). Between local midnight and 09:00 the
// UTC calendar date is still yesterday, so a due-date default computed with
// toISOString() dated every new task a day back and the "past items" filter
// hid it the moment it was added. Pinning the browser to Seoul just after
// midnight exercises that window on every run instead of only when the suite
// happens to execute during it.
test.describe('Assignment workflow east of UTC', () => {
  test.use({ timezoneId: 'Asia/Seoul' })

  test('defaults the due date to the local calendar day just after midnight', async ({ page, mockApi }) => {
    mockApi.login()
    // 00:30 on Wednesday 2026-09-09 in Seoul, which is still 2026-09-08 in UTC.
    await page.clock.setFixedTime(new Date('2026-09-09T00:30:00+09:00'))
    await page.goto('/assignments')

    await expect(page.getByRole('heading', { name: 'Assignments' })).toBeVisible()
    await expect(page.getByLabel('Due date')).toHaveValue('2026-09-09')

    const title = 'E2E read chapter three'
    await page.getByLabel('Title').fill(title)
    await page.getByRole('button', { name: 'Add task' }).click()

    // Due 23:59 local tonight: listed under Today rather than hidden as past.
    await expect(page.getByText(title)).toBeVisible()
    await expect(page.getByText('Today', { exact: true })).toBeVisible()
  })
})
