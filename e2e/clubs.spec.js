import { test, expect, sampleClubs } from './fixtures/mock-backend.js'

// Club directory (#16). Drives the real /clubs page against the mocked
// GET /api/clubs: Indianapolis groups by default with the deep links to
// BoilerLink, the All Purdue toggle, category and text filtering (URL-synced),
// paging with "Show more", the outage banner, and the way in from Services.

const cards = (page) => page.locator('[data-club-id]')

test.describe('Club directory', () => {
  test('defaults to the Indianapolis groups, with logos, categories and BoilerLink links', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/clubs')

    await expect(page.getByRole('heading', { name: 'Clubs & Organizations' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Indianapolis (3)' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'All Purdue (6)' })).toHaveAttribute('aria-pressed', 'false')
    await expect(cards(page)).toHaveCount(3)
    await expect(page.locator('[data-clubs-results]')).toHaveText('3 organizations in Indianapolis')

    const chess = page.locator('[data-club-id="1"]')
    await expect(chess).toContainText('Chess Club Purdue Indianapolis')
    await expect(chess).toContainText('Weekly meetings for players of every level')
    await expect(chess.getByRole('link', { name: 'BoilerLink' })).toHaveAttribute(
      'href',
      'https://boilerlink.purdue.edu/organization/indychess',
    )
    // No logo -> initials placeholder; a logo -> an image.
    await expect(chess.locator('[data-club-initials]')).toHaveText('CC')
    await expect(page.locator('[data-club-id="2"] img')).toHaveCount(1)

    // Purdue-wide orgs stay out of the default view.
    await expect(page.getByText('Boiler Robotics Club')).toHaveCount(0)
  })

  test('links The Circuit\'s newest student-orgs story, its club guide (issue #470)', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/clubs')
    const line = page.locator('[data-clubs-circuit]')
    await expect(line).toContainText("From The Circuit, Purdue Indy's student newspaper")
    await expect(line.getByRole('link', { name: 'Fall 2026 Club Guide' })).toHaveAttribute('href', 'https://circuitpress.org/fall-2026-club-guide/')
  })

  test('All Purdue widens the list; category and search narrow it and land in the URL', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/clubs')
    await expect(cards(page)).toHaveCount(3)

    await page.getByRole('button', { name: 'All Purdue (6)' }).click()
    await expect(cards(page)).toHaveCount(6)
    await expect(page).toHaveURL(/scope=all/)
    await expect(page.locator('[data-clubs-results]')).toHaveText('6 organizations across Purdue')
    // Indianapolis groups are badged once Purdue-wide ones are in the list.
    await expect(page.locator('[data-club-id="1"]')).toContainText('Indianapolis')

    await page.getByLabel('Category').selectOption('Hobby')
    await expect(cards(page)).toHaveCount(2)
    await expect(page).toHaveURL(/category=Hobby/)

    await page.getByLabel('Search organizations').fill('robot')
    await expect(cards(page)).toHaveCount(1)
    await expect(page.locator('[data-club-id="4"]')).toContainText('Boiler Robotics Club')
    await expect(page).toHaveURL(/q=robot/)
    await expect(page.locator('[data-clubs-results]')).toHaveText('1 match for "robot" in Hobby across Purdue')

    await page.getByRole('button', { name: 'Clear search' }).click()
    await expect(cards(page)).toHaveCount(2)
    await expect(page).not.toHaveURL(/q=/)
  })

  test('a category chip on a card filters the directory, and the empty state offers a way out', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/clubs')

    await page.locator('[data-club-id="2"]').getByRole('button', { name: 'Pre-Professional' }).click()
    await expect(page.getByLabel('Category')).toHaveValue('Pre-Professional')
    await expect(cards(page)).toHaveCount(1)

    await page.getByLabel('Search organizations').fill('sailing')
    await expect(page.locator('[data-clubs-empty]')).toContainText('No organizations match "sailing" in Pre-Professional in Indianapolis.')

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(cards(page)).toHaveCount(3)
    await expect(page.getByLabel('Category')).toHaveValue('')
  })

  test('shows more results one page at a time', async ({ page, mockApi }) => {
    mockApi.login()
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...sampleClubs()[0],
      id: `many-${i + 1}`,
      name: `Indianapolis Club ${String(i + 1).padStart(2, '0')}`,
      slug: `indyclub${i + 1}`,
    }))
    mockApi.seedClubs({ clubs: many })
    await page.goto('/clubs')

    await expect(cards(page)).toHaveCount(24)
    await page.getByRole('button', { name: 'Show more (6 left)' }).click()
    await expect(cards(page)).toHaveCount(30)
    await expect(page.getByRole('button', { name: /Show more/ })).toHaveCount(0)
  })

  test('an unreachable BoilerLink shows the outage banner instead of an empty grid', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedClubs({ degraded: true })
    await page.goto('/clubs')

    await expect(page.locator('[data-clubs-degraded]')).toContainText('BoilerLink is not answering right now')
    await expect(page.locator('[data-clubs-degraded]').getByRole('link', { name: 'open BoilerLink directly' })).toHaveAttribute(
      'href',
      'https://boilerlink.purdue.edu/',
    )
    await expect(cards(page)).toHaveCount(0)
    await expect(page.locator('[data-clubs-empty]')).toHaveCount(0)
  })

  test('Services links into the directory', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/services')

    await page.getByRole('link', { name: /Clubs & Organizations/ }).click()
    await expect(page).toHaveURL(/\/clubs$/)
    await expect(page.getByRole('heading', { name: 'Clubs & Organizations' })).toBeVisible()
  })
})
