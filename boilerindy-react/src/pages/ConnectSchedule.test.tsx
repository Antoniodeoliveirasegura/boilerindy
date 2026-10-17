import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ConnectSchedule from './ConnectSchedule'
import { authRequest } from '../lib/authApi'

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn(), setSkipSetup: vi.fn(), startPurdueLink: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../components/PurdueEmailVerification', () => ({ default: () => null }))
const auth = vi.hoisted(() => ({
  onboarding: { needsPurdueConnection: false },
  refreshSession: async () => {},
  user: { id: 'user-1', email: 'student@example.com', hasPurdueLinked: true },
  authConfig: { purdueAuthMode: 'off' },
  startPurdueLink: undefined,
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

const FEED = 'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=t'
const DENIED = 'Calendar access denied. The feed URL may have expired - try generating a new one.'
const SOURCE = { id: 'src-1', label: 'Brightspace Calendar', sourceType: 'brightspace_ical', status: 'ready' }

let sources: (typeof SOURCE)[]

beforeEach(() => {
  sources = []
  // jsdom has no scrollIntoView; a new banner message calls it.
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (path === '/api/me/sources') return { sources }
      if (path === '/api/sources/brightspace/schedule' && options?.method === 'POST') {
        throw Object.assign(new Error(DENIED), { status: 400 })
      }
      if (path === `/api/sync/${SOURCE.id}` && options?.method === 'POST') return { sync: { itemCount: 12 } }
      return {}
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/setup']} useTransitions={false}>
        <ConnectSchedule />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// A refused connect went to the banner above every card, a screen above the
// Connect button on a phone, so the form looked unchanged. It now shows under
// the box, where the student is looking.
it('shows a refused connect under the feed URL box, not in the top banner', async () => {
  renderPage()
  const box = screen.getByLabelText('iCalendar Feed URL')
  fireEvent.change(box, { target: { value: FEED } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect Brightspace' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(DENIED)
  expect(alert).toHaveAttribute('id', 'source-ics-url-hint')
  expect(box).toHaveAttribute('aria-invalid', 'true')
  expect(box).toHaveValue(FEED)
  expect(screen.getAllByText(DENIED)).toHaveLength(1)

  // The next edit clears it, as it does the local URL check's hint.
  fireEvent.change(box, { target: { value: `${FEED}x` } })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

// The Sync result also lands in that banner; on a phone it is scrolled into
// view rather than appearing off screen.
it('scrolls the banner into view when a sync reports back', async () => {
  sources = [SOURCE]
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: 'Sync' }))

  const result = await screen.findByText('Synced successfully! 12 items imported.')
  await waitFor(() => {
    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.contexts as Element[]
    expect(scrolled.some((el) => el.contains(result))).toBe(true)
  })
})

// The trash button was an icon with no name, read out as just "button".
it('names the source delete button after the source', async () => {
  sources = [SOURCE]
  renderPage()
  expect(await screen.findByRole('button', { name: 'Delete Brightspace Calendar' })).toBeInTheDocument()
})
