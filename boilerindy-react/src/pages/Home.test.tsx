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
vi.mock('../lib/authApi', () => ({
  authRequest: vi.fn(async (path: string) => {
    if (path === '/api/me/dashboard') throw new Error('offline')
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
