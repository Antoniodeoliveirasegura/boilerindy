import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import FreeFood from './FreeFood'
import { authRequest } from '../lib/authApi'

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
type AuthState = { loading: boolean; user: null | { id: string }; onboarding: { linkedSourceCount: number } }
const SIGNED_IN: AuthState = { loading: false, user: { id: 'user-1' }, onboarding: { linkedSourceCount: 1 } }
// Signed out, AuthContext's onboarding is its empty default: no linked source.
const SIGNED_OUT: AuthState = { loading: false, user: null, onboarding: { linkedSourceCount: 0 } }
const auth = vi.hoisted(() => ({ value: null as unknown as AuthState }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.value }))

const PUBLIC_FREE_FOOD = '/api/campus-events/free-food'

const pizzaSocial = () => ({
  id: 'ev-1',
  title: 'Pizza social',
  category: 'campus_event',
  startTime: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
  freeFood: true,
})

// A shared campus event, as the server sends it.
const at = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
const campus = (id: string, title: string, hours: number, sourceKey: string, freeFood = true) => ({
  id: `campus:${id}`,
  title,
  category: 'campus_event',
  startTime: at(hours),
  freeFood,
  shared: true,
  sourceKey,
  sourceLabel: sourceKey === 'purdue_events' ? 'Purdue event' : 'IU event',
  sourceUrl: `https://example.edu/event/${id}`,
})

let calendar: { items: unknown[] } | Error
// What the session-free read answers: a body, or an HTTP status to fail with.
let publicFeed: { ok: boolean; items: unknown[] } | number

beforeEach(() => {
  auth.value = SIGNED_IN
  calendar = { items: [pizzaSocial()] }
  publicFeed = { ok: true, items: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) !== PUBLIC_FREE_FOOD) throw new Error(`unexpected fetch of ${String(url)}`)
      if (typeof publicFeed === 'number') {
        return new Response(JSON.stringify({ error: { message: 'Could not load free food events. Please try again.', status: publicFeed } }), { status: publicFeed })
      }
      return new Response(JSON.stringify(publicFeed), { status: 200 })
    }),
  )
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const fetchedUrls = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url))

// A client per test, with no retries, so a failed read settles at once.
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const page = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter useTransitions={false}>
        <FreeFood />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const { rerender } = render(page())
  /** Re-render after changing auth.value, as a session change would. */
  return { rerenderPage: () => rerender(page()) }
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

// Issue #30: the source pills count the free-food list, not the whole calendar.
it('filters the free-food events by source', async () => {
  calendar = {
    items: [
      pizzaSocial(),
      campus('breakfast', 'Veterans Day Breakfast', 30, 'iu_events'),
      campus('fuel', 'Boiler Fuel Up', 28, 'purdue_events'),
      campus('yoga', 'Yoga', 3, 'iu_events', false),
    ],
  }
  renderPage()
  await screen.findByText('Veterans Day Breakfast')
  const pills = screen.getByRole('group', { name: 'Event source' })
  expect(within(pills).getAllByRole('button').map((pill) => pill.textContent)).toEqual([
    'All sources', 'Purdue (1)', 'IU (1)', 'My calendar (1)',
  ])

  fireEvent.click(within(pills).getByRole('button', { name: 'Purdue (1)' }))
  expect(screen.getByText('Boiler Fuel Up')).toBeInTheDocument()
  expect(screen.queryByText('Veterans Day Breakfast')).not.toBeInTheDocument()
  expect(screen.queryByText('Pizza social')).not.toBeInTheDocument()

  fireEvent.click(within(pills).getByRole('button', { name: 'All sources' }))
  expect(screen.getByText('Pizza social')).toBeInTheDocument()
  expect(screen.getByText('Veterans Day Breakfast')).toBeInTheDocument()
})

it('reads the calendar window only once auth has settled, and never the public read', async () => {
  auth.value = { ...SIGNED_IN, loading: true }
  const { rerenderPage } = renderPage()
  expect(screen.getByText('Loading free-food events…')).toBeInTheDocument()
  // No count while it loads: "0 upcoming events" read as none.
  expect(screen.queryByText(/^0 upcoming events/)).not.toBeInTheDocument()
  expect(authRequest).not.toHaveBeenCalled()

  auth.value = SIGNED_IN
  rerenderPage()
  expect(await screen.findByText('Pizza social')).toBeInTheDocument()
  expect(authRequest).toHaveBeenCalledTimes(1)
  expect(fetchedUrls()).toEqual([])
})

// Issue #366: signed-out visitors can open the page. They get the free food
// on campus calendars from the session-free read, and the page never makes a
// per-user request, whose 401 would send them to /login with a false
// "session expired".
describe('signed out (the public preview)', () => {
  beforeEach(() => {
    auth.value = SIGNED_OUT
  })

  it('lists the campus calendars\' free food with the Purdue and IU pills, and no per-user request', async () => {
    publicFeed = {
      ok: true,
      items: [campus('fuel', 'Boiler Fuel Up', 28, 'purdue_events'), campus('breakfast', 'Veterans Day Breakfast', 30, 'iu_events')],
    }
    renderPage()

    const fuelUp = (await screen.findByText('Boiler Fuel Up')).closest('li') as HTMLElement
    expect(within(fuelUp).getByText('Purdue event')).toBeInTheDocument()
    expect(within(fuelUp).getByRole('link', { name: 'View on example.edu' })).toHaveAttribute('href', 'https://example.edu/event/fuel')
    expect(screen.getByText(/^2 upcoming events on campus calendars that mention free food/)).toBeInTheDocument()

    const pills = screen.getByRole('group', { name: 'Event source' })
    expect(within(pills).getAllByRole('button').map((pill) => pill.textContent)).toEqual(['All sources', 'Purdue (1)', 'IU (1)'])
    fireEvent.click(within(pills).getByRole('button', { name: 'IU (1)' }))
    expect(screen.queryByText('Boiler Fuel Up')).not.toBeInTheDocument()
    expect(screen.getByText('Veterans Day Breakfast')).toBeInTheDocument()

    // No card to connect a calendar: the visitor has none, and /setup needs an account.
    expect(screen.queryByText('Connect a calendar source')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Connect source/ })).not.toBeInTheDocument()
    expect(authRequest).not.toHaveBeenCalled()
    expect(fetchedUrls()).toEqual([PUBLIC_FREE_FOOD])
  })

  it('never offers a My calendar pill, which would filter by a calendar the visitor does not have', async () => {
    const unflagged = { ...campus('quiz-bowl', 'Quiz bowl pizza', 26, 'purdue_events'), shared: undefined }
    publicFeed = { ok: true, items: [campus('fuel', 'Boiler Fuel Up', 28, 'purdue_events'), campus('breakfast', 'Veterans Day Breakfast', 30, 'iu_events'), unflagged] }
    renderPage()
    const pills = await screen.findByRole('group', { name: 'Event source' })
    expect(within(pills).queryByRole('button', { name: /My calendar/ })).not.toBeInTheDocument()
    expect(within(pills).getAllByRole('button').map((pill) => pill.textContent)).toEqual(['All sources', 'Purdue (1)', 'IU (1)'])
  })

  it('with nothing listed: the empty state, with no link to Events, which needs an account', async () => {
    publicFeed = { ok: true, items: [] }
    renderPage()
    expect(await screen.findByText('No free-food events right now')).toBeInTheDocument()
    expect(screen.getByText(/^0 upcoming events on campus calendars/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Browse all events' })).not.toBeInTheDocument()
    expect(authRequest).not.toHaveBeenCalled()
  })

  it('says campus events did not load instead of the empty state, and Try again reloads them', async () => {
    publicFeed = 500
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load campus events')
    expect(screen.queryByText('No free-food events right now')).not.toBeInTheDocument()
    expect(screen.getByText(/^Upcoming events on campus calendars that mention free food/)).toBeInTheDocument()

    publicFeed = { ok: true, items: [campus('fuel', 'Boiler Fuel Up', 28, 'purdue_events')] }
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Boiler Fuel Up')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(authRequest).not.toHaveBeenCalled()
  })

  it('while auth loads neither read runs; signed out once it settles, only the public one', async () => {
    auth.value = { ...SIGNED_OUT, loading: true }
    publicFeed = { ok: true, items: [campus('fuel', 'Boiler Fuel Up', 28, 'purdue_events')] }
    const { rerenderPage } = renderPage()
    expect(screen.getByText('Loading free-food events…')).toBeInTheDocument()
    expect(fetchedUrls()).toEqual([])

    auth.value = SIGNED_OUT
    rerenderPage()
    expect(await screen.findByText('Boiler Fuel Up')).toBeInTheDocument()
    expect(fetchedUrls()).toEqual([PUBLIC_FREE_FOOD])
    expect(authRequest).not.toHaveBeenCalled()
  })
})
