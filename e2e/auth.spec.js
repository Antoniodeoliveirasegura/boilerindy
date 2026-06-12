import { test, expect } from './fixtures/mock-backend.js'

// Authentication flows: route guarding, failed sign-in, and successful sign-in.

test.describe('Authentication', () => {
  test('redirects an unauthenticated visitor from a protected route to login', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/schedule')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  })

  test('shows an error message when credentials are invalid', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login')

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('wrong-password')
    // Scope to the form so we hit the submit button, not the "Sign in" tab toggle.
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByText('Invalid email or password.')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('signs in with valid credentials and lands inside the app', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login')

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()

    // parseNextPath sends a fresh sign-in to /setup when no ?next is present.
    await expect(page).toHaveURL(/\/setup/)
    await expect(page).not.toHaveURL(/\/login/)
  })
})
