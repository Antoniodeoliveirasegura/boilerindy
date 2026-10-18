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

// Issue #30: the shared campus events the server adds while its feed is on,
// in the same window as Events.
it('lists shared free-food events with their source and a link out, and keeps one on now until it ends', async () => {
  const hour = 60 * 60 * 1000
  calendar = {
    items: [
      pizzaSocial(),
      {
        id: 'campus:fuel-up',
        title: 'Boiler Fuel Up!',
        category: 'campus_event',
        startTime: new Date(Date.now() - hour).toISOString(),
        endTime: new Date(Date.now() + hour).toISOString(),
        freeFood: true,
        shared: true,
        sourceLabel: 'Purdue event',
        sourceUrl: 'https://events.purdue.edu/event/boiler-fuel-up',
      },
      {
        id: 'campus:ended',
        title: 'Breakfast that ended',
        category: 'campus_event',
        startTime: new Date(Date.now() - 3 * hour).toISOString(),
        endTime: new Date(Date.now() - 2 * hour).toISOString(),
        freeFood: true,
        shared: true,
        sourceLabel: 'IU event',
        sourceUrl: 'https://events.iu.edu/event/breakfast',
      },
    ],
  }
  renderPage()

  const row = (await screen.findByText('Boiler Fuel Up!')).closest('li') as HTMLElement
  expect(vi.mocked(authRequest).mock.calls.map(([path]) => String(path))).toContain(
    '/api/me/calendar?categories=campus_event%2Cevent%2Cdeadline&limit=500&shared=1',
  )
  expect(within(row).getByText('Purdue event')).toBeInTheDocument()
  const link = within(row).getByRole('link', { name: 'View on events.purdue.edu' })
  expect(link).toHaveAttribute('href', 'https://events.purdue.edu/event/boiler-fuel-up')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', 'noopener noreferrer')

  // The student's own event has neither.
  const own = screen.getByText('Pizza social').closest('li') as HTMLElement
  expect(within(own).queryByRole('link')).not.toBeInTheDocument()
  expect(within(own).queryByText('Purdue event')).not.toBeInTheDocument()

  expect(screen.queryByText('Breakfast that ended')).not.toBeInTheDocument()
  expect(screen.getByText(/^2 upcoming events on your calendar and campus calendars that mention free food/)).toBeInTheDocument()
})
