import { test, expect, sampleDining, sampleDiningLocation } from './fixtures/mock-backend.js'

// Campus Dining (#119). Drives the real /dining page against the mocked
// GET /api/dining: Tower's stations, live status line and directions link, the
// Campus Center presented as a food court rather than a broken menu, a dining
// hall with nothing posted, the feed being down (no invented hours), a stale
// snapshot, and favorites surviving a reload.

test.describe('Campus dining', () => {
  test('Tower shows its stations, a live status line, real weekly hours and directions', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dining')

    await expect(page.getByRole('heading', { name: 'Campus Dining' })).toBeVisible()
    await expect(page.getByText('Menu for Wednesday, 2026-09-09')).toBeVisible()
    await expect(page.locator('[data-dining-location="tower-dining"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-dining-status]')).toHaveText('Open now · until 9:00 PM')
    await expect(page.locator('[data-dining-blurb]')).toContainText('Today: 7:00 AM - 9:00 PM · Menus: breakfast, lunch, dinner')

    const grill = page.locator('[data-dining-station="Daily Grill"]')
    await expect(grill).toContainText('Silver Star Burger')
    await expect(grill).toContainText('190 cal')
    await expect(grill).toContainText('Avoiding Gluten')
    await expect(page.locator('[data-dining-station]')).toHaveCount(2)

    await expect(page.getByRole('link', { name: 'Get Directions' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=University%20Tower%2C%20911%20W%20North%20St%2C%20Indianapolis%2C%20IN%2046202',
    )

    // Weekly hours: both halls, the campus weekday highlighted. Tower serves
    // weekend menus the feed lists no hours for (issue #465); the Campus
    // Center posts no menu, so its weekend days stay Closed.
    await expect(page.locator('[data-dining-hours-for]')).toHaveCount(2)
    const todayCells = page.locator('[data-hours-today]')
    await expect(todayCells).toHaveCount(2)
    await expect(todayCells.first()).toContainText('Wed')
    await expect(page.locator('[data-dining-hours-for="tower-dining"]')).toContainText('Not listed')
    await expect(page.locator('[data-dining-hours-for="tower-dining"]')).not.toContainText('Closed')
    await expect(page.locator('[data-dining-hours-for="campus-center"]')).toContainText('Closed')
    await expect(page.locator('[data-dining-hours-note]').getByRole('link', { name: 'Official hours at IU Indy Eats' })).toHaveAttribute(
      'href',
      'https://dineoncampus.com/iuindy/hours-of-operation',
    )
    await expect(page.getByText('7:00 - 10:30 AM')).toHaveCount(0)
  })

  test('on a Saturday with a posted menu Tower is not called closed (issue #465)', async ({ page, mockApi }) => {
    mockApi.login()
    const tower = sampleDiningLocation({ is_open: null, hours: 'Hours not listed', closes_at: null, opens_at: null })
    const campusCenter = sampleDining().locations[1]
    mockApi.seedDining({
      snapshot: sampleDining({
        date: '2026-10-17',
        weekday: 'Saturday',
        locations: [tower, { ...campusCenter, is_open: false, hours: 'Closed today', opens_at: null }],
      }),
    })
    await page.goto('/dining')

    await expect(page.getByText('Menu for Saturday, 2026-10-17')).toBeVisible()
    await expect(page.locator('[data-dining-status]')).toHaveText('Menu posted · hours not listed')
    await expect(page.locator('[data-dining-blurb]')).toContainText('Today: Hours not listed · Menus: breakfast, lunch, dinner')
    await expect(page.locator('[data-dining-location="tower-dining"] .status-unknown')).toHaveCount(1)
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toContainText('Silver Star Burger')
    const towerHours = page.locator('[data-dining-hours-for="tower-dining"]')
    await expect(towerHours).toContainText('Menu posted · hours not listed')
    await expect(towerHours.locator('[data-hours-today]')).toContainText('Not listed')
    await expect(towerHours).not.toContainText('Closed')
    // The Campus Center has no menu, so the feed's Closed stands for it.
    await expect(page.locator('[data-dining-hours-for="campus-center"]')).toContainText('Closed today')
  })

  test('the Campus Center is a food court, not a hall with a missing menu', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dining')
    await page.locator('[data-dining-location="campus-center"]').click()

    await expect(page.locator('[data-dining-selected="campus-center"]')).toBeVisible()
    await expect(page.getByText('Food court', { exact: true })).toBeVisible()
    await expect(page.locator('[data-dining-status]')).toHaveText('Closed · opens 7:00 AM')
    const empty = page.locator('[data-dining-empty="retail"]')
    await expect(empty).toContainText('Food court and retail vendors')
    await expect(empty).toContainText('Campus Center vendors serve from their own counters')
    await expect(page.getByText('No menu posted')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Get Directions' })).toHaveAttribute('href', /420%20University%20Blvd/)
  })

  test('a dining hall with nothing posted today says so, and keeps its real hours', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedDining({
      snapshot: sampleDining({
        locations: [sampleDiningLocation({ menus: [], stations: [], menusPublished: false, meal: 'Menu not posted yet' })],
      }),
    })
    await page.goto('/dining')

    await expect(page.locator('[data-dining-empty="no-menu"]')).toContainText('No menu posted for today')
    await expect(page.locator('[data-dining-blurb]')).toContainText('Menu not posted yet')
    await expect(page.locator('[data-dining-hours-for="tower-dining"]')).toContainText('7:00 AM - 9:00 PM')
  })

  test('when the feed is down the page says so and invents nothing', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedDining({ unavailable: true })
    await page.goto('/dining')

    await expect(page.locator('[data-dining-error]')).toContainText('Live menus are temporarily unavailable.')
    await expect(page.locator('[data-dining-error]')).not.toContainText('sample')
    await expect(page.locator('[data-dining-location]')).toHaveCount(0)
    await expect(page.locator('[data-dining-no-hours]')).toContainText('Hours are not posted right now')
    await expect(page.getByText('7:00 - 10:30 AM')).toHaveCount(0)
    await expect(page.getByText('Breakfast', { exact: true })).toHaveCount(0)
  })

  test('a stale snapshot is labelled while the menu still renders', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedDining({ snapshot: sampleDining({ cached: true, stale: true }) })
    await page.goto('/dining')

    await expect(page.locator('[data-dining-stale]')).toContainText('last menu we fetched (2026-09-09)')
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toBeVisible()
    await expect(page.getByText('· cached')).toHaveCount(0)
  })

  test('meal tabs open on the meal being served, with every-day stations collapsed (issue #466)', async ({ page, mockApi }) => {
    // 12:30 PM on campus: lunch.
    await page.clock.setFixedTime(new Date('2026-10-14T12:30:00-04:00'))
    mockApi.login()
    const grill = { name: 'Daily Grill', everyday: true, items: [{ name: 'Silver Star Burger', calories: 190, icons: ['Avoiding Gluten'] }] }
    const salad = { name: 'Salad Bar', everyday: true, items: [{ name: 'Baby Spinach', calories: 7, icons: ['Vegan'] }] }
    mockApi.seedDining({
      snapshot: sampleDining({
        date: '2026-10-14',
        weekday: 'Wednesday',
        locations: [
          sampleDiningLocation({
            menus: [
              { meal: 'breakfast', stations: [{ name: 'Breakfast Entree Line', everyday: false, items: [{ name: 'Blueberry Pancakes', calories: 290, icons: ['Vegetarian'] }] }] },
              { meal: 'lunch', stations: [grill, { name: 'Chef Made Soups', everyday: false, items: [{ name: 'Chicken Miso Soup', calories: 90, icons: [] }] }, salad] },
              { meal: 'dinner', stations: [{ name: 'Homestyle', everyday: false, items: [{ name: 'Beef Stroganoff', calories: 450, icons: [] }] }, grill, salad] },
            ],
          }),
        ],
      }),
    })
    await page.goto('/dining')

    const meals = page.locator('[data-dining-meals]')
    await expect(meals.getByRole('button')).toHaveText(['Breakfast', 'Lunch', 'Dinner'])
    await expect(meals.getByRole('button', { name: 'Lunch' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-dining-station="Chef Made Soups"]')).toBeVisible()
    await expect(page.getByText("Today's specials")).toBeVisible()
    // The every-day stations wait behind one toggle.
    const everyday = page.locator('[data-dining-everyday]')
    const toggle = everyday.getByRole('button', { name: /Every day/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toContainText('2 stations with the same food all week')
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toBeHidden()
    await toggle.click()
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toBeVisible()
    await expect(page.locator('[data-dining-station="Salad Bar"]')).toBeVisible()

    // Dinner has its own specials, and its every-day group starts collapsed.
    await meals.getByRole('button', { name: 'Dinner' }).click()
    await expect(meals.getByRole('button', { name: 'Dinner' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-dining-station="Homestyle"]')).toContainText('Beef Stroganoff')
    await expect(page.locator('[data-dining-station="Chef Made Soups"]')).toHaveCount(0)
    await expect(everyday.getByRole('button', { name: /Every day/ })).toHaveAttribute('aria-expanded', 'false')
  })

  test('the official menu is one tap away, and a stale feed says so (issue #467)', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedDining({
      snapshot: sampleDining({
        locations: [
          sampleDiningLocation({ menu_source: { last_updated: '2026-09-12T06:49:29Z', stale: true, reason: 'not_updated' } }),
          sampleDining().locations[1],
        ],
      }),
    })
    await page.goto('/dining')

    await expect(page.locator('[data-dining-official-menu]')).toHaveAttribute('href', 'https://dineoncampus.com/iuindy/whats-on-the-menu')
    const notice = page.locator('[data-dining-feed-stale]')
    await expect(notice).toContainText('has not been updated since Sep 12')
    await expect(notice.getByRole('link', { name: 'Official menu at IU Indy Eats' })).toHaveAttribute('target', '_blank')
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toBeVisible()

    // The food court has no menu to link and no feed to judge.
    await page.locator('[data-dining-location="campus-center"]').click()
    await expect(page.locator('[data-dining-official-menu]')).toHaveCount(0)
    await expect(page.locator('[data-dining-feed-stale]')).toHaveCount(0)
  })

  test('a dish opens its details, and the diet filters narrow the menu (issue #468)', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dining')

    await page.locator('[data-dining-station="Daily Grill"]').getByRole('button', { name: 'Silver Star Burger', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Silver Star Burger' })
    await expect(dialog).toContainText('Daily Grill · 1 each · 190 cal')
    await expect(dialog.locator('[data-dish-nutrition]')).toContainText('Saturated fat')
    await expect(dialog.locator('[data-dish-nutrition]')).toContainText('4.9 g')
    await expect(dialog).toContainText('Beef Patty')
    await expect(dialog).toContainText('The feed lists no allergens')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Filters: the feed's diet labels, with the allergen caveat beside them.
    await expect(page.locator('[data-dining-diet-note]')).toContainText('not allergen information')
    await page.locator('[data-dining-diet-filter="Vegan"]').click()
    await expect(page.locator('[data-dining-station="Salad Bar"]')).toContainText('Baby Spinach')
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toHaveCount(0)
    // Remembered on this device.
    await page.reload()
    await expect(page.locator('[data-dining-diet-filter="Vegan"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toHaveCount(0)
    await page.locator('[data-dining-diet-filter="Vegan"]').click()
    await expect(page.locator('[data-dining-station="Daily Grill"]')).toBeVisible()
  })

  test('today\'s headliners show with the meal, and a starred dish coming back is listed (issue #469)', async ({ page, mockApi }) => {
    await page.clock.setFixedTime(new Date('2026-09-09T12:30:00-04:00'))
    mockApi.login()
    mockApi.seedDiningUpcoming({
      ok: true,
      today: '2026-09-09',
      days: [
        {
          date: '2026-09-09',
          tentative: false,
          holiday: null,
          meals: [{ meal: 'lunch', location: 'Tower Dining', headliners: [{ name: 'Silver Star Burger', image: null }, { name: 'Pasta Primavera', image: null }], specials: [] }],
        },
        { date: '2026-09-10', tentative: false, holiday: null, meals: [{ meal: 'dinner', location: 'Tower Dining', headliners: [{ name: 'Veggie Burger', image: null }], specials: [] }] },
        { date: '2026-10-08', tentative: true, holiday: null, meals: [{ meal: 'lunch', location: 'Tower Dining', headliners: [{ name: 'Baby Spinach', image: null }], specials: [] }] },
      ],
    })
    await page.goto('/dining')

    const strip = page.locator('[data-dining-headliners]')
    await expect(strip).toContainText('Silver Star Burger')
    await expect(strip).toContainText('Pasta Primavera')
    // A headliner on the menu opens its details.
    await strip.getByRole('button', { name: 'Silver Star Burger' }).click()
    await expect(page.getByRole('dialog', { name: 'Silver Star Burger' })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Add Veggie Burger to favorites' }).first().click()
    await page.getByRole('button', { name: 'Add Baby Spinach to favorites' }).first().click()
    const card = page.locator('[data-dining-coming-up]')
    await expect(card).toContainText('Veggie Burger is back tomorrow')
    await expect(card).toContainText('Baby Spinach: Thu, Oct 8 (tentative)')
    await expect(card).toContainText('Menus more than a week out are drafts')
  })

  test('starring an item lists it under favorites and survives a reload', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dining')

    const star = page.getByRole('button', { name: 'Add Silver Star Burger to favorites' })
    await star.click()
    await expect(page.getByRole('button', { name: 'Remove Silver Star Burger from favorites' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-dining-favorites]')).toContainText('Silver Star Burger')
    await expect(page.locator('[data-dining-favorites]')).toContainText('Tower Dining')

    await page.reload()
    await expect(page.locator('[data-dining-favorites]')).toContainText('Silver Star Burger')
    await page.getByRole('button', { name: 'Remove Silver Star Burger from favorites' }).click()
    await expect(page.locator('[data-dining-favorites]')).toHaveCount(0)
  })
})
