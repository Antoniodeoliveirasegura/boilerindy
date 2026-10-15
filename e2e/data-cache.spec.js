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

    // Wait for Events' read to land before leaving: TanStack aborts a read that
    // nothing on screen uses any more, so leaving while it is in flight makes
    // Free Food fetch it again. That race is not what this test is about, and
    // Events now shows its heading before its data, so it lost it more often.
    const eventsRead = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/me/calendar' && url.searchParams.get('limit') === '500'
    })
    await page.locator('a[href="/events"]').first().click()
    await expect(page.getByRole('heading', { name: 'Campus Events' })).toBeVisible()
    await eventsRead
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
