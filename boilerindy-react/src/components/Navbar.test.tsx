import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Navbar from './Navbar'
import { fakeAnimation, installFakeAnimations } from '../lib/fakeAnimations'

// Issue #376: the nav calls the /assignments page "Tasks", and the student
// profile menu no longer carries an "Advertiser portal" link. Advertisers have
// their own accounts and find the portal on the landing page, in the nav and the
// footer (Landing.test.tsx), so a student account has no use for the link.

const auth = vi.hoisted(() => ({ user: { id: 'user-1', email: 'pete@purdue.edu', isAdmin: false } }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, getInitials: () => 'PP', getDisplayName: () => 'Pete Purdue' }),
  useSignOutAndRedirect: () => vi.fn(),
}))
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))

afterEach(() => {
  cleanup()
  auth.user.isAdmin = false
})

function renderNavbar() {
  return render(
    <MemoryRouter useTransitions={false}>
      <Navbar />
    </MemoryRouter>,
  )
}

function accountMenuItems() {
  fireEvent.click(screen.getByRole('button', { name: 'PP, account menu for Pete Purdue' }))
  return within(screen.getByRole('menu')).getAllByRole('menuitem')
}

describe('Navbar', () => {
  test('calls the /assignments page Tasks', () => {
    renderNavbar()
    const links = screen.getAllByRole('link', { name: 'Tasks' })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link).toHaveAttribute('href', '/assignments')
    expect(screen.queryByRole('link', { name: /assignments/i })).toBeNull()
  })

  test('the profile menu has no advertiser entry', () => {
    const { container } = renderNavbar()
    expect(accountMenuItems().map((item) => item.textContent)).toEqual(['Dark mode', 'Settings', 'Setup', 'Sign out'])
    expect(screen.queryByText(/advertis/i)).toBeNull()
    expect(container.querySelector('a[href^="/advertise"]')).toBeNull()
  })

  test('an admin gets the console in the menu, and still no advertiser entry', () => {
    auth.user.isAdmin = true
    const { container } = renderNavbar()
    expect(accountMenuItems().map((item) => item.textContent)).toEqual([
      'Dark mode',
      'Settings',
      'Admin console',
      'Setup',
      'Sign out',
    ])
    expect(container.querySelector('a[href^="/advertise"]')).toBeNull()
  })
})

// docs/motion.md: one amber bar slides from tab to tab, and the account menu
// plays its exit before it leaves.
describe('Navbar motion', () => {
  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]} useTransitions={false}>
        <Navbar />
      </MemoryRouter>,
    )
  }

  function tabBar() {
    const bar = document.querySelector<HTMLElement>('.tabbar-slider')
    if (!bar) throw new Error('no tab bar slider')
    return { index: bar.style.getPropertyValue('--tab-index'), hidden: bar.hasAttribute('data-hidden') }
  }

  test('the tab bar has one amber bar, under the current tab', () => {
    renderAt('/schedule')
    expect(document.querySelectorAll('.tabbar-slider')).toHaveLength(1)
    expect(tabBar()).toEqual({ index: '1', hidden: false })
  })

  test('on a page that is not a tab it fades out where it was, and slides on from there', () => {
    renderAt('/map')
    expect(tabBar()).toEqual({ index: '2', hidden: false })

    fireEvent.click(screen.getAllByRole('link', { name: 'Events' })[0])
    expect(tabBar()).toEqual({ index: '2', hidden: true })

    fireEvent.click(screen.getAllByRole('link', { name: 'Home' })[0])
    expect(tabBar()).toEqual({ index: '0', hidden: false })
  })

  test('the account menu animates out, inert, with focus back on the avatar', async () => {
    const exit = fakeAnimation({ endTime: 150 })
    const uninstall = installFakeAnimations((el) => (el.getAttribute('data-motion') === 'closed' ? [exit] : []))
    try {
      renderNavbar()
      const avatar = screen.getByRole('button', { name: 'PP, account menu for Pete Purdue' })
      fireEvent.click(avatar)
      const menu = screen.getByRole('menu')
      expect(menu).toHaveAttribute('data-motion', 'open')

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(menu).toBeInTheDocument()
      expect(menu).toHaveAttribute('data-motion', 'closed')
      expect(menu).toHaveAttribute('inert')
      expect(avatar).toHaveFocus()
      expect(avatar).toHaveAttribute('aria-expanded', 'false')

      await act(async () => exit.finish())
      expect(document.querySelector('[role="menu"]')).toBeNull()
    } finally {
      uninstall()
    }
  })
})
