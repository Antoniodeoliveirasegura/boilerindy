import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import Events from './Events'
import { authRequest } from '../lib/authApi'

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../components/AiMarkdown', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
const auth = vi.hoisted(() => ({ user: { id: 'user-1', aiOptIn: false }, onboarding: { linkedSourceCount: 1 } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

const HOUR = 60 * 60 * 1000

type Item = {
  id: string
  title: string
  category?: string
  startTime: string
  endTime?: string | null
  location?: string
  shared?: boolean
  sourceKey?: string
  sourceLabel?: string
  sourceUrl?: string | null
  organizationKey?: string | null
  followed?: boolean
}
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
      <MemoryRouter useTransitions={false}>
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

// Issue #30: the shared campus events the server adds to this window while its
// feed is on.
describe('shared campus events', () => {
  function shared(id: string, title: string, fromNowMs: number, extra: Partial<Item> = {}): Item {
    return {
      ...event(id, title, fromNowMs),
      id: `campus:${id}`,
      shared: true,
      sourceKey: 'iu_events',
      sourceLabel: 'IU event',
      sourceUrl: `https://events.iu.edu/event/${id}`,
      ...extra,
    }
  }

  afterEach(() => {
    auth.onboarding = { linkedSourceCount: 1 }
  })

  it('asks for them, labels each with its source and links out to the listing from the details', async () => {
    calendar = {
      items: [
        event('ev-1', 'Career fair prep workshop', 2 * HOUR),
        shared('yoga', 'Yoga in the Natatorium', 3 * HOUR),
        shared('thanksgiving', 'Thanksgiving Vacation', 40 * HOUR, {
          category: 'deadline',
          sourceKey: 'purdue_events',
          sourceLabel: 'Purdue event',
          sourceUrl: 'https://events.purdue.edu/event/thanksgiving',
        }),
      ],
    }
    renderPage()

    const yoga = await screen.findByRole('button', { name: /Yoga in the Natatorium/ })
    expect(vi.mocked(authRequest).mock.calls.map(([path]) => String(path))).toContain(
      '/api/me/calendar?categories=campus_event%2Cevent%2Cdeadline&limit=500&shared=1',
    )
    expect(screen.getByText('3 upcoming events from your calendar and campus calendars')).toBeInTheDocument()
    expect(within(yoga).getByText('IU event')).toHaveAttribute('title', 'Listed on events.iu.edu')
    expect(within(screen.getByRole('button', { name: /Thanksgiving Vacation/ })).getByText('Purdue event')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /Career fair prep workshop/ })).queryByText(/ event$/)).not.toBeInTheDocument()

    fireEvent.click(yoga)
    const link = within(detailCard('Yoga in the Natatorium')).getByRole('link', { name: 'View on events.iu.edu' })
    expect(link).toHaveAttribute('href', 'https://events.iu.edu/event/yoga')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(within(detailCard('Yoga in the Natatorium')).getByText('IU event')).toBeInTheDocument()

    // The student's own events have no source and no link.
    fireEvent.click(screen.getByRole('button', { name: /Career fair prep workshop/ }))
    expect(within(detailCard('Career fair prep workshop')).queryByRole('link')).not.toBeInTheDocument()
  })

  it("filters by source: Purdue's calendars, IU's or the student's own, with a count on each pill", async () => {
    calendar = {
      items: [
        event('ev-1', 'Career fair prep workshop', 2 * HOUR),
        shared('yoga', 'Yoga in the Natatorium', 3 * HOUR),
        shared('chili', 'United Way Chili Cook-off', 4 * HOUR),
        shared('fuel', 'Boiler Fuel Up', 5 * HOUR, {
          sourceKey: 'purdue_events',
          sourceLabel: 'Purdue event',
          sourceUrl: 'https://events.purdue.edu/event/fuel',
        }),
      ],
    }
    renderPage()
    await screen.findByRole('button', { name: /Yoga in the Natatorium/ })
    const pills = screen.getByRole('group', { name: 'Event source' })
    expect(within(pills).getAllByRole('button').map((pill) => pill.textContent)).toEqual([
      'All sources', 'Purdue (1)', 'IU (2)', 'My calendar (1)',
    ])
    expect(within(pills).getByRole('button', { name: 'All sources' })).toHaveAttribute('aria-pressed', 'true')
    const listed = () =>
      ['Career fair prep workshop', 'Yoga in the Natatorium', 'United Way Chili Cook-off', 'Boiler Fuel Up'].filter((title) =>
        screen.queryByRole('button', { name: new RegExp(title) }),
      )

    fireEvent.click(within(pills).getByRole('button', { name: 'IU (2)' }))
    expect(within(pills).getByRole('button', { name: 'IU (2)' })).toHaveAttribute('aria-pressed', 'true')
    expect(listed()).toEqual(['Yoga in the Natatorium', 'United Way Chili Cook-off'])
    expect(screen.getByText('2 upcoming events from your calendar and campus calendars')).toBeInTheDocument()

    fireEvent.click(within(pills).getByRole('button', { name: 'Purdue (1)' }))
    expect(listed()).toEqual(['Boiler Fuel Up'])
    fireEvent.click(within(pills).getByRole('button', { name: 'My calendar (1)' }))
    expect(listed()).toEqual(['Career fair prep workshop'])
    fireEvent.click(within(pills).getByRole('button', { name: 'All sources' }))
    expect(listed()).toHaveLength(4)
  })

  it('shows no source pills while every row comes from one place', async () => {
    renderPage()
    await screen.findByRole('button', { name: /Career fair prep workshop/ })
    expect(screen.queryByRole('group', { name: 'Event source' })).not.toBeInTheDocument()
  })

  // Issue #30: White River State Park's rows, which the server sends while
  // CAMPUS_EVENTS_DOWNTOWN is on, labeled "Downtown".
  it('gives downtown rows a Downtown label, an Event badge and a Downtown pill of their own', async () => {
    const park = (id: string, title: string, fromNowMs: number) =>
      shared(id, title, fromNowMs, {
        location: 'Indiana State Museum, 650 West Washington Street, Indianapolis',
        sourceKey: 'wrsp_events',
        sourceLabel: 'Downtown',
        sourceUrl: `https://whiteriverstatepark.org/event/${id}/`,
      })
    calendar = {
      items: [
        event('ev-1', 'Career fair prep workshop', 2 * HOUR),
        shared('yoga', 'Yoga in the Natatorium', 3 * HOUR),
        park('twilight', 'Twilight Tales: Beyond the Grave (18+)', 4 * HOUR),
        park('heroes', 'Heroes from the Heartland', 5 * HOUR),
      ],
    }
    renderPage()
    const twilight = await screen.findByRole('button', { name: /Twilight Tales/ })
    expect(within(twilight).getByText('Downtown')).toHaveAttribute('title', 'Listed on whiteriverstatepark.org')
    // Not a campus event: its category badge, and the category pills, say Event.
    expect(within(twilight).getByText('Event')).toBeInTheDocument()
    expect(within(twilight).queryByText('Campus Event')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Campus Event (2)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Event (2)' })).toBeInTheDocument()

    const pills = screen.getByRole('group', { name: 'Event source' })
    expect(within(pills).getAllByRole('button').map((pill) => pill.textContent)).toEqual([
      'All sources', 'IU (1)', 'Downtown (2)', 'My calendar (1)',
    ])
    fireEvent.click(within(pills).getByRole('button', { name: 'Downtown (2)' }))
    expect(within(pills).getByRole('button', { name: 'Downtown (2)' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /Yoga in the Natatorium/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Career fair prep workshop/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Heroes from the Heartland/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Twilight Tales/ }))
    const details = detailCard('Twilight Tales: Beyond the Grave (18+)')
    expect(within(details).getByText('Downtown')).toBeInTheDocument()
    expect(within(details).getByText('Event')).toBeInTheDocument()
    expect(within(details).getByRole('link', { name: 'View on whiteriverstatepark.org' })).toHaveAttribute(
      'href',
      'https://whiteriverstatepark.org/event/twilight/',
    )
  })

  it('fills the page for a student with no linked calendar, from the campus calendars', async () => {
    auth.onboarding = { linkedSourceCount: 0 }
    calendar = { items: [shared('chili', 'United Way Chili Cook-off', 5 * HOUR)] }
    renderPage()

    expect(await screen.findByRole('button', { name: /United Way Chili Cook-off/ })).toBeInTheDocument()
    expect(screen.getByText('1 upcoming events from campus calendars')).toBeInTheDocument()
    expect(screen.queryByText('No events found')).not.toBeInTheDocument()
    // Linking Brightspace still adds the student's own events.
    expect(screen.getByRole('link', { name: /Connect Brightspace/ })).toBeInTheDocument()
  })

  it('keeps an exhibit open since an earlier day listed under Today until it closes, and drops what has ended', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 14, 15, 0)) // Wednesday 3:00 PM, local time
    const closes = new Date(2026, 9, 31, 17, 0)
    calendar = {
      items: [
        shared('herron', 'Herron gallery exhibit', 0, { startTime: new Date(2026, 9, 1, 10, 0).toISOString(), endTime: closes.toISOString() }),
        shared('lunch', 'Lunch and learn', 0, {
          startTime: new Date(2026, 9, 14, 11, 0).toISOString(),
          endTime: new Date(2026, 9, 14, 13, 0).toISOString(),
        }),
        event('ev-tonight', 'Trivia night', 4 * HOUR),
      ],
    }
    renderPage()

    const exhibit = await screen.findByRole('button', { name: /Herron gallery exhibit/ })
    const until = closes.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    expect(within(exhibit).getByText(`Until ${until}`)).toBeInTheDocument()
    const today = screen.getByText('Today', { selector: '.eyebrow' }).parentElement as HTMLElement
    expect(within(today).getAllByRole('button').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Herron gallery exhibit'),
      expect.stringContaining('Trivia night'),
    ])
    expect(screen.queryByRole('button', { name: /Lunch and learn/ })).not.toBeInTheDocument()
    expect(screen.getByText('2 upcoming events from your calendar and campus calendars')).toBeInTheDocument()

    fireEvent.click(exhibit)
    expect(within(detailCard('Herron gallery exhibit')).getByText(`On now · until ${until}`)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show past events' }))
    expect(await screen.findByRole('button', { name: /Lunch and learn/ })).toBeInTheDocument()
  })

  // Issue #16: "Clubs I follow" beside the source pills, for the events of the
  // clubs the student follows on /clubs. The server marks each shared row of
  // the student's read with `followed`.
  describe('Clubs I follow', () => {
    const club = (id: string, title: string, fromNowMs: number, followed: boolean) =>
      shared(id, title, fromNowMs, {
        sourceKey: 'boilerlink',
        sourceLabel: 'BoilerLink',
        sourceUrl: `https://boilerlink.purdue.edu/event/${id}`,
        organizationKey: `boilerlink:${id}00`,
        followed,
      })

    it('lists only the followed clubs\' events, with a count on the pill', async () => {
      calendar = {
        items: [
          event('ev-1', 'Career fair prep workshop', 2 * HOUR),
          club('12884656', 'SHPE Industry Networking Night', 3 * HOUR, true),
          club('12838338', 'Indy Climbing Club bouldering', 4 * HOUR, false),
          shared('yoga', 'Yoga in the Natatorium', 5 * HOUR, { followed: false }),
        ],
      }
      renderPage()
      await screen.findByRole('button', { name: /SHPE Industry Networking Night/ })
      const pills = screen.getByRole('group', { name: 'Event source' })
      expect(within(pills).getAllByRole('button').map((pill) => pill.textContent)).toEqual([
        'All sources', 'Purdue (2)', 'IU (1)', 'My calendar (1)', 'Clubs I follow (1)',
      ])

      fireEvent.click(within(pills).getByRole('button', { name: 'Clubs I follow (1)' }))
      expect(within(pills).getByRole('button', { name: 'Clubs I follow (1)' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: /SHPE Industry Networking Night/ })).toBeInTheDocument()
      for (const title of ['Career fair prep workshop', 'Indy Climbing Club bouldering', 'Yoga in the Natatorium']) {
        expect(screen.queryByRole('button', { name: new RegExp(title) })).not.toBeInTheDocument()
      }
      expect(screen.getByText('1 upcoming events from your calendar and campus calendars')).toBeInTheDocument()

      fireEvent.click(within(pills).getByRole('button', { name: 'All sources' }))
      expect(screen.getByRole('button', { name: /Yoga in the Natatorium/ })).toBeInTheDocument()
    })

    it('with no followed club\'s event, says so and links to the clubs to follow', async () => {
      calendar = { items: [club('12838338', 'Indy Climbing Club bouldering', 4 * HOUR, false)] }
      renderPage()
      await screen.findByRole('button', { name: /Indy Climbing Club bouldering/ })
      // One source alone gets no source pills, but the follow pill still shows.
      const pills = screen.getByRole('group', { name: 'Event source' })
      expect(within(pills).getAllByRole('button').map((pill) => pill.textContent)).toEqual(['All sources', 'Clubs I follow (0)'])

      fireEvent.click(within(pills).getByRole('button', { name: 'Clubs I follow (0)' }))
      expect(screen.getByText('No events from clubs you follow')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Find clubs to follow' })).toHaveAttribute('href', '/clubs')
      expect(screen.queryByText('No events found')).not.toBeInTheDocument()
    })

    it('is not offered while the rows do not say what is followed', async () => {
      calendar = {
        items: [
          event('ev-1', 'Career fair prep workshop', 2 * HOUR),
          shared('yoga', 'Yoga in the Natatorium', 3 * HOUR),
          shared('fuel', 'Boiler Fuel Up', 5 * HOUR, { sourceKey: 'purdue_events', sourceLabel: 'Purdue event' }),
        ],
      }
      renderPage()
      await screen.findByRole('button', { name: /Yoga in the Natatorium/ })
      const pills = screen.getByRole('group', { name: 'Event source' })
      expect(within(pills).queryByRole('button', { name: /Clubs I follow/ })).not.toBeInTheDocument()
    })
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

  beforeEach(() => {
    auth.user.aiOptIn = true
  })

  afterEach(() => {
    auth.user.aiOptIn = false
  })

  // AI suggestions are opt-in (Settings): without them the card is not there.
  it('is not shown until the student turns on AI suggestions', async () => {
    auth.user.aiOptIn = false
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(200, {}))
    renderPage()
    expect((await screen.findAllByText('Career fair prep workshop')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Recommended for You')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Get Picks' })).toBeNull()
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === '/api/assistant')).toHaveLength(0)
  })

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
