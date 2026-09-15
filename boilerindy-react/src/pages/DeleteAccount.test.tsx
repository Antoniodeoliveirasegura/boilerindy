import { afterEach, describe, expect, test } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import DeleteAccount from './DeleteAccount'

// Issue #193 - Google Play's Data Safety form links to this page, so it has to
// explain both deletion paths and carry a working email fallback for people
// who no longer have the app.

afterEach(cleanup)

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DeleteAccount />
    </MemoryRouter>,
  )
}

describe('DeleteAccount page', () => {
  test('covers the in-app path, the email fallback and what is kept', () => {
    renderAt('/delete-account')
    expect(screen.getByRole('heading', { level: 1, name: 'Delete your account' })).toBeInTheDocument()
    for (const name of ['Delete from the app', 'Delete by email', 'What gets deleted', 'What we keep']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    }
  })

  test('the email link opens a deletion request to privacy@', () => {
    renderAt('/delete-account')
    expect(screen.getByRole('link', { name: 'privacy@boilerindy.app' })).toHaveAttribute(
      'href',
      'mailto:privacy@boilerindy.app?subject=Delete%20my%20BoilerIndy%20account',
    )
  })

  test('links to Settings, the privacy policy and support', () => {
    renderAt('/delete-account')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy')
    expect(screen.getByRole('link', { name: 'support page' })).toHaveAttribute('href', '/support')
  })

  test('the back link honours ?from=settings', () => {
    renderAt('/delete-account?from=settings')
    expect(screen.getByRole('link', { name: /back to settings/i })).toHaveAttribute('href', '/settings')
  })
})
