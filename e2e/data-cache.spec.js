import { test, expect } from './fixtures/mock-backend.js'

// Issue #327 - the signed-in reads go through the query cache, keyed by the
// user, so pages that repeat the same calendar read within the stale window
// share one entry instead of each fetching on mount.

test.describe('Per-user data cache', () => {
  test('Home, Events and Free Food within 30 s make one calendar request per distinct query', async ({ page, mockApi }) => {
    mockApi.login()
    const calendarRequests = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/me/calendar') calendarRequests.push(url.search)
    })

    await page.goto('/dashboard')
    await expect(page.getByText('Tasks Due')).toBeVisible()
    await expect.poll(() => calendarRequests.length).toBe(1)

    await page.locator('a[href="/events"]').first().click()
    await expect(page.getByRole('heading', { name: 'Campus Events' })).toBeVisible()
    await expect.poll(() => calendarRequests.length).toBe(2)

    // Free Food has no link on the Events page. A client-side navigation keeps
    // the in-memory cache, where page.goto would start a fresh document.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/free-food')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.getByRole('heading', { name: 'Free Food' })).toBeVisible()
    await page.waitForLoadState('networkidle')

    // Home's window (its own categories and limit) and the one Events and Free
    // Food share: two distinct queries, two requests, none for Free Food.
    expect(calendarRequests).toHaveLength(2)
    expect(new Set(calendarRequests).size).toBe(2)
  })
})
