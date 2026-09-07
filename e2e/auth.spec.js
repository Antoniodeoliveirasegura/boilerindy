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

  test('sends a reset link from the forgot-password view', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login')

    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByRole('button', { name: 'Email me a reset link' }).click()

    await expect(page.getByText('a reset link is on the way', { exact: false })).toBeVisible()
  })

  test('returns from the forgot-password view to sign in', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login')

    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await page.getByRole('button', { name: 'Back to sign in' }).click()

    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  })

  test('signs in with valid credentials and lands inside the app', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login')

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()

    // The mock account already has a schedule source, so a fresh sign-in with
    // no ?next lands on the dashboard rather than the setup screen.
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('a fresh sign-in without a schedule source still lands on setup', async ({ page, mockApi }) => {
    mockApi.logout()
    mockApi.setOnboarding({ linkedSourceCount: 0, classCount: 0, needsScheduleSource: true })
    await page.goto('/login')

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/setup/)
  })

  test('an already signed-in visit to /login skips setup when a source is connected', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/login')
    await expect(page).toHaveURL(/\/dashboard/)
  })
})
