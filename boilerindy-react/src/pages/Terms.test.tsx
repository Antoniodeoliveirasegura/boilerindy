import { afterEach, describe, expect, test } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Terms from './Terms'

// Issue #193 - Contact points at the public support page the App Store support
// URL links to.

afterEach(cleanup)

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Terms />
    </MemoryRouter>,
  )
}

describe('Terms contact', () => {
  test('links to the support page', () => {
    renderAt('/terms')
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support')
  })
})
