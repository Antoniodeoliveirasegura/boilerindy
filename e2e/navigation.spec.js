import { test, expect, LOGIN_CODE } from './fixtures/mock-backend.js'

// Moving around the app: where sign-in and sign-out land, the scroll position
// a new page opens at, menus that must not follow the student to the next
// page, URLs the router matches loosely, and a page whose code will not load.

// No service worker: once it controls the page, script requests go through it
// and page.route never sees them, so the slow and failed chunk tests would not
// be testing anything.
test.use({ serviceWorkers: 'block' })

// The desktop top nav, so a link name cannot match a page link like "Open schedule".
const topNav = (page, name) => page.locator('nav.topbar').getByRole('link', { name, exact: true })

async function signIn(page) {
  await page.getByLabel('Email address').fill('student@purdue.edu')
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click()
}

test.describe('Sign-in returns to the requested page', () => {
  // React Router applied the location change as a transition, so the session
  // update re-rendered /login first, and its "already signed in" redirect read
  // a URL that no longer had ?next: every redirected sign-in ended on Home.
  test('after a bounce from a protected page', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/schedule?view=week')
    await expect(page).toHaveURL(/\/login\?next=%2Fschedule%3Fview%3Dweek/)
    await signIn(page)
    await expect(page).toHaveURL(/\/schedule\?view=week$/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Schedule')
  })

  test('after the emailed two-step code', async ({ page, mockApi }) => {
    mockApi.logout()
    mockApi.requireLoginCode()
    await page.goto('/assignments')
    await signIn(page)
    await page.getByLabel('Verification code').fill(LOGIN_CODE)
    await page.getByRole('button', { name: 'Verify and continue' }).click()
    await expect(page).toHaveURL(/\/assignments$/)
  })

  test('from the preview bar on a public page', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/dining')
    await page.getByTestId('preview-bar').getByRole('link', { name: 'Sign in' }).click()
    await signIn(page)
    await expect(page).toHaveURL(/\/dining$/)
  })

  // URL parsing drops tabs and newlines, so this passed the old prefix check
  // and became "//evil.example/x", which React Router refuses by throwing.
  test('a next that only turns off-site once a tab is dropped is ignored, not a crash', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/login?next=%2F%09%2Fevil.example%2Fx')
    await signIn(page)
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0)
  })

  // Dot segments can leave a same-site URL whose path still starts with "//".
  test('a next that only turns off-site once dot segments are resolved is ignored, not a crash', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/login?next=%2F..%2F%2Fevil.example')
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0)
  })
})

test('signing out from a protected page lands on the landing page, not the sign-in form', async ({ page, mockApi }) => {
  mockApi.login()
  await page.goto('/settings')
  await page.getByRole('button', { name: 'TS' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0)
})

test('a new page opens at the top, and Back restores the old position', async ({ page, mockApi }) => {
  mockApi.login()
  await page.setViewportSize({ width: 1280, height: 480 })
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const before = await page.evaluate(() => window.scrollY)
  expect(before).toBeGreaterThan(200)

  await topNav(page, 'More').click()
  await expect(page).toHaveURL(/\/services$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test.describe('Menus close when the student navigates', () => {
  test('the account menu closes on Back and stays closed on Forward', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')
    await topNav(page, 'Tasks').click()
    await expect(page).toHaveURL(/\/assignments$/)
    await page.getByRole('button', { name: 'TS' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('menu')).toHaveCount(0)
    // And Forward onto the page it was opened on does not bring it back.
    await page.goForward()
    await expect(page).toHaveURL(/\/assignments$/)
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('with the account menu open, one click on a nav link navigates', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'TS' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await topNav(page, 'Schedule').click()
    await expect(page).toHaveURL(/\/schedule$/)
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('Escape closes the account menu and returns focus to its button', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')
    const avatar = page.getByRole('button', { name: 'TS' })
    await avatar.click()
    await page.getByRole('menuitem', { name: 'Settings' }).focus()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(avatar).toBeFocused()
    await expect(avatar).toHaveAttribute('aria-expanded', 'false')
  })

  test('the phone drawer closes on Back and stays closed on Forward', async ({ page, mockApi }) => {
    mockApi.login()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard')
    await page.locator('.tabbar').getByRole('link', { name: 'Schedule' }).click()
    await expect(page).toHaveURL(/\/schedule$/)
    await page.getByRole('button', { name: 'Toggle menu' }).click()
    const drawerLink = page.locator('.drawer-link', { hasText: 'Settings' })
    await expect(drawerLink).toBeInViewport()
    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(drawerLink).not.toBeInViewport()
    await page.goForward()
    await expect(page).toHaveURL(/\/schedule$/)
    await expect(drawerLink).not.toBeInViewport()
  })

  // The drawer covers the menu button, and its first link (Home) used to sit
  // right under it, so a second tap to close the drawer opened Home instead.
  test('a second tap where the phone menu button is closes the drawer', async ({ page, mockApi }) => {
    mockApi.login()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/settings')
    const toggle = page.getByRole('button', { name: 'Toggle menu' })
    const box = await toggle.boundingBox()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page).toHaveURL(/\/settings$/)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  test('Escape closes the phone drawer and returns focus to the menu button', async ({ page, mockApi }) => {
    mockApi.login()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/schedule')
    const toggle = page.getByRole('button', { name: 'Toggle menu' })
    await toggle.click()
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
  })

  test('an admin can reach the admin console from the phone drawer', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.setUser({ isAdmin: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Toggle menu' }).click()
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Admin console' }).click()
    await expect(page).toHaveURL(/\/admin$/)
  })
})

test.describe('URLs the router matches in any case or with a trailing slash', () => {
  test('still mark the current nav item', async ({ page, mockApi }) => {
    mockApi.login()
    for (const path of ['/Schedule', '/schedule/']) {
      await page.goto(path)
      await expect(page.locator('.topnav-link', { hasText: 'Schedule' })).toHaveAttribute('aria-current', 'page')
    }
  })

  test('still show the preview bar on a public page signed out', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/Dining')
    await expect(page.getByTestId('preview-bar')).toBeVisible()
  })
})

test('the admin access-denied page has its own tab title', async ({ page, mockApi }) => {
  mockApi.login()
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible()
  await expect(page).toHaveTitle('Access denied - BoilerIndy')
})

// Router transitions kept the old page, its tab title and its active nav item
// on screen, with no feedback, until a slow page's code arrived. Now a tap
// answers at once: the page is there (preloaded after sign-in) or the loader
// shows, and either way the nav item moves with it.
test('a nav tap answers at once even when the page code is slow', async ({ page, mockApi }) => {
  mockApi.login()
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.route('**/assets/*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.fallback()
  })
  await topNav(page, 'Events').click()
  await expect(page.locator('.topnav-link', { hasText: 'Events' })).toHaveAttribute('aria-current', 'page', { timeout: 500 })
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Events')
})

// overflow-x: hidden on the landing root made it the sticky nav's scroll
// container, so the nav scrolled away with its section links.
test('the landing nav stays at the top while the page scrolls', async ({ page, mockApi }) => {
  mockApi.logout()
  await page.goto('/')
  await page.getByRole('link', { name: 'A day on campus' }).click()
  await expect(page).toHaveURL(/#day$/)
  const nav = await page.getByRole('navigation').first().boundingBox()
  expect(Math.round(nav.y)).toBe(0)
})

// After a deploy, an open tab still runs the old build, and the old hashed
// chunk is gone (Vercel answers it with index.html). React.lazy remembers the
// failure, so the route stayed broken and the crash screen took the whole app.
test('a page whose code fails to load reloads once and opens', async ({ page, mockApi }) => {
  // Signed out, from the landing page: the public pages are never preloaded,
  // so the Privacy chunk is fetched on the click.
  mockApi.logout()
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // Every new chunk fails until the page reloads (chunk names are bare hashes,
  // so the Privacy chunk cannot be picked out by name).
  let stale = true
  page.on('request', (request) => {
    if (request.isNavigationRequest()) stale = false
  })
  await page.route('**/assets/*.js', async (route) => {
    if (!stale) return route.fallback()
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stale</title>' })
  })
  await page.locator('footer').getByRole('link', { name: 'Privacy' }).click()
  await expect(page).toHaveURL(/\/privacy$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Privacy')
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0)
})
