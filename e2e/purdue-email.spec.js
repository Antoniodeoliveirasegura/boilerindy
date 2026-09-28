import { test, expect } from './fixtures/mock-backend.js'

// Purdue email-code verification on the website (issue #181), driven through
// the real /setup, /settings and /marketplace pages against the mocked API.
// A student who signed up with a personal email, on a server where CAS and
// the mock link are off (as in production), links a @purdue.edu address by
// the code mailed to it: a wrong code is refused, the right one links, and the
// Settings card and the Marketplace posting gate follow without a reload.

test.describe('Purdue email verification', () => {
  test('an unlinked student verifies a Purdue email from setup, and Settings and the Marketplace follow', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.setUser({ email: 'student@gmail.com', purdueEmail: null, purdueUsername: null, hasPurdueLinked: false })
    mockApi.setOnboarding({ hasPurdueLinked: false })

    await page.goto('/marketplace')
    await expect(page.getByText('Link Purdue in setup to post.').first()).toBeVisible()

    await page.goto('/setup')
    const card = page.getByTestId('setup-purdue-email')
    await expect(card).toContainText('Optional.')
    await card.getByLabel('Purdue email address').fill('JDoe@Purdue.edu')
    await card.getByRole('button', { name: 'Send code' }).click()

    await expect(card).toContainText('We sent a 6-digit code to jdoe@purdue.edu')
    await expect(card.getByRole('button', { name: /^Send a new code in 1:0\d$|^Send a new code in 0:5\d$/ })).toBeDisabled()
    expect(mockApi.state.purdueChallenge).toMatchObject({ email: 'jdoe@purdue.edu', attempts: 0 })

    await card.getByLabel('Verification code').fill('000000')
    await card.getByRole('button', { name: 'Verify code' }).click()
    await expect(card.getByRole('alert')).toContainText('That code is not right.')
    expect(mockApi.state.purdueChallenge.attempts).toBe(1)

    await card.getByLabel('Verification code').fill('123456')
    await card.getByRole('button', { name: 'Verify code' }).click()
    await expect(page.getByText('Purdue email linked. You can post on the Marketplace now.')).toBeVisible()
    await expect(page.getByTestId('setup-purdue-email')).toHaveCount(0)
    expect(mockApi.state.user).toMatchObject({ hasPurdueLinked: true, purdueEmail: 'jdoe@purdue.edu' })

    await page.goto('/settings')
    const purdue = page.getByTestId('purdue-account-card')
    await expect(purdue.getByText('Linked', { exact: true })).toBeVisible()
    await expect(purdue).toContainText('jdoe@purdue.edu')

    await page.goto('/marketplace')
    await expect(page.getByRole('button', { name: 'Post a listing' })).toBeVisible()
  })
})
