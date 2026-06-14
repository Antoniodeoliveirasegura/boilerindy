import { test, expect } from './fixtures/mock-backend.js'

// Grade tracker (#10) + degree planner (#18). Drives the real GradeTracker page
// against the stateful mock of /api/me/grades and /api/me/degree: adding a
// course updates the GPA and survives reload, deletes remove it, and selecting a
// major auto-checks the courses the student has passed (including "or" alternates).

test.describe('Grade tracker', () => {
  test('adding a course computes GPA and persists across reload', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/grade-tracker')

    await expect(page.getByRole('heading', { name: 'Grade Tracker' })).toBeVisible()

    await page.getByPlaceholder(/Course/).fill('CS 18000 Problem Solving')
    await page.getByPlaceholder(/Term/).fill('Fall 2025')
    await page.locator('input[type="number"]').fill('4')
    await page.getByLabel('Letter grade').selectOption('A')
    await page.getByRole('button', { name: 'Add course' }).click()

    // Course shows under its term; cumulative GPA reflects the single A.
    await expect(page.getByText('CS 18000 Problem Solving')).toBeVisible()
    await expect(page.getByText('Fall 2025')).toBeVisible()
    const gpaCard = page.locator('.card', { hasText: 'Cumulative GPA' }).first()
    await expect(gpaCard).toContainText('4.00')

    // The POST persisted to the mock, so a reload re-fetches the same course.
    await page.reload()
    await expect(page.getByText('CS 18000 Problem Solving')).toBeVisible()
  })

  test('cumulative GPA is credit-weighted across seeded courses', async ({ page, mockApi }) => {
    mockApi.login()
    // (4.0*3 + 2.7*4) / 7 = 3.257 -> 3.26
    mockApi.seedGrades([
      { courseName: 'CS 18000', term: 'Fall 2025', creditHours: 3, letterGrade: 'A' },
      { courseName: 'MA 26500', term: 'Fall 2025', creditHours: 4, letterGrade: 'B-' },
    ])
    await page.goto('/grade-tracker')

    const gpaCard = page.locator('.card', { hasText: 'Cumulative GPA' }).first()
    await expect(gpaCard).toContainText('3.26')
  })

  test('deleting a course removes it', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedGrades([{ courseName: 'PHYS 17200', term: 'Spring 2025', creditHours: 4, letterGrade: 'C' }])
    await page.goto('/grade-tracker')

    await expect(page.getByText('PHYS 17200')).toBeVisible()
    await page.getByRole('button', { name: 'Delete PHYS 17200' }).click()
    await expect(page.getByText('PHYS 17200')).toHaveCount(0)
  })
})

test.describe('Degree planner', () => {
  test('selecting a major auto-checks passed courses, including alternates', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedGrades([
      { courseName: 'CS 18000 Problem Solving', term: 'Fall 2025', creditHours: 4, letterGrade: 'A' },
      // MA 16500 satisfies the "MA 16100 (or MA 16500)" requirement.
      { courseName: 'MA 16500 Calculus I', term: 'Fall 2025', creditHours: 5, letterGrade: 'B+' },
    ])
    await page.goto('/grade-tracker')

    await page.getByLabel('Select your major').selectOption('computer-science')

    // The required CS 18000 row is marked done; CS 24000 (not taken) is not.
    await expect(page.locator('[data-req-code="CS 18000"]')).toHaveAttribute('data-done', 'true')
    await expect(page.locator('[data-req-code="CS 24000"]')).toHaveAttribute('data-done', 'false')
    // MA 16100 is satisfied via the MA 16500 alternate the student logged.
    await expect(page.locator('[data-req-code="MA 16100"]')).toHaveAttribute('data-done', 'true')

    // Overall progress reflects the two matched courses.
    await expect(page.getByText(/2 of \d+ listed courses/)).toBeVisible()
  })

  test('a failed course does not count toward the requirement', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedGrades([{ courseName: 'CS 18000', term: 'Fall 2025', creditHours: 4, letterGrade: 'F' }])
    mockApi.setMajor('computer-science')
    await page.goto('/grade-tracker')

    await expect(page.locator('[data-req-code="CS 18000"]')).toHaveAttribute('data-done', 'false')
  })

  test('the selected major persists across reload', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/grade-tracker')

    await page.getByLabel('Select your major').selectOption('data-science')
    await expect(page.locator('[data-req-code="CS 38003"]')).toBeVisible()

    await page.reload()
    await expect(page.getByLabel('Select your major')).toHaveValue('data-science')
  })
})
