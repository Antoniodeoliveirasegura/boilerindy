import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import Events from './Events'
import { authRequest } from '../lib/authApi'

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../components/AiMarkdown', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
const auth = vi.hoisted(() => ({ user: { id: 'user-1' }, onboarding: { linkedSourceCount: 1 } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

const HOUR = 60 * 60 * 1000

type Item = { id: string; title: string; category?: string; startTime: string; location?: string }
let calendar: { items: Item[] } | Error

function event(id: string, title: string, fromNowMs: number): Item {
  return { id, title, category: 'campus_event', startTime: new Date(Date.now() + fromNowMs).toISOString(), location: 'Campus Center' }
}

beforeEach(() => {
  localStorage.clear()
  // jsdom has no scrollIntoView; selecting an event on a narrow screen calls it.
  Element.prototype.scrollIntoView = vi.fn()
  calendar = { items: [event('ev-1', 'Career fair prep workshop', 26 * HOUR)] }
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// A client per test, with no retries, so a failed read settles at once.
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Events />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function detailCard(title: string) {
  return screen.getByRole('heading', { level: 3, name: title }).closest('.card') as HTMLElement
}

describe('a failed calendar read', () => {
  // Once the retries were spent the page fell through to its empty state, so
  // a 502 or a dropped connection told the student there were no events.
  it('says the calendar did not load instead of "No events found", and Try again reloads it', async () => {
    calendar = Object.assign(new Error('<html><body><h1>502 Bad Gateway</h1></body></html>'), { status: 502 })
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load your calendar')
    expect(screen.queryByText('No events found')).not.toBeInTheDocument()
    expect(screen.queryByText(/0 upcoming events/)).not.toBeInTheDocument()

    calendar = { items: [event('ev-1', 'Career fair prep workshop', 26 * HOUR)] }
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /Career fair prep workshop/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('1 upcoming events from your calendar')).toBeInTheDocument()
  })

  it('still shows "No events found" when the calendar loads empty', async () => {
    calendar = { items: [] }
    renderPage()
    expect(await screen.findByText('No events found')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('category labels', () => {
  // Every exam and assignment wore the fallback "Event" badge while its pill
  // read "Exam" or "Assignment", and a row with no category counted under the
  // Event pill but that pill filtered it out.
  it('gives each category its own badge, matching its pill and its filter', async () => {
    calendar = {
      items: [
        event('ev-1', 'Career fair prep workshop', 2 * HOUR),
        { ...event('ex-1', 'CS 25100 Midterm', 3 * HOUR), category: 'exam' },
        { ...event('as-1', 'ECE 20200 Homework 6', 4 * HOUR), category: 'assignment' },
        { ...event('sh-1', 'Startup showcase', 5 * HOUR), category: 'demo_day' },
        { ...event('mic-1', 'Open mic night', 6 * HOUR), category: undefined },
      ],
    }
    renderPage()

    const row = async (title: string) => screen.findByRole('button', { name: new RegExp(title) })
    expect(within(await row('Career fair prep workshop')).getByText('Campus Event')).toBeInTheDocument()
    expect(within(await row('CS 25100 Midterm')).getByText('Exam')).toBeInTheDocument()
    expect(within(await row('ECE 20200 Homework 6')).getByText('Assignment')).toBeInTheDocument()
    expect(within(await row('Startup showcase')).getByText('Demo day')).toBeInTheDocument()
    expect(within(await row('Open mic night')).getByText('Event')).toBeInTheDocument()

    for (const name of ['All (5)', 'Campus Event (1)', 'Exam (1)', 'Assignment (1)', 'Demo day (1)', 'Event (1)']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }

    fireEvent.click(await row('CS 25100 Midterm'))
    expect(within(detailCard('CS 25100 Midterm')).getByText('Exam')).toBeInTheDocument()

    const eventPill = screen.getByRole('button', { name: 'Event (1)' })
    fireEvent.click(eventPill)
    expect(eventPill).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'All (5)' })).toHaveAttribute('aria-pressed', 'false')
    expect(await row('Open mic night')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Career fair prep workshop/ })).not.toBeInTheDocument()
  })
})

describe('the relative time on the details card', () => {
  // It rounded elapsed 24-hour periods up, so an event three hours away read
  // "In Tomorrow" under a "Today" date line and tomorrow's read "In 2 days".
  it('counts calendar days, matching the date line above it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 14, 8, 30)) // Wednesday 8:30 AM, local time
    calendar = {
      items: [
        event('ev-today', 'Trivia night', 3 * HOUR),
        event('ev-soon', 'Coffee chat', 20 * 60 * 1000),
        event('ev-tomorrow', 'Club fair', 30 * HOUR),
        event('ev-sunday', 'Hackathon kickoff', 108 * HOUR),
      ],
    }
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /Trivia night/ }))
    expect(within(detailCard('Trivia night')).getByText('Today')).toBeInTheDocument()
    expect(within(detailCard('Trivia night')).getByText('In 3 hours')).toBeInTheDocument()
    expect(within(detailCard('Trivia night')).queryByText(/In Tomorrow/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Coffee chat/ }))
    expect(within(detailCard('Coffee chat')).getByText('In under an hour')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Club fair/ }))
    // The date line and the relative time both read "Tomorrow".
    expect(within(detailCard('Club fair')).getAllByText('Tomorrow')).toHaveLength(2)
    expect(within(detailCard('Club fair')).queryByText('In 2 days')).not.toBeInTheDocument()

    // Sunday the 18th is four calendar days after Wednesday the 14th.
    fireEvent.click(screen.getByRole('button', { name: /Hackathon kickoff/ }))
    expect(within(detailCard('Hackathon kickoff')).getByText('In 4 days')).toBeInTheDocument()
  })
})

describe('opening an event', () => {
  function stubWidth(wide: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: wide && query === '(min-width: 1024px)', media: query }) as MediaQueryList,
    )
  }

  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
  })

  // Below lg the details stack under the whole list, so on a phone the tap
  // seemed to do nothing until the card was scrolled into view.
  it('scrolls the details into view on a phone', async () => {
    stubWidth(false)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Career fair prep workshop/ }))

    const card = detailCard('Career fair prep workshop')
    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.contexts as Element[]
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0].contains(card)).toBe(true)
  })

  it('leaves the page still from lg, where the details sit beside the list', async () => {
    stubWidth(true)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Career fair prep workshop/ }))
    expect(screen.getByRole('heading', { level: 3, name: 'Career fair prep workshop' })).toBeInTheDocument()
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  // The close button was an icon with no name, read out as just "button".
  it('names the close button', async () => {
    stubWidth(false)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Career fair prep workshop/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Close event details' }))
    expect(screen.queryByRole('heading', { level: 3, name: 'Career fair prep workshop' })).not.toBeInTheDocument()
  })
})

describe('Get Picks', () => {
  const LIMIT = 'You have hit the hourly assistant limit. Try again in a little while.'
  const BUSY = 'The assistant is busy right now. Give it a minute and ask again, or check the Schedule, Dining and Transit tabs directly.'
  const PICKS = '- **Career fair prep workshop** Thursday 2:30 PM. You are free then.'
  const recsCached = () => Object.keys(localStorage).some((key) => key.startsWith('ai-event-recs-user-1-'))

  function answer(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  async function getPicks() {
    fireEvent.click(await screen.findByRole('button', { name: 'Get Picks' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Thinking…' })).not.toBeInTheDocument())
  }

  // The button used to go busy, then back to "Get Picks" with nothing said.
  it("shows the limiter's message on a 429", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(429, { error: LIMIT }))
    renderPage()
    await getPicks()
    expect(screen.getByRole('alert')).toHaveTextContent(LIMIT)
    expect(screen.getByRole('button', { name: 'Get Picks' })).toBeInTheDocument()
    expect(recsCached()).toBe(false)
  })

  it('shows the message from an error object, as the app error handler sends it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(500, { error: { message: 'Internal server error.', status: 500 } }))
    renderPage()
    await getPicks()
    expect(screen.getByRole('alert')).toHaveTextContent('Internal server error.')
  })

  it('says the assistant could not be reached when the request gets no response', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    renderPage()
    await getPicks()
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reach the assistant right now. Try again in a moment.")
  })

  // A busy 200 carries a status line in `reply`; it was shown and cached for
  // the whole day as if it were the picks.
  it('shows a busy reply as the message and does not keep it as the picks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(200, { reply: BUSY, source: 'busy' }))
    renderPage()
    await getPicks()
    expect(screen.getByRole('alert')).toHaveTextContent(BUSY)
    expect(screen.getByRole('button', { name: 'Get Picks' })).toBeInTheDocument()
    expect(recsCached()).toBe(false)
  })

  it('shows and caches real picks, and clears an earlier failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(answer(429, { error: LIMIT }))
    renderPage()
    await getPicks()
    expect(screen.getByRole('alert')).toHaveTextContent(LIMIT)

    fetchSpy.mockResolvedValueOnce(answer(200, { reply: PICKS }))
    await getPicks()
    expect(screen.getByText(PICKS)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(recsCached()).toBe(true)
  })
})
