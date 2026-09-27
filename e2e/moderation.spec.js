import { test, expect } from './fixtures/mock-backend.js'

// Report and block on the website (issue #192), driven through the real
// /board and /settings pages against the mocked API. A student reports a post
// through the report dialog, blocks the author of a named post and stops
// seeing it (a reload included), and unblocks from Settings. An anonymous
// post offers Report only: the Blocked users list names everyone on it, so
// blocking an anonymous author would unmask them.

const RILEY = { authorId: 'e2e-user-riley', authorName: 'Riley Boilermaker' }

const notice = (page) => page.locator('[data-moderation-notice]')
const post = (page, title) => page.locator('article', { hasText: title })

test.describe('Report and block', () => {
  test('reports a board post with a reason and details', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedBoard({ posts: [{ id: 'post-scam', title: 'Selling parking passes cheap', ...RILEY }] })
    await page.goto('/board')

    await post(page, 'Selling parking passes cheap').getByRole('button', { name: 'Report' }).click()
    const dialog = page.getByRole('dialog', { name: 'Report this post' })
    await expect(dialog.getByRole('button', { name: 'Submit report' })).toBeDisabled()
    await dialog.getByLabel('Scam or fraud').check()
    await dialog.getByRole('button', { name: 'Add details (optional)' }).click()
    await dialog.getByLabel('Tell us more (optional)').fill('Asks for Venmo before meeting')
    await dialog.getByRole('button', { name: 'Submit report' }).click()

    await expect(notice(page)).toContainText('Thanks, our team will review it.')
    await expect(dialog).toBeHidden()
    await expect(post(page, 'Selling parking passes cheap').getByRole('button', { name: 'Report' })).toBeFocused()
    expect(mockApi.state.reports).toEqual([
      { targetType: 'board_post', targetId: 'post-scam', reason: 'scam', details: 'Asks for Venmo before meeting' },
    ])
  })

  test('blocks an author and their post stays gone after a reload; an anonymous post offers Report only', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedBoard({
      posts: [
        { id: 'post-riley', title: 'Selling parking passes cheap', ...RILEY },
        { id: 'post-anon', title: 'Anyone else locked out of ET?', authorId: 'e2e-user-quinn', authorName: 'Quinn', anon: true },
      ],
    })
    await page.goto('/board')

    const anonymous = post(page, 'Anyone else locked out of ET?')
    await expect(anonymous.getByRole('button', { name: 'Report' })).toBeVisible()
    await expect(anonymous.getByRole('button', { name: 'Block author' })).toHaveCount(0)

    await post(page, 'Selling parking passes cheap').getByRole('button', { name: 'Block author' }).click()
    const prompt = page.getByRole('dialog', { name: 'Block this author?' })
    await expect(prompt).toContainText("You will no longer see each other's posts.")
    await prompt.getByRole('button', { name: 'Block' }).click()

    await expect(post(page, 'Selling parking passes cheap')).toHaveCount(0)
    await expect(notice(page)).toContainText('Blocked. You can unblock them in Settings.')
    expect(mockApi.state.blocks.map((b) => b.userId)).toEqual([RILEY.authorId])

    await page.reload()
    await expect(page.getByText('Anyone else locked out of ET?')).toBeVisible()
    await expect(page.getByText('Selling parking passes cheap')).toHaveCount(0)
  })

  test('a block shows up in Settings, and unblocking there brings the posts back', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedBoard({ posts: [{ id: 'post-riley', title: 'Free couch, pick up today', ...RILEY }] })
    await page.goto('/board')
    await post(page, 'Free couch, pick up today').getByRole('button', { name: 'Block author' }).click()
    await page.getByRole('dialog', { name: 'Block this author?' }).getByRole('button', { name: 'Block' }).click()
    await expect(post(page, 'Free couch, pick up today')).toHaveCount(0)

    await page.goto('/settings')
    const card = page.getByTestId('blocked-users-card')
    await expect(card.getByRole('listitem')).toHaveText([/Riley Boilermaker/])
    await card.getByRole('button', { name: 'Unblock Riley Boilermaker' }).click()
    await expect(card).toContainText('You have not blocked anyone.')
    expect(mockApi.state.blocks).toEqual([])

    await page.goto('/board')
    await expect(post(page, 'Free couch, pick up today')).toBeVisible()
  })
})
