import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Landing from './Landing'

// Issue #364: the closing CTA band had an "Explore the app" link to "/", the
// landing page itself, which did nothing when clicked. Signed-out visitors
// have nothing to explore yet (every app route needs sign-in), so the band
// keeps only its sign-up link. The query is scoped to the band because the
// nav logo links to "/" on purpose.

vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))

afterEach(cleanup)

describe('Landing closing CTA', () => {
  test('has exactly one link, to /login', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    )
    const band = screen.getByRole('heading', { level: 2, name: 'Your campus is ready when you are.' }).closest('section')
    expect(band).not.toBeNull()
    const links = within(band as HTMLElement).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/login'])
    expect(within(band as HTMLElement).queryByText('Explore the app')).toBeNull()
  })
})
