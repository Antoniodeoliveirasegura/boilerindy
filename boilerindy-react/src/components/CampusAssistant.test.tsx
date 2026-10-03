import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import CampusAssistant from './CampusAssistant'

// Issue #369 (comment): the welcome message froze the first name in a
// useState initializer, so a name that arrived later (auth finishing, or a
// name set during setup) never showed until a remount. The greeting now
// follows the current name.

const auth = vi.hoisted(() => ({ firstName: 'Student' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, getFirstName: () => auth.firstName }),
}))
vi.mock('../lib/authApi', () => ({ authRequest: vi.fn(async () => ({})) }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

beforeEach(() => sessionStorage.clear())
afterEach(cleanup)

function ui() {
  return (
    <MemoryRouter>
      <CampusAssistant />
    </MemoryRouter>
  )
}

describe('CampusAssistant greeting', () => {
  test('follows the first name when it changes after mount', () => {
    auth.firstName = 'Student'
    const { rerender } = render(ui())
    expect(screen.getByText(/Hey Student!/)).toBeInTheDocument()
    auth.firstName = 'Pete'
    rerender(ui())
    expect(screen.getByText(/Hey Pete!/)).toBeInTheDocument()
    expect(screen.queryByText(/Hey Student!/)).toBeNull()
  })
})
