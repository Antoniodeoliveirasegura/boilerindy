import { test, expect } from './fixtures/mock-backend.js'

// Issue #30: the shared campus events. While CAMPUS_EVENTS_FEED is on the
// server adds them to the Events and Free Food read (GET /api/me/calendar
// ?shared=1), so a student with no linked calendar still finds campus events
// and free food. Each says where it came from and links out to its listing,
// and none reaches Tasks or Home, where a row can be marked done.

const HOUR = 60 * 60 * 1000
const inHours = (hours) => new Date(Date.now() + hours * HOUR).toISOString()

// The client shape of src/campusEventsFeed.mjs.
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
    sourceKey: 'purdue_events',
    sourceLabel: 'Purdue event',
    ...overrides,
  }
}

const LEAP = sharedEvent({
  id: 'campus:leap',
  title: 'LEAP Retreat',
  startTime: inHours(26),
  endTime: inHours(30),
  sourceUrl: 'https://events.purdue.edu/event/leap-retreat',
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

test.describe('Shared campus events', () => {
  test('a student with no linked calendar finds campus events and free food, each with its source and a link out', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.setOnboarding({ linkedSourceCount: 0 })
    mockApi.seedSharedEvents([LEAP, CHILI])

    await page.goto('/events')
    await expect(page.getByRole('heading', { name: 'Campus Events' })).toBeVisible()
    await expect(page.getByText('2 upcoming events from campus calendars')).toBeVisible()
    const leap = page.getByRole('button', { name: /LEAP Retreat/ })
    await expect(leap.getByText('Purdue event')).toBeVisible()
    await expect(page.getByRole('button', { name: /United Way Chili Cook-off/ }).getByText('IU event')).toBeVisible()

    // The source pills: IU's events alone, then every source again.
    const sources = page.getByRole('group', { name: 'Event source' })
    await sources.getByRole('button', { name: 'IU (1)' }).click()
    await expect(leap).toHaveCount(0)
    await expect(page.getByRole('button', { name: /United Way Chili Cook-off/ })).toBeVisible()
    await sources.getByRole('button', { name: 'All sources' }).click()
    await expect(leap).toBeVisible()

    await leap.click()
    const listing = page.getByRole('link', { name: 'View on events.purdue.edu' })
    await expect(listing).toHaveAttribute('href', 'https://events.purdue.edu/event/leap-retreat')
    await expect(listing).toHaveAttribute('target', '_blank')

    await page.goto('/free-food')
    await expect(page.getByRole('heading', { name: 'Free Food' })).toBeVisible()
    await expect(page.getByText('United Way Chili Cook-off')).toBeVisible()
    await expect(page.getByText('LEAP Retreat')).toHaveCount(0)
    // One source has free food, so there is nothing to filter by.
    await expect(page.getByRole('group', { name: 'Event source' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'View on events.iu.edu' })).toHaveAttribute(
      'href',
      'https://events.iu.edu/event/chili-cook-off',
    )
  })

  test('they never reach Tasks or Home, where a row can be marked done', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedSharedEvents([LEAP, CHILI])
    mockApi.seedCalendarItems([
      {
        id: 'cal-e2e-ps4',
        title: 'E2E problem set 4',
        category: 'assignment',
        startTime: inHours(48),
        endTime: inHours(48),
        allDay: false,
        location: null,
        description: '',
      },
    ])
    const reads = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/me/calendar') reads.push(url.searchParams)
    })

    await page.goto('/assignments')
    await expect(page.getByText('E2E problem set 4')).toBeVisible()
    await expect(page.getByText('LEAP Retreat')).toHaveCount(0)
    await expect(page.getByText('United Way Chili Cook-off')).toHaveCount(0)

    const homeRead = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/me/calendar')
    await page.goto('/dashboard')
    await homeRead
    await expect(page.getByText('Tasks Due')).toBeVisible()

    expect(reads.length).toBeGreaterThanOrEqual(2)
    expect(reads.filter((params) => params.has('shared'))).toEqual([])
  })
})
