import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import FreeFood from './FreeFood'
import { authRequest } from '../lib/authApi'

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
const auth = vi.hoisted(() => ({ user: { id: 'user-1' }, onboarding: { linkedSourceCount: 1 } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

const pizzaSocial = () => ({
  id: 'ev-1',
  title: 'Pizza social',
  category: 'campus_event',
  startTime: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
  freeFood: true,
})

let calendar: { items: unknown[] } | Error

beforeEach(() => {
  calendar = { items: [pizzaSocial()] }
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path) => {
      if (String(path).startsWith('/api/me/calendar?')) {
        if (calendar instanceof Error) throw calendar
        return calendar
      }
      return {}
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// A client per test, with no retries, so a failed read settles at once.
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter useTransitions={false}>
        <FreeFood />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Once the retries were spent the page fell through to its empty state, so a
// failed read said "No free-food events right now".
it('says the calendar did not load instead of the empty state, and Try again reloads it', async () => {
  calendar = Object.assign(new Error('Request failed'), { status: 502 })
  renderPage()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Could not load your calendar')
  expect(screen.queryByText('No free-food events right now')).not.toBeInTheDocument()
  expect(screen.queryByText(/^0 upcoming events/)).not.toBeInTheDocument()

  calendar = { items: [pizzaSocial()] }
  fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Pizza social')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('still shows the empty state when the calendar loads with no free-food events', async () => {
  calendar = { items: [] }
  renderPage()
  expect(await screen.findByText('No free-food events right now')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
