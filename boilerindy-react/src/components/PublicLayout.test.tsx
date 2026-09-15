import { afterEach, describe, expect, test } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import PublicLayout from './PublicLayout'
import SiteDisclaimer from './SiteDisclaimer'

// Issue #112 - the "not affiliated with Purdue" disclaimer must reach every
// route. The authenticated pages get it from AppLayout and the marketing and
// document pages place it themselves; these four routes had nothing until
// PublicLayout wrapped them. This pins both the wrapper and the wording.

afterEach(cleanup)

const COVERED = ['/reset-password', '/auth/callback', '/advertise/reset-password', '/advertise/dashboard']

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PublicLayout />}>
          {COVERED.map((p) => (
            <Route key={p} path={p} element={<div data-testid="page">page {p}</div>} />
          ))}
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('PublicLayout', () => {
  test.each(COVERED)('renders the page and the disclaimer at %s', (path) => {
    renderAt(path)
    expect(screen.getByTestId('page')).toHaveTextContent(`page ${path}`)
    expect(screen.getByText(/not affiliated with/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support')
  })
})

describe('SiteDisclaimer wording', () => {
  test('disclaims affiliation, endorsement, sponsorship and trademark ownership', () => {
    render(
      <MemoryRouter>
        <SiteDisclaimer />
      </MemoryRouter>,
    )
    const text = document.body.textContent || ''
    expect(text).toMatch(/independent, student-built project/)
    expect(text).toMatch(/not affiliated with, endorsed by, sponsored by, or officially connected to Purdue University/)
    expect(text).toMatch(/trademarks of Purdue University/)
  })

  // Issue #193 - the store forms need a published contact, so the footer links
  // Support next to Terms and Privacy on every route.
  test('links Terms, Privacy and Support', () => {
    render(
      <MemoryRouter>
        <SiteDisclaimer />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support')
  })
})
