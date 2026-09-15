import { afterEach, describe, expect, test } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Support from './Support'

// Issue #193 - the App Store support URL and the published contact both stores
// require for apps with user posts.

afterEach(cleanup)

function renderSupport() {
  return render(
    <MemoryRouter initialEntries={['/support']}>
      <Support />
    </MemoryRouter>,
  )
}

describe('Support page', () => {
  test('shows the heading and the support email', () => {
    renderSupport()
    expect(screen.getByRole('heading', { level: 1, name: 'Support' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'support@boilerindy.app' })).toHaveAttribute(
      'href',
      'mailto:support@boilerindy.app',
    )
    expect(document.body.textContent).toMatch(/within a few days/)
  })

  test('links abuse reports, privacy requests and GitHub issues', () => {
    renderSupport()
    expect(screen.getByRole('link', { name: 'abuse@boilerindy.app' })).toHaveAttribute('href', 'mailto:abuse@boilerindy.app')
    expect(screen.getByRole('link', { name: 'privacy@boilerindy.app' })).toHaveAttribute(
      'href',
      'mailto:privacy@boilerindy.app',
    )
    expect(screen.getByRole('link', { name: 'open an issue on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/Antoniodeoliveirasegura/boilerindy/issues',
    )
  })

  test('links to the privacy policy, the terms and account deletion', () => {
    renderSupport()
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy')
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: 'Delete your account' })).toHaveAttribute('href', '/delete-account')
  })
})
