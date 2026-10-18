import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Navbar from './Navbar'

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
  fireEvent.click(screen.getByRole('button', { name: 'PP' }))
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
