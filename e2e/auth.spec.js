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

  // Issue #298. The backend sign-in is authoritative, so a failing client
  // Supabase sign-in must not take the session down with it. The fixture answers
  // every /auth/v1/** call with a 400, which is the same degraded path a Supabase
  // outage or a bad anon key produces in production.
  //
  // Deliberately deterministic: it waits for the failed token call and then for a
  // settling window, rather than polling a URL that is only briefly wrong. The
  // test above can sample inside the 6-22ms bounce window and pass by luck, which
  // is how this walked through CI as flake for weeks.
  test('a failed Supabase client sign-in does not bounce the student back to login', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login')

    const failedTokenCall = page.waitForResponse(
      (response) => response.url().includes('/auth/v1/token') && response.status() === 400,
    )

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()

    await failedTokenCall
    await page.waitForTimeout(500)

    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page).not.toHaveURL(/\/login/)
  })
})

// Issue #221 - the sign-in page has no navbar, but its brand panel comes first
// in the DOM, so the skip link still saves a keyboard user a stop.
test.describe('Skip link', () => {
  test('the first Tab on the sign-in page reaches the skip link and Enter lands in main', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()

    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused()

    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
  })
})
