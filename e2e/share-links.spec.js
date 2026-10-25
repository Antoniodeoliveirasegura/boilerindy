import { test, expect, sampleDining, sampleDiningLocation } from './fixtures/mock-backend.js'

// Share links (docs/share-links.md): the Share buttons on /transit, /dining
// and /free-food send the view on screen with a ref, a signed-out friend who
// opens the link lands on that same view, and each page answers an unfurler
// with its own link preview instead of the home card.

// Tower posts a different special for each meal, so the meal on screen shows.
const tower = sampleDiningLocation({
  menus: [
    { meal: 'breakfast', stations: [{ name: 'Breakfast Entree Line', everyday: false, items: [{ name: 'Blueberry Pancakes', calories: 290, icons: ['Vegetarian'] }] }] },
    { meal: 'lunch', stations: [{ name: 'Chef Made Soups', everyday: false, items: [{ name: 'Chicken Miso Soup', calories: 90, icons: [] }] }] },
    { meal: 'dinner', stations: [{ name: 'Homestyle', everyday: false, items: [{ name: 'Beef Stroganoff', calories: 450, icons: [] }] }] },
  ],
})
const dining = sampleDining({ locations: [tower, sampleDining().locations[1]] })

// TransLoc rows in the shape the page reads: Crimson (canonical id 31) with
// two stops and one bus.
const translocRoutes = [{ RouteID: 31, Description: 'Route 1 - Crimson', MapLineColor: '#990000' }]
const translocStops = [
  { RouteID: 31, RouteStopID: 1001, Latitude: 39.7742, Longitude: -86.1761, Description: 'Campus Center' },
  { RouteID: 31, RouteStopID: 1002, Latitude: 39.7768, Longitude: -86.1739, Description: 'Library' },
]
const translocVehicles = [{ VehicleID: 501, RouteID: 31, Latitude: 39.7745, Longitude: -86.1756, GroundSpeed: 12, Name: '501' }]

async function expectDinner(page) {
  await expect(page.locator('[data-dining-location="tower-dining"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-dining-meal="dinner"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-dining-station="Homestyle"]')).toContainText('Beef Stroganoff')
  await expect(page.locator('[data-dining-station="Breakfast Entree Line"]')).toHaveCount(0)
}

test.describe('A shared dining link', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    // 8:00 AM on campus, so a plain /dining opens on breakfast.
    await page.clock.setFixedTime(new Date('2026-09-09T08:00:00-04:00'))
    mockApi.seedDining({ snapshot: dining })
  })

  test('opens on the same hall and meal for a signed-out friend', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/dining?hall=tower-dining&meal=dinner&ref=share-dining')

    await expect(page.getByTestId('preview-bar')).toBeVisible()
    await expectDinner(page)
    // The address stays as it came, ref included.
    await expect(page).toHaveURL(/\/dining\?hall=tower-dining&meal=dinner&ref=share-dining$/)
  })

  test('opens on another hall a link names', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/dining?hall=campus-center&ref=share-dining')
    await expect(page.locator('[data-dining-location="campus-center"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-dining-selected="campus-center"]')).toBeVisible()
  })

  test('the link a student copies opens their hall and meal for a friend who is signed out', async ({ page, context, mockApi }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    mockApi.login()
    await page.goto('/dining')
    await expect(page.locator('[data-dining-meal="breakfast"]')).toHaveAttribute('aria-pressed', 'true')

    await page.locator('[data-dining-meal="dinner"]').click()
    await expect(page).toHaveURL(/\/dining\?hall=tower-dining&meal=dinner$/)
    await page.getByRole('button', { name: 'Share' }).click()
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible()
    const link = await page.evaluate(() => navigator.clipboard.readText())
    expect(link).toBe(new URL('/dining?hall=tower-dining&meal=dinner&ref=share-dining', page.url()).href)

    // The friend has no account.
    mockApi.logout()
    await page.goto(link)
    await expect(page.getByTestId('preview-bar')).toBeVisible()
    await expectDinner(page)
  })

  test('a link shared before any pick still names the hall and meal on screen', async ({ page, context, mockApi }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    mockApi.logout()
    await page.goto('/dining')
    await expect(page.locator('[data-dining-meal="breakfast"]')).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Share' }).click()
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      new URL('/dining?hall=tower-dining&meal=breakfast&ref=share-dining', page.url()).href,
    )
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('Share opens the share sheet with the link', async ({ page, mockApi }) => {
      await page.addInitScript(() => {
        window.__shared = []
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: (data) => {
            window.__shared.push(data)
            return Promise.resolve()
          },
        })
      })
      mockApi.logout()
      await page.goto('/dining?hall=tower-dining&meal=dinner')
      await expectDinner(page)
      await page.getByRole('button', { name: 'Share' }).click()

      await expect.poll(() => page.evaluate(() => window.__shared)).toEqual([
        {
          title: "Today's campus dining menu - BoilerIndy",
          text: 'Dinner at Tower Dining, on BoilerIndy',
          url: new URL('/dining?hall=tower-dining&meal=dinner&ref=share-dining', page.url()).href,
        },
      ])
      // The page does not widen past the screen with the extra button.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    })
  })
})

test.describe('A shared bus link', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    mockApi.seedTransit({ routes: translocRoutes, stops: translocStops, vehicles: translocVehicles })
    // Keep the Esri basemap offline.
    await page.route(/server\.arcgisonline\.com/, (route) => route.abort())
  })

  test('opens on the same route for a signed-out friend, who is invited to sign in for the chime', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/transit?route=31&ref=share-bus')

    await expect(page.getByRole('heading', { name: 'Route 1 - Crimson' })).toBeVisible()
    await expect(page.locator('button.pill', { hasText: 'Crimson' })).toHaveClass(/pill-active/)
    const invite = page.locator('[data-transit-chime-invite]')
    await expect(invite).toContainText('Get a chime when the bus reaches the stop before yours.')
    await expect(invite.getByRole('link', { name: 'Sign in to set your stop' })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent('/transit?route=31&ref=share-bus')}`,
    )
    // Still no bell signed out.
    await expect(page.getByTitle(/my stop|before/i)).toHaveCount(0)
  })

  test('the Share button copies the route on screen with the bus ref', async ({ page, context, mockApi }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    mockApi.login()
    await page.goto('/transit')
    await page.locator('button.pill', { hasText: 'Crimson' }).click()
    await page.getByRole('button', { name: 'Share' }).click()

    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL('/transit?route=31&ref=share-bus', page.url()).href)
    // A signed-in student keeps the bell and gets no invitation.
    await expect(page.locator('[data-transit-chime-invite]')).toHaveCount(0)
  })
})

// Shared campus events with free food, in the client shape of
// src/campusEventsFeed.mjs, timed from a fixed Wednesday morning: eight of
// them, so the last is well below the fold on a laptop.
const FREE_FOOD_NOW = new Date('2026-09-09T08:00:00-04:00')
const HOUR = 60 * 60 * 1000
function freeFoodEvent(slug, title, hoursAhead) {
  const start = FREE_FOOD_NOW.getTime() + hoursAhead * HOUR
  return {
    id: `campus:${slug}`,
    sourceId: null,
    title,
    description: null,
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + 2 * HOUR).toISOString(),
    location: 'Campus Center 450',
    category: 'campus_event',
    externalUid: null,
    sourceType: 'campus',
    allDay: false,
    freeFood: true,
    shared: true,
    sourceKey: 'purdue_events',
    sourceLabel: 'Purdue event',
    sourceUrl: `https://events.purdue.edu/event/${slug}`,
  }
}
const FREE_FOOD = [
  freeFoodEvent('fuel-up', 'Boiler Fuel Up', 4),
  freeFoodEvent('pizza-night', 'Pizza Night at the Library', 9.5),
  freeFoodEvent('bagels', 'Bagels with the Dean', 28),
  freeFoodEvent('tacos', 'Taco Social', 33.5),
  freeFoodEvent('study-snacks', 'Study Break Snacks', 52),
  freeFoodEvent('coffee', 'Coffee and Careers', 57.5),
  freeFoodEvent('ice-cream', 'Ice Cream Social', 76),
  freeFoodEvent('chili', 'United Way Chili Cook-off', 81.5),
]

test.describe('A shared free-food link', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    await page.clock.setFixedTime(FREE_FOOD_NOW)
    mockApi.seedSharedEvents(FREE_FOOD)
  })

  test('opens on the event it names for a signed-out friend, scrolled to and marked', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/free-food?event=chili&ref=share-free-food')

    await expect(page.getByTestId('preview-bar')).toBeVisible()
    const linked = page.locator('[data-linked-event]')
    await expect(linked).toHaveCount(1)
    await expect(linked).toContainText('United Way Chili Cook-off')
    await expect(linked).toContainText('Shared with you')
    await expect(linked).toBeInViewport()
    // The rest of the list is there too, and the address stays as it came.
    await expect(page.getByText('Boiler Fuel Up')).toBeAttached()
    await expect(page.locator('[data-linked-event-missing]')).toHaveCount(0)
    await expect(page).toHaveURL(/\/free-food\?event=chili&ref=share-free-food$/)
  })

  test('a student shares one event, and a friend who is signed out lands on it', async ({ page, context, mockApi }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    mockApi.login()
    await page.goto('/free-food')
    await page.getByRole('button', { name: 'Share Ice Cream Social' }).click()
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible()
    const link = await page.evaluate(() => navigator.clipboard.readText())
    expect(link).toBe(new URL('/free-food?event=ice-cream&ref=share-free-food', page.url()).href)

    // The friend has no account.
    mockApi.logout()
    await page.goto(link)
    await expect(page.getByTestId('preview-bar')).toBeVisible()
    await expect(page.locator('[data-linked-event]')).toContainText('Ice Cream Social')
    await expect(page.locator('[data-linked-event]')).toBeInViewport()
  })

  test('the header Share sends the whole list, not the event a link opened it on', async ({ page, context, mockApi }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    mockApi.logout()
    await page.goto('/free-food?event=chili&ref=share-free-food')
    await expect(page.locator('[data-linked-event]')).toBeInViewport()

    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL('/free-food?ref=share-free-food', page.url()).href)
  })

  test('a link to an event that is over says so, above the rest of the list', async ({ page, mockApi }) => {
    mockApi.logout()
    await page.goto('/free-food?event=last-weeks-picnic&ref=share-free-food')

    await expect(page.locator('[data-linked-event-missing]')).toContainText('That event is not listed any more')
    await expect(page.getByText('Boiler Fuel Up')).toBeVisible()
    await expect(page.locator('[data-linked-event]')).toHaveCount(0)
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test("an event's Share opens the share sheet with what it is and when", async ({ page, mockApi }) => {
      await page.addInitScript(() => {
        window.__shared = []
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: (data) => {
            window.__shared.push(data)
            return Promise.resolve()
          },
        })
      })
      mockApi.logout()
      await page.goto('/free-food')
      await page.getByRole('button', { name: 'Share Pizza Night at the Library' }).click()

      await expect.poll(() => page.evaluate(() => window.__shared.length)).toBe(1)
      const [shared] = await page.evaluate(() => window.__shared)
      expect(shared.title).toBe('Free food on campus - BoilerIndy')
      // The day spelled out, where the row says Today: the message stays in the chat.
      expect(shared.text).toMatch(/^Free food at Pizza Night at the Library, Wed, Sep 9, 5:30\sPM, on BoilerIndy$/)
      expect(shared.url).toBe(new URL('/free-food?event=pizza-night&ref=share-free-food', page.url()).href)
      // The page does not widen past the screen with the row's Share.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    })
  })
})

// What a chat app's unfurler gets: the HTML, never the running app.
test.describe('Link previews', () => {
  const UNFURLER = { 'User-Agent': 'facebookexternalhit/1.1', Accept: 'text/html' }

  for (const { link, title, image } of [
    { link: '/transit?route=31&ref=share-bus', title: 'JAGLINE live bus map - BoilerIndy', image: 'og-transit.png' },
    { link: '/dining?hall=tower-dining&meal=dinner&ref=share-dining', title: "Today's campus dining menu - BoilerIndy", image: 'og-dining.png' },
    // One card for the list and for every single event's link.
    { link: '/free-food?event=chili&ref=share-free-food', title: 'Free food on campus - BoilerIndy', image: 'og-free-food.png' },
  ]) {
    const path = link.split('?')[0]

    test(`${path} answers with its own card`, async ({ request }) => {
      const res = await request.get(link, { headers: UNFURLER })
      expect(res.status()).toBe(200)
      const html = await res.text()
      expect(html).toContain(`<title>${title}</title>`)
      expect(html).toContain(`<meta property="og:title" content="${title}" />`)
      expect(html).toContain(`<meta property="og:url" content="https://www.boilerindy.app${path}" />`)
      expect(html).toContain(`<meta property="og:image" content="https://www.boilerindy.app/${image}" />`)
      expect(html).toContain(`<meta name="twitter:image" content="https://www.boilerindy.app/${image}" />`)
      expect(html).not.toMatch(/content="[^"]*og-image\.png"/)

      const card = await request.get(`/${image}`)
      expect(card.status()).toBe(200)
      expect(card.headers()['content-type']).toBe('image/png')
    })
  }

  test('every other page keeps the home card', async ({ request }) => {
    for (const path of ['/', '/events', '/login']) {
      const html = await (await request.get(path, { headers: UNFURLER })).text()
      expect(html, path).toContain('<meta property="og:image" content="https://www.boilerindy.app/og-image.png" />')
    }
  })
})
