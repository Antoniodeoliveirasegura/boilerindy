import { test, expect } from './fixtures/mock-backend.js'

// Unknown URLs (#245, #222): vite preview serves the SPA shell for any path,
// so the router's catch-all must render a real page with a way onward instead
// of a blank screen.

test.describe('Not found page', () => {
  test('shows the heading, the disclaimer and a sign-in link to a signed-out visitor', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/does-not-exist')

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/')
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login')
    await expect(page.getByText(/not affiliated with/i)).toBeVisible()
  })

  test('links a signed-in visitor to the dashboard', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/does-not-exist')

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to your dashboard' })).toHaveAttribute('href', '/dashboard')
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0)
  })
})
