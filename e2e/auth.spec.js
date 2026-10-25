import { test, expect, LOGIN_CODE } from './fixtures/mock-backend.js'

// Authentication flows: route guarding, failed sign-in, and successful sign-in.

test.describe('Authentication', () => {
  test('redirects an unauthenticated visitor from a protected route to login', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/schedule')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  })

  // Issue #246 - the sponsor rails mount outside RequireAuth, so a signed-out
  // visit to an app route used to request /api/spotlight/active twice (a 401
  // each time) before the redirect. The rails now wait for the session.
  test('a signed-out visit to an app route requests no sponsor content', async ({ page, mockApi }) => {
    mockApi.logout()
    const spotlightRequests = []
    page.on('request', (request) => {
      if (request.url().includes('/api/spotlight/')) spotlightRequests.push(request.url())
    })
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    expect(spotlightRequests).toEqual([])
  })

  // Issue #369 - AppLayout rendered the navbar, bottom tab bar and assistant
  // while the session check was in flight, so a signed-out visitor saw the
  // signed-in app for the length of that request. A MutationObserver records
  // any <nav> that appears before the redirect reaches /login.
  test('a signed-out visit to an app route never shows the app shell before login', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.route('**/api/session', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      await route.fallback()
    })
    await page.addInitScript(() => {
      window.__appShellSeen = false
      const check = () => {
        if (window.location.pathname !== '/login' && document.querySelector('nav')) window.__appShellSeen = true
      }
      new MutationObserver(check).observe(document, { childList: true, subtree: true })
    })
    await page.goto('/events')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    expect(await page.evaluate(() => window.__appShellSeen)).toBe(false)
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

  test('asks for the emailed code after the password, and rejects a wrong one', async ({ page, mockApi }) => {
    mockApi.logout()
    mockApi.requireLoginCode()
    await page.goto('/login')

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
    // Opt-in, for a student's own device: lab and library computers are shared.
    await expect(page.getByLabel(/Trust this device/)).not.toBeChecked()

    await page.getByLabel('Verification code').fill('111111')
    await page.getByRole('button', { name: 'Verify and continue' }).click()
    await expect(page.getByText('That code is not right.', { exact: false })).toBeVisible()
    await expect(page).toHaveURL(/\/login/)

    await page.getByLabel('Verification code').fill(LOGIN_CODE)
    await page.getByRole('button', { name: 'Verify and continue' }).click()
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('a resend that finds the sign-in timed out goes back to the password form', async ({ page, mockApi }) => {
    mockApi.logout()
    mockApi.requireLoginCode()
    await page.goto('/login')

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

    mockApi.timeOutLoginCode()
    await page.getByRole('button', { name: 'Send a new code' }).click()
    await expect(page.getByText('This sign-in timed out.', { exact: false })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await expect(page.getByLabel('Verification code')).toHaveCount(0)
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

// Issue #389 - the sign-in page showed a bare "Loading…" until the server
// answered, and a Render cold start takes up to about 30 s. A first-time
// visitor waited all of it for a form that needs nothing from the server.
test.describe('Sign-in on a cold start', () => {
  test('a visitor with nothing stored gets the form at once and signs in while the server wakes', async ({ page, mockApi }) => {
    mockApi.logout()
    mockApi.coldStart(6_000)
    await page.goto('/login')
    await expect(page.getByLabel('Email address')).toBeVisible({ timeout: 2_000 })

    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()

    // The wait now lands on the submit, which says why. The floating pill
    // stays off this page.
    await expect(page.locator('form').getByRole('status')).toContainText('Waking up the server.')
    await expect(page.getByTestId('server-wake-notice')).toHaveCount(0)
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 10_000 })
  })

  // Boot's session read left before the student signed in, so its "nobody is
  // signed in" is older than the sign-in, and applying it signed them out again.
  test('a sign-in on the form outlasts the session check that was already out', async ({ page, mockApi }) => {
    mockApi.logout()
    let releaseBootRead
    const bootRead = new Promise((resolve) => {
      releaseBootRead = resolve
    })
    let held = false
    await page.route('**/api/session', async (route) => {
      if (held) return route.fallback()
      held = true
      await bootRead
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false, session: null }) })
    })
    await page.goto('/login')
    await page.getByLabel('Email address').fill('student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)

    const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session')
    releaseBootRead()
    await answered
    await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible()
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('a returning student sees the skeleton while the server wakes, then lands in the app', async ({ page, mockApi }) => {
    // A Google sign-in first, so this browser holds a Supabase session the
    // way a returning student's does.
    mockApi.enableGoogleSignIn()
    await page.goto('/login')
    await page.getByRole('button', { name: 'Continue with Google' }).click()
    await expect(page).toHaveURL(/\/(dashboard|setup)$/)

    mockApi.coldStart(5_000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/login')
    const status = page.locator('main').getByRole('status')
    await expect(status).toHaveText('Signing you in')
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible()
    await expect(page.getByLabel('Email address')).toHaveCount(0)
    // Held still for reduced motion.
    expect(await page.locator('main .skeleton').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none')

    // Once the wake-up ping drags on, the status line says why, in place of the pill.
    await expect(status).toContainText('Waking up the server.')
    await expect(page.getByTestId('server-wake-notice')).toHaveCount(0)
    await expect(page).toHaveURL(/\/(dashboard|setup)$/, { timeout: 10_000 })
  })

  // index.html paints the sign-in page's shape before the app has loaded.
  // Every route is served that same file, so only /login may show it.
  test('the sign-in page paints its shape before the app loads, and no other page does', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.route('**/assets/*.js', (route) => route.abort())
    await page.goto('/login')
    await expect(page.locator('.login-shell')).toBeVisible()
    await page.goto('/')
    await expect(page.locator('.login-shell')).toBeHidden()

    await page.unroute('**/assets/*.js')
    await page.goto('/login')
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible()
    await expect(page.locator('.login-shell')).toHaveCount(0)
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
