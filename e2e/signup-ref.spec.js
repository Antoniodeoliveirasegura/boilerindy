import { test, expect } from './fixtures/mock-backend.js'

// The sign-up source (docs/analytics.md#sign-up-source): a ?ref= (or a
// ?utm_source=) on any public page is kept in the tab's sessionStorage, rides
// the email sign-up and the Google round trip to the request that creates the
// account, and is dropped once that request has gone through.

const KEY = 'boilerindy-signup-ref'
const heldRef = (page) => page.evaluate((key) => sessionStorage.getItem(key), KEY)
const bodiesOf = (mockApi, path) => mockApi.state.authBodies.filter((entry) => entry.path === path).map((entry) => entry.body)

test.describe('Sign-up source', () => {
  test('a tagged link to any public page is kept in the tab as its slug, and only there', async ({ page, mockApi }) => {
    mockApi.logout()
    for (const [path, ref] of [
      ['/?ref=Flyer_A', 'flyer-a'],
      ['/dining?ref=gc-cs180', 'gc-cs180'],
      ['/transit?utm_source=Instagram&utm_medium=bio', 'instagram'],
      ['/install?utm_source=instagram&ref=flyer-b', 'flyer-b'],
    ]) {
      await page.goto(path)
      await expect.poll(() => heldRef(page), { message: path }).toBe(ref)
    }
    // A page without a usable tag leaves the held one alone.
    for (const path of ['/dining', '/transit?ref=jane%40purdue.edu', '/install?ref=%21%21']) {
      await page.goto(path)
      await expect.poll(() => heldRef(page), { message: path }).toBe('flyer-b')
    }
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull()
    const cookies = await page.context().cookies()
    expect(cookies.filter((cookie) => cookie.value.includes('flyer'))).toEqual([])
  })

  test('an email sign-up sends the tag with the new account, then drops it', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/?ref=amb-jane')
    await page.getByRole('link', { name: /Get started/ }).first().click()
    await expect(page).toHaveURL(/\/login\?tab=signup$/)

    await page.getByLabel('Full name').fill('New Student')
    await page.getByLabel('Email address').fill('new.student@purdue.edu')
    await page.getByLabel('Password', { exact: true }).fill('a long enough password')
    await page.getByLabel('Confirm password').fill('a long enough password')
    await page.locator('form').getByRole('button', { name: 'Create account' }).click()

    await expect(page).not.toHaveURL(/\/login/)
    const [registered] = bodiesOf(mockApi, '/api/auth/register-supabase')
    expect(registered).toMatchObject({ email: 'new.student@purdue.edu', name: 'New Student', signupRef: 'amb-jane' })
    expect(await heldRef(page)).toBeNull()
    // The syncs that follow the sign-up carry no tag.
    for (const body of bodiesOf(mockApi, '/api/auth/supabase-sync')) expect(body).not.toHaveProperty('signupRef')
  })

  test('the Google round trip carries the tag from the landing page to the account it creates', async ({ page, mockApi }) => {
    mockApi.logout()
    mockApi.enableGoogleSignIn()
    const carriers = []
    page.on('request', (request) => {
      if (`${request.url()} ${request.postData() ?? ''}`.includes('flyer-b')) carriers.push(`${request.method()} ${new URL(request.url()).pathname}`)
    })

    await page.goto('/?ref=flyer-b')
    await page.getByRole('link', { name: /Get started/ }).first().click()
    const toGoogle = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/auth/v1/authorize'))
    await page.getByRole('button', { name: 'Continue with Google' }).click()

    // The browser left the site for the Supabase authorize URL (another origin),
    // and came back to /auth/callback in the same tab.
    const authorize = new URL((await toGoogle).url())
    expect(authorize.origin).not.toBe(new URL(page.url()).origin)
    expect(authorize.searchParams.get('provider')).toBe('google')
    expect(new URL(authorize.searchParams.get('redirect_to')).pathname).toBe('/auth/callback')
    await expect(page).toHaveURL(/\/(dashboard|setup)$/)

    const synced = bodiesOf(mockApi, '/api/auth/supabase-sync').filter((body) => body.email === 'new.student@gmail.com')
    expect(synced[0]).toMatchObject({ provider: 'google', signupRef: 'flyer-b' })
    expect(synced.slice(1).filter((body) => 'signupRef' in body)).toEqual([])
    expect(await heldRef(page)).toBeNull()
    // The tag went out twice: in the address of the page it was on, and in the
    // sync that created the account. Never to Google or Supabase Auth.
    expect(carriers).toEqual(['GET /', 'POST /api/auth/supabase-sync'])
  })
})
