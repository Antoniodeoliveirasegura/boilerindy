import { test, expect } from './fixtures/mock-backend.js'

// Customizable Student Services board. Exercises the real Services UI against
// the stateful mock of GET/PUT /api/me/services: a new user gets the default
// layout (In-App Shortcuts first), and hide / add / reorder edits all survive a
// full page reload (the mock persists the PUT body the same way the DB would).

const widgetOrder = (page) =>
  page.locator('[data-widget-id]').evaluateAll((els) => els.map((el) => el.dataset.widgetId))

test.describe('Services customization', () => {
  test('a new user sees the default widgets with In-App Shortcuts first', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/services')

    await expect(page.getByRole('heading', { name: 'Student Services And Resources' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible()

    // In-App Shortcuts leads the board by default.
    const order = await widgetOrder(page)
    expect(order[0]).toBe('in-app-shortcuts')
    expect(order).toContain('academic-support')
  })

  test('hiding then re-adding a widget persists across reload', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/services')

    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
    await expect(page.locator('[data-widget-id="health-and-wellness"]')).toHaveCount(1)

    // Hide the Health And Wellness card; it leaves the grid and joins the picker.
    await page.getByRole('button', { name: 'Hide Health And Wellness' }).click()
    await expect(page.locator('[data-widget-id="health-and-wellness"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Health And Wellness' })).toBeVisible()

    // Reload: the saved layout (hidden) is reloaded from the server.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Student Services And Resources' })).toBeVisible()
    await expect(page.locator('[data-widget-id="health-and-wellness"]')).toHaveCount(0)

    // Re-add it from the picker, and confirm it sticks after another reload.
    await page.getByRole('button', { name: 'Customize' }).click()
    await page.getByRole('button', { name: 'Health And Wellness' }).click()
    await expect(page.locator('[data-widget-id="health-and-wellness"]')).toHaveCount(1)

    await page.reload()
    await expect(page.locator('[data-widget-id="health-and-wellness"]')).toHaveCount(1)
  })

  test('reordering a widget persists across reload', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/services')

    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()

    const before = await widgetOrder(page)
    expect(before.indexOf('academic-support')).toBeGreaterThan(before.indexOf('in-app-shortcuts'))

    // Move Academic Support up one slot (it swaps with In-App Shortcuts).
    await page.getByRole('button', { name: 'Move Academic Support up' }).click()
    await expect
      .poll(async () => {
        const order = await widgetOrder(page)
        return order.indexOf('academic-support') < order.indexOf('in-app-shortcuts')
      })
      .toBe(true)

    // The new order is restored from the server after a reload.
    await page.reload()
    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
    const after = await widgetOrder(page)
    expect(after.indexOf('academic-support')).toBeLessThan(after.indexOf('in-app-shortcuts'))
  })

  test('reset uses a styled in-app dialog and restores defaults', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/services')

    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()

    // Hide a default-visible card so we can prove Reset brings it back.
    await page.getByRole('button', { name: 'Hide Health And Wellness' }).click()
    await expect(page.locator('[data-widget-id="health-and-wellness"]')).toHaveCount(0)

    // Reset opens the custom dialog (an accessible role=dialog), not window.confirm.
    await page.getByRole('button', { name: 'Reset' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Reset Services layout?')).toBeVisible()

    // Confirm → dialog closes and defaults are restored (Health And Wellness is back).
    await dialog.getByRole('button', { name: 'Reset' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('[data-widget-id="health-and-wellness"]')).toHaveCount(1)
  })
})
