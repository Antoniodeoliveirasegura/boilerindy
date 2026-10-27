import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './fixtures/mock-backend.js'

// Issue #529. axe-core over the public pages and the signed-in dashboard, so a
// control without a name, a field without a label or an unreadable colour pair
// fails CI instead of waiting for the next manual review. Only serious and
// critical violations fail, so the spec started green and works as a ratchet:
// a moderate finding is reported in the failure message of a serious one, not
// on its own.

const BLOCKING = new Set(['serious', 'critical'])

/** The serious and critical violations on the current page, one line each. */
async function blockingViolations(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  return violations
    .filter((v) => BLOCKING.has(v.impact ?? ''))
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
}

const PUBLIC_PAGES = ['/', '/login', '/login?tab=signup', '/privacy', '/terms', '/support', '/delete-account', '/advertise', '/install']

test.describe('Accessibility (axe)', () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} has no serious or critical violations`, async ({ page }) => {
      await page.goto(path)
      await expect(page.locator('main').first()).toBeVisible()
      expect(await blockingViolations(page)).toEqual([])
    })
  }

  test('the signed-in dashboard has no serious or critical violations', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/dashboard')
    await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible()
    expect(await blockingViolations(page)).toEqual([])
  })
})
