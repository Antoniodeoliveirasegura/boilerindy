import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Home from './Home'

// Issue #371: with nothing connected, Home still asked the assistant for a
// Week ahead digest, and the model filled the empty context with invented
// classes. Without a calendar source (linked or added by hand) the card now
// shows an empty state and never calls /api/assistant.

// A failed layout fetch keeps the default dashboard, which has the Week ahead card.
// Classes come back empty unless a test sets `classes.items`.
const classes = vi.hoisted(() => ({ items: [] as Record<string, unknown>[] }))
vi.mock('../lib/authApi', () => ({
  authRequest: vi.fn(async (path: string) => {
    if (path === '/api/me/dashboard') throw new Error('offline')
    if (path.startsWith('/api/me/classes')) return { items: classes.items }
    return {}
  }),
  shouldSkipSetup: () => true,
}))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../components/SourceErrorNotice', () => ({ default: () => null }))
vi.mock('../components/FeaturedDeal', () => ({ default: () => null }))
vi.mock('../components/dashboard/SponsoredWidget', () => ({ default: () => null }))
const auth = vi.hoisted(() => ({
  user: { id: 'user-1' },
  authConfig: {},
  getFirstName: () => 'Pete',
  onboarding: { linkedSourceCount: 0, classCount: 0, hasPurdueLinked: false, needsPurdueConnection: true, needsScheduleSource: false },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ reply: 'You have CS 30200 at 2:30pm.' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  // jsdom has no ResizeObserver; DashboardWidget measures itself with one.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  auth.onboarding.linkedSourceCount = 0
  classes.items = []
})

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const assistantCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/assistant')

it('shows a connect-your-schedule empty state and skips the digest when no calendar is connected', async () => {
  renderHome()
  const link = await screen.findByRole('link', { name: /connect your schedule/i })
  expect(link.getAttribute('href')).toBe('/setup')
  expect(screen.queryByText(/Generating your week summary/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  expect(assistantCalls()).toHaveLength(0)
})

it('still asks for the digest once a calendar source is linked', async () => {
  auth.onboarding.linkedSourceCount = 1
  renderHome()
  await waitFor(() => expect(assistantCalls()).toHaveLength(1))
  expect(screen.queryByRole('link', { name: /connect your schedule/i })).toBeNull()
})

// The next-class board's Get Directions linked to plain /map, so the map
// opened with nothing selected. It now carries the class's building and room,
// the deep link Schedule's Find Room already used.
function classIn(hours: number, location: string) {
  const start = new Date(Date.now() + hours * 3600_000)
  const end = new Date(start.getTime() + 50 * 60_000)
  return { title: 'CS 30200', description: 'Lecture', location, startTime: start.toISOString(), endTime: end.toISOString() }
}

it('points Get Directions at the next class\'s building', async () => {
  classes.items = [classIn(2, 'SL 008')]
  renderHome()
  const link = await screen.findByRole('link', { name: /get directions/i })
  await waitFor(() => expect(link.getAttribute('href')).toBe('/map?building=SL&room=SL%20008'))
})

it('keeps Get Directions on plain /map when there is no class', async () => {
  renderHome()
  const link = await screen.findByRole('link', { name: /get directions/i })
  expect(link.getAttribute('href')).toBe('/map')
})
