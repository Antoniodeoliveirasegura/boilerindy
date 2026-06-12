import { test, expect } from './fixtures/mock-backend.js'

// Calendar / class schedule: an authenticated user sees their imported term and
// meeting count rendered from the mocked /api/me/classes response.

test.describe('Class schedule', () => {
  test('renders the schedule page for an authenticated user', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedClasses(
      [
        {
          id: 'class-1',
          title: 'CS 251 Data Structures',
          startTime: '2026-02-02T15:30:00.000Z',
          endTime: '2026-02-02T16:20:00.000Z',
          location: 'LWSN B155',
          category: 'class',
        },
      ],
      { selectedTermKey: '2026-spring', selectedTermLabel: 'Spring 2026', totalInTerm: 5 },
    )

    await page.goto('/schedule')

    await expect(page.getByRole('heading', { name: 'Class Schedule' })).toBeVisible()
    // Subtitle is "<term> · <n> imported meetings", both mock-controlled.
    await expect(page.getByText('Spring 2026')).toBeVisible()
    await expect(page.getByText('5 imported meetings')).toBeVisible()
  })

  test('shows the current-term fallback when no classes are imported', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedClasses([], { selectedTermLabel: '', totalInTerm: 0 })

    await page.goto('/schedule')

    await expect(page.getByRole('heading', { name: 'Class Schedule' })).toBeVisible()
    await expect(page.getByText('Current term')).toBeVisible()
  })
})
