import { test, expect } from './fixtures/mock-backend.js'

// Issue #16: following a club. A student follows a club on /clubs, the follow
// is kept with the account (GET, PUT and DELETE /api/me/club-follows on the
// mocked backend), and the club's events get the "Clubs I follow" pill on
// Events and Free Food. Signed out, and before the server has README step 48,
// there is no follow UI at all.

const HOUR = 60 * 60 * 1000
const inHours = (hours) => new Date(Date.now() + hours * HOUR).toISOString()

// A shared campus event in the client shape of src/campusEventsFeed.mjs; the
// mock marks `followed` from the keys the student follows.
function sharedEvent(overrides) {
  return {
    sourceId: null,
    description: null,
    location: 'Campus Center 450',
    category: 'campus_event',
    externalUid: null,
    sourceType: 'campus',
    allDay: false,
    freeFood: false,
    shared: true,
    sourceKey: 'boilerlink',
    sourceLabel: 'BoilerLink',
    organizationKey: null,
    ...overrides,
  }
}

// The sample directory's Chess Club (id 1) and Run Club (id 3).
const CHESS_NIGHT = sharedEvent({
  id: 'campus:chess-night',
  title: 'Chess Club pizza and blitz night',
  startTime: inHours(26),
  endTime: inHours(28),
  freeFood: true,
  sourceUrl: 'https://boilerlink.purdue.edu/event/1001',
  organizationKey: 'boilerlink:1',
})
const CANAL_RUN = sharedEvent({
  id: 'campus:canal-run',
  title: 'Run Club canal loop',
  startTime: inHours(30),
  endTime: inHours(31),
  sourceUrl: 'https://boilerlink.purdue.edu/event/1002',
  organizationKey: 'boilerlink:3',
})
const CHILI = sharedEvent({
  id: 'campus:chili',
  title: 'United Way Chili Cook-off',
  startTime: inHours(50),
  endTime: inHours(52),
  freeFood: true,
  sourceKey: 'iu_events',
  sourceLabel: 'IU event',
  sourceUrl: 'https://events.iu.edu/event/chili-cook-off',
})

const chessToggle = (page) =>
  page.locator('[data-club-id="1"]').getByRole('button', { name: /^Follow(ing)? Chess Club Purdue Indianapolis$/ })

test.describe('Following a club', () => {
  test('a club followed on /clubs gets its events their own pill on Events and Free Food, kept across a reload', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedClubFollows([])
    mockApi.seedSharedEvents([CHESS_NIGHT, CANAL_RUN, CHILI])

    // Following nothing yet: the pill is there, and its empty state says where to follow clubs.
    await page.goto('/events')
    const sources = page.getByRole('group', { name: 'Event source' })
    await sources.getByRole('button', { name: 'Clubs I follow (0)' }).click()
    await expect(page.getByText('No events from clubs you follow')).toBeVisible()
    await page.getByRole('link', { name: 'Find clubs to follow' }).click()
    await expect(page).toHaveURL(/\/clubs$/)

    // Follow the Chess Club from its card.
    await expect(chessToggle(page)).toHaveAttribute('aria-pressed', 'false')
    await chessToggle(page).click()
    await expect(chessToggle(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(chessToggle(page)).toHaveText(/Following/)
    await expect(page.getByRole('button', { name: 'Following (1)' })).toBeVisible()
    // The toggle flips before the server answers; the PUT lands right after.
    await expect.poll(() => mockApi.state.clubFollows).toEqual(['boilerlink:1'])

    // The follow is the account's, not the page's.
    await page.reload()
    await expect(chessToggle(page)).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Following (1)' }).click()
    await expect(page).toHaveURL(/following=1/)
    await expect(page.locator('[data-club-id]')).toHaveCount(1)
    await expect(page.locator('[data-clubs-results]')).toHaveText('1 club you follow')

    // Events: only the followed club's event under the pill.
    await page.goto('/events')
    await page.getByRole('group', { name: 'Event source' }).getByRole('button', { name: 'Clubs I follow (1)' }).click()
    await expect(page.getByRole('button', { name: /Chess Club pizza and blitz night/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Run Club canal loop/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /United Way Chili Cook-off/ })).toHaveCount(0)

    // Free Food: the same, over its free-food list.
    await page.goto('/free-food')
    await page.getByRole('group', { name: 'Event source' }).getByRole('button', { name: 'Clubs I follow (1)' }).click()
    await expect(page.getByText('Chess Club pizza and blitz night')).toBeVisible()
    await expect(page.getByText('United Way Chili Cook-off')).toHaveCount(0)

    // Unfollowing from the Following view takes the club off it, and off the pill.
    await page.goto('/clubs?following=1')
    await chessToggle(page).click()
    await expect(page.locator('[data-club-id]')).toHaveCount(0)
    await expect(page.locator('[data-clubs-following-empty]')).toContainText('You do not follow any clubs yet')
    await expect.poll(() => mockApi.state.clubFollows).toEqual([])
    await page.goto('/events')
    await expect(page.getByRole('group', { name: 'Event source' }).getByRole('button', { name: 'Clubs I follow (0)' })).toBeVisible()
  })

  test('signed out there is no follow UI on /free-food, and before README step 48 none on /clubs', async ({ page, mockApi }) => {
    mockApi.seedSharedEvents([CHESS_NIGHT, CHILI])
    mockApi.seedClubFollows(['boilerlink:1'])
    await page.goto('/free-food')
    await expect(page.getByText('Chess Club pizza and blitz night')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Event source' }).getByRole('button')).toHaveText(['All sources', 'Purdue (1)', 'IU (1)'])
    await expect(page.getByText(/Clubs I follow/)).toHaveCount(0)

    // Signed in on a server whose follow routes answer club_follows_schema_missing.
    mockApi.state.clubFollows = null
    mockApi.login()
    await page.goto('/clubs')
    await expect(page.locator('[data-club-id]')).toHaveCount(3)
    await expect(page.locator('[data-club-follow]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Following/ })).toHaveCount(0)
    await expect(page.locator('[data-clubs-follows-failed]')).toHaveCount(0)
  })
})
