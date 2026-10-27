import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Landing from './Landing'

// Issue #364: the closing CTA band had an "Explore the app" link to "/", the
// landing page itself, which did nothing when clicked. Issue #366 opened the
// live dining and transit pages to signed-out visitors, so the band now has
// its sign-up link and one to /dining, and neither goes back to "/". The
// query is scoped to the band because the nav logo links to "/" on purpose.

vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))

afterEach(cleanup)

// Issue #527 - the page promised real-time data over a list that includes the
// daily dining menu and a library source that is still off, and two dining
// lines promised a hall was open, which lib/pagePreviews.ts rules out.
describe('Landing claims', () => {
  test('promise no real-time data, no open hall and no source that is not live', () => {
    const { container } = render(
      <MemoryRouter useTransitions={false}>
        <Landing />
      </MemoryRouter>,
    )
    const text = container.textContent || ''
    expect(text).not.toMatch(/real-time/i)
    expect(text).not.toMatch(/open right now|is open until/)
    expect(text).not.toMatch(/University Library/)
    expect(screen.getByText('Real campus data')).toBeInTheDocument()
  })
})

describe('Landing closing CTA', () => {
  test('links to sign-up and to the live dining preview', () => {
    render(
      <MemoryRouter useTransitions={false}>
        <Landing />
      </MemoryRouter>,
    )
    const band = screen.getByRole('heading', { level: 2, name: 'Your campus is ready when you are.' }).closest('section')
    expect(band).not.toBeNull()
    const links = within(band as HTMLElement).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/login?tab=signup', '/dining'])
    expect(within(band as HTMLElement).getByRole('link', { name: 'See live dining and buses' })).toHaveAttribute('href', '/dining')
    expect(within(band as HTMLElement).queryByText('Explore the app')).toBeNull()
  })
})

// The three "Get started" calls to action opened the sign-in tab ("Welcome
// back") although they invite new students; they open sign-up now, and the nav
// keeps a plain "Sign in" so returning students are not sent to sign-up.
describe('Landing sign-up and sign-in links', () => {
  test('every Get started opens sign-up, and the nav has its own Sign in', () => {
    render(
      <MemoryRouter useTransitions={false}>
        <Landing />
      </MemoryRouter>,
    )
    const getStarted = screen.getAllByRole('link', { name: /get started/i })
    expect(getStarted).toHaveLength(3)
    for (const link of getStarted) expect(link).toHaveAttribute('href', '/login?tab=signup')
    // One in the nav band from sm up, one under the hero on phones.
    const signIn = screen.getAllByRole('link', { name: 'Sign in' })
    expect(signIn).toHaveLength(2)
    for (const link of signIn) expect(link).toHaveAttribute('href', '/login')
    expect(within(screen.getByRole('navigation')).getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })
})

// Issue #376: the student profile menu no longer links to the advertiser portal
// (advertisers have their own accounts), so this page is where advertisers find
// it: a link in the nav from sm up, and one in the footer at every width.
describe('Landing advertiser entry points', () => {
  test('the nav and the footer both open the advertiser portal', () => {
    render(
      <MemoryRouter useTransitions={false}>
        <Landing />
      </MemoryRouter>,
    )
    expect(within(screen.getByRole('navigation')).getByRole('link', { name: 'Advertise' })).toHaveAttribute('href', '/advertise')
    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Advertise with us' })).toHaveAttribute('href', '/advertise')
  })
})

// Issue #376: the nav and the app call the Tasks page Tasks, so the landing
// page's list of what is inside does too.
describe('Landing feature names', () => {
  test('the Tasks page is listed as the Task Tracker', () => {
    render(
      <MemoryRouter useTransitions={false}>
        <Landing />
      </MemoryRouter>,
    )
    expect(screen.getByText('Task Tracker')).toBeInTheDocument()
    expect(screen.queryByText('Assignment Tracker')).toBeNull()
  })
})
