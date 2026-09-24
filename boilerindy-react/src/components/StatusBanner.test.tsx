import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import StatusBanner from './StatusBanner'

// Issue #221 - inline banners were plain divs, so a screen reader never heard
// a failed sign-in or a saved setting. Errors are alerts, the rest is status.

afterEach(cleanup)

describe('StatusBanner', () => {
  test('an error is an alert', () => {
    render(<StatusBanner tone="error">Wrong password.</StatusBanner>)
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong password.')
  })

  test('a success is a polite status', () => {
    render(<StatusBanner tone="success">Saved.</StatusBanner>)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Saved.')
    expect(banner).toHaveAttribute('aria-live', 'polite')
  })

  test('info is a status too, and the icon can be switched off', () => {
    const { container } = render(
      <StatusBanner tone="info" icon={null} className="mb-4">
        Check your inbox.
      </StatusBanner>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Check your inbox.')
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByRole('status').className).toContain('mb-4')
  })
})
