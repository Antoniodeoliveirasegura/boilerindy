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
    // The due-date field defaults to today, which is in the future (23:59), so
    // the new task is not filtered out as past-due.
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
