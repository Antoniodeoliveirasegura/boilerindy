import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Home from './Home'

// Issue #371: with nothing connected, Home still asked the assistant for a
// Week ahead digest, and the model filled the empty context with invented
// classes. Without a calendar source (linked or added by hand) the card now
// shows an empty state and never calls /api/assistant.

// A failed layout fetch keeps the default dashboard, which has the Week ahead card.
// Classes, the calendar and the task list come back empty unless a test fills
// them; `calendar.down` fails every calendar read, as through a gateway 502.
const classes = vi.hoisted(() => ({ items: [] as Record<string, unknown>[] }))
const calendar = vi.hoisted(() => ({ items: [] as Record<string, unknown>[], down: false }))
const tasks = vi.hoisted(() => ({
  completions: [] as Record<string, unknown>[],
  manualTasks: [] as Record<string, unknown>[],
}))
vi.mock('../lib/authApi', () => ({
  authRequest: vi.fn(async (path: string) => {
    if (path === '/api/me/dashboard') throw new Error('offline')
    if (path.startsWith('/api/me/classes')) return { items: classes.items }
    if (path.startsWith('/api/me/calendar?')) {
      if (calendar.down) throw Object.assign(new Error('<html><body><h1>502 Bad Gateway</h1></body></html>'), { status: 502 })
      return { items: calendar.items }
    }
    if (path === '/api/me/tasks/meta') return tasks
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
  calendar.items = []
  calendar.down = false
  tasks.completions = []
  tasks.manualTasks = []
})

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter useTransitions={false}>
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

const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString()

function tasksDueCard() {
  return screen.getByRole('heading', { name: 'Tasks Due' }).closest('.card') as HTMLElement
}

// Home read the calendar alone, so a quiz ticked off on Assignments kept its
// Heads up and urgent badge, and a task added by hand never showed on Home.
it('leaves finished tasks out of Tasks due and Heads up and lists the tasks added by hand', async () => {
  calendar.items = [
    { id: 'quiz-3', title: 'CS 25100 Quiz 3', category: 'quiz', startTime: inHours(15), endTime: inHours(15) },
    { id: 'hw-6', title: 'ECE 20200 Homework 6', category: 'assignment', startTime: inHours(30), endTime: inHours(30) },
  ]
  tasks.completions = [{ calendar_item_id: 'quiz-3', completed_at: new Date().toISOString() }]
  tasks.manualTasks = [
    { id: 'm1', title: 'Pay tuition', startTime: inHours(5), completedAt: null, category: 'manual_task' },
    { id: 'm2', title: 'Return library books', startTime: inHours(6), completedAt: new Date().toISOString(), category: 'manual_task' },
  ]
  renderHome()

  expect(await within(tasksDueCard()).findByText('Pay tuition')).toBeInTheDocument()
  expect(within(tasksDueCard()).getByText('Homework 6')).toBeInTheDocument()
  expect(within(tasksDueCard()).queryByText('Quiz 3')).toBeNull()
  expect(screen.getByText('Pay tuition is due in 5h')).toBeInTheDocument()
  expect(screen.queryByText(/Quiz 3 is due in/)).toBeNull()
  expect(screen.queryByText(/Return library books/)).toBeNull()
})

// Heads up rounded to the nearest hour and the task rows round up, so a task
// due in 15 and a half hours read "due in 15h" up top and "Due in 16h" on its
// row, and one due in 15 minutes read "due in 0h".
it('gives Heads up and the task rows the same hours', async () => {
  tasks.manualTasks = [
    { id: 'm1', title: 'Pay tuition', startTime: inHours(15.5), completedAt: null, category: 'manual_task' },
    { id: 'm2', title: 'Submit lab report', startTime: inHours(0.25), completedAt: null, category: 'manual_task' },
  ]
  renderHome()

  expect(await screen.findByText('Pay tuition is due in 16h')).toBeInTheDocument()
  expect(screen.getByText('Submit lab report is due in 1h')).toBeInTheDocument()
  expect(within(tasksDueCard()).getByText('Due in 16h')).toBeInTheDocument()
  expect(within(tasksDueCard()).getByText('Due in 1h')).toBeInTheDocument()
})

// The free-time suggestion took the feed's first event, so one that ended two
// weeks ago still showed as what to do next.
it('suggests the next event that is not over, never one that already ended', async () => {
  calendar.items = [
    { id: 'old', title: 'Banned Books Week', category: 'campus_event', startTime: inHours(-13 * 24), endTime: inHours(-13 * 24 + 2) },
    { id: 'later', title: 'Career Fair', category: 'campus_event', startTime: inHours(50), endTime: inHours(52) },
    { id: 'soon', title: 'Club Night', category: 'event', startTime: inHours(30), endTime: inHours(32) },
  ]
  renderHome()

  expect(await screen.findByText('Club Night')).toBeInTheDocument()
  expect(screen.queryByText('Banned Books Week')).toBeNull()
  expect(screen.queryByText('Career Fair')).toBeNull()
})

// The Free Time card's suggestion rows, so an event also listed under Today's
// events counts only where it is suggested.
async function freeTimeRows() {
  const card = (await screen.findByRole('heading', { name: 'Free Time' })).closest('.card') as HTMLElement
  return within(card)
}

const startOfToday = () => {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  return midnight
}
const daysFromToday = (days: number) => new Date(startOfToday().getTime() + days * 24 * 3600_000)

// The first version of that fix kept an event with no end time only while its
// start was ahead, so an all-day event of today vanished from the suggestion at
// midnight while Today's events still listed it.
it('keeps an all-day event of today in the suggestion when it has no end time', async () => {
  calendar.items = [
    { id: 'fair', title: 'Career Fair', category: 'campus_event', startTime: inHours(50), endTime: inHours(52) },
    { id: 'homecoming', title: 'Homecoming Day', category: 'campus_event', startTime: startOfToday().toISOString() },
  ]
  renderHome()

  const rows = await freeTimeRows()
  const row = (await rows.findByText('Homecoming Day')).closest('li') as HTMLElement
  expect(row).toHaveTextContent('Today · All day')
  expect(rows.queryByText('Career Fair')).toBeNull()
})

// Sorted by start alone, an event running all week came first every day, under
// its start date, which read like an event in the past.
it("suggests tonight's event ahead of one running all week", async () => {
  calendar.items = [
    { id: 'week', title: 'Banned Books Week', category: 'campus_event', startTime: daysFromToday(-4).toISOString(), endTime: inHours(48) },
    { id: 'tonight', title: 'Club Night', category: 'event', startTime: inHours(3), endTime: inHours(5) },
  ]
  renderHome()

  const rows = await freeTimeRows()
  expect(await rows.findByText('Club Night')).toBeInTheDocument()
  expect(rows.queryByText('Banned Books Week')).toBeNull()
})

it('shows a week-long event that is the only one left as on now, until its last day', async () => {
  // Ends at midnight three days on, so its last day is the day before.
  const end = daysFromToday(3)
  calendar.items = [
    { id: 'week', title: 'Banned Books Week', category: 'campus_event', startTime: daysFromToday(-4).toISOString(), endTime: end.toISOString() },
  ]
  renderHome()

  const rows = await freeTimeRows()
  const row = (await rows.findByText('Banned Books Week')).closest('li') as HTMLElement
  const lastDay = new Date(end.getTime() - 1).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  expect(row).toHaveTextContent(`On now · until ${lastDay}`)
})

// A feed deadline ends when it starts, and the rows used the event formatter.
it('shows a deadline as one time, never a zero-length range', async () => {
  const due = new Date()
  due.setDate(due.getDate() + 2)
  due.setHours(23, 59, 0, 0)
  calendar.items = [{ id: 'hw-6', title: 'ECE 20200 Homework 6', category: 'assignment', startTime: due.toISOString(), endTime: due.toISOString() }]
  renderHome()

  expect(await within(tasksDueCard()).findByText(/^Due by end of day · /)).toBeInTheDocument()
  expect(within(tasksDueCard()).queryByText(/11:59 PM - 11:59 PM/)).toBeNull()
})

// The empty state used to say "Nothing due right now" when the read failed.
it('says the calendar could not load, with Try again, instead of "Nothing due right now"', async () => {
  calendar.down = true
  renderHome()

  const alert = await within(tasksDueCard()).findByRole('alert')
  expect(alert).toHaveTextContent('Could not load your calendar, so deadlines from it are missing.')
  expect(within(tasksDueCard()).queryByText(/Nothing due right now/)).toBeNull()

  calendar.down = false
  calendar.items = [{ id: 'hw-6', title: 'ECE 20200 Homework 6', category: 'assignment', startTime: inHours(30), endTime: inHours(30) }]
  fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
  expect(await within(tasksDueCard()).findByText('Homework 6')).toBeInTheDocument()
  expect(within(tasksDueCard()).queryByRole('alert')).toBeNull()
})

// Home expanded classes added by hand for today alone: the week strip showed
// them on today only, and the next-class board skipped tomorrow's.
it('counts a class added by hand on the days it meets and shows tomorrow\'s on the next-class board', async () => {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const day = tomorrow.toLocaleDateString('en-US', { weekday: 'long' })
  localStorage.setItem(
    'boilerindy-schedule-overrides-v1-user-1',
    JSON.stringify({
      series: {},
      manual: [{ id: 'bio', code: 'BIOL 11000', name: 'Fundamentals of Biology', room: 'LILY 1105', days: [day], startHm: '07:00', endHm: '07:50' }],
    }),
  )
  renderHome()

  expect((await screen.findAllByText('BIOL 11000')).length).toBeGreaterThan(0)
  expect(screen.queryByText('No upcoming classes')).toBeNull()
  const strip = screen.getByRole('list', { name: 'Your next seven days' })
  const labels = Array.from(strip.querySelectorAll('li .sr-only'), (el) => el.textContent ?? '')
  expect(labels.filter((label) => label.includes('1 class'))).toEqual([labels[1]])
})

// Week ahead read only `reply`, so a refused or failed generation left the
// card with no summary and nothing said.
it('says why the week ahead could not be generated', async () => {
  auth.onboarding.linkedSourceCount = 1
  fetchMock.mockImplementation(async (url: unknown) =>
    String(url) === '/api/assistant'
      ? new Response(JSON.stringify({ error: 'You have hit the hourly assistant limit. Try again in a little while.' }), { status: 429 })
      : new Response('{}', { status: 200 }),
  )
  renderHome()

  expect(await screen.findByText('You have hit the hourly assistant limit. Try again in a little while.')).toHaveAttribute('role', 'alert')
  expect(screen.queryByText(/Generating your week summary/)).toBeNull()
})

// Issue #465: the feed flags Saturday and Sunday closed while Tower serves a
// full weekend menu. The server now sends is_open: null with "Hours not
// listed" for such a day, and Home must not call the hall closed.
function diningSnapshot(tower: Record<string, unknown>) {
  return {
    ok: true,
    date: '2026-10-17',
    weekday: 'Saturday',
    locations: [
      {
        id: 'tower-dining',
        slug: 'tower-dining',
        name: 'Tower Dining',
        kind: 'dining-hall',
        weekly_hours: { Saturday: 'Hours not listed', Monday: '7:00 AM - 9:00 PM' },
        stations: [{ name: 'Daily Grill', items: [{ name: 'Cheeseburger' }] }],
        ...tower,
      },
    ],
  }
}

function serveDining(snapshot: unknown) {
  fetchMock.mockImplementation(async (url: unknown) =>
    String(url).startsWith('/api/dining')
      ? new Response(JSON.stringify(snapshot), { status: 200 })
      : new Response(JSON.stringify({ reply: 'You have CS 30200 at 2:30pm.' }), { status: 200 }),
  )
}

function diningCard() {
  return screen.getByRole('heading', { name: 'Dining Snapshot' }).closest('.card') as HTMLElement
}

it('never calls Tower closed on a day with a posted menu and no listed hours', async () => {
  serveDining(diningSnapshot({ is_open: null, hours: 'Hours not listed' }))
  renderHome()

  const status = await waitFor(() => {
    const el = diningCard().querySelector('[data-dining-widget-status]')
    expect(el?.textContent).toBe('Menu posted')
    return el as HTMLElement
  })
  expect(status.querySelector('.status-unknown')).not.toBeNull()
  expect(within(diningCard()).getByText('Hours not listed')).toBeInTheDocument()
  expect(within(diningCard()).getByText('Cheeseburger')).toBeInTheDocument()
  expect(screen.queryByText(/is closed right now/)).toBeNull()
})

it('still says a hall is closed when the feed says so and there is no menu', async () => {
  serveDining(diningSnapshot({ is_open: false, hours: 'Closed today', weekly_hours: { Saturday: 'Closed' }, stations: [] }))
  renderHome()

  expect(await screen.findByText('Tower Dining is closed right now')).toBeInTheDocument()
  expect(diningCard().querySelector('[data-dining-widget-status]')?.textContent).toBe('Closed')
})

// Issue #466: the widget previews the meal being served on campus time, the
// dishes that change today ahead of the every-day ones, and names the meal.
it('previews the current meal, specials first', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-14T12:30:00-04:00'))
  try {
    const grill = { name: 'Daily Grill', everyday: true, items: [{ name: 'Cheeseburger' }] }
    serveDining(
      diningSnapshot({
        is_open: true,
        hours: '7:00 AM - 9:00 PM',
        menus: [
          { meal: 'breakfast', stations: [{ name: 'Breakfast Entree Line', everyday: false, items: [{ name: 'Pancakes' }] }] },
          { meal: 'lunch', stations: [grill, { name: 'Chef Made Soups', everyday: false, items: [{ name: 'Chicken Miso Soup' }] }] },
        ],
      }),
    )
    renderHome()

    expect(await within(await waitFor(() => diningCard())).findByText("Today's lunch")).toBeInTheDocument()
    const items = within(diningCard()).getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['Chicken Miso Soup', 'Cheeseburger'])
    expect(within(diningCard()).queryByText('Pancakes')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

// Issue #469: a favorite dish on today's or tomorrow's menu is a smart alert.
it('says when a favorite dish is on today\'s menu', async () => {
  const { authRequest } = await import('../lib/authApi')
  const base = vi.mocked(authRequest).getMockImplementation()!
  vi.mocked(authRequest).mockImplementation(async (path: string, ...rest: unknown[]) =>
    path === '/api/me/dining/favorites' ? { favorites: ['cheeseburger', 'jamaican jerk chicken'] } : base(path, ...(rest as [])),
  )
  try {
    const upcoming = {
      ok: true,
      today: '2026-10-17',
      days: [{ date: '2026-10-18', tentative: false, holiday: null, meals: [{ meal: 'dinner', location: 'Tower Dining', headliners: [{ name: 'Jamaican Jerk Chicken', image: null }], specials: [] }] }],
    }
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url)
      if (path.startsWith('/api/dining/upcoming')) return new Response(JSON.stringify(upcoming))
      if (path.startsWith('/api/dining')) return new Response(JSON.stringify(diningSnapshot({ is_open: true, hours: '7:00 AM - 9:00 PM' })))
      return new Response(JSON.stringify({ reply: 'ok' }))
    })
    renderHome()
    // Today's menu wins over tomorrow's look-ahead.
    expect(await screen.findByText('Cheeseburger is on the menu at Tower Dining today')).toBeInTheDocument()
    expect(screen.queryByText(/tomorrow$/)).toBeNull()
  } finally {
    vi.mocked(authRequest).mockImplementation(base)
  }
})

it('says when a favorite dish is back tomorrow', async () => {
  const { authRequest } = await import('../lib/authApi')
  const base = vi.mocked(authRequest).getMockImplementation()!
  vi.mocked(authRequest).mockImplementation(async (path: string, ...rest: unknown[]) =>
    path === '/api/me/dining/favorites' ? { favorites: ['jamaican jerk chicken'] } : base(path, ...(rest as [])),
  )
  try {
    const upcoming = {
      ok: true,
      today: '2026-10-17',
      days: [{ date: '2026-10-18', tentative: false, holiday: null, meals: [{ meal: 'dinner', location: 'Tower Dining', headliners: [{ name: 'Jamaican Jerk Chicken', image: null }], specials: [] }] }],
    }
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url)
      if (path.startsWith('/api/dining/upcoming')) return new Response(JSON.stringify(upcoming))
      if (path.startsWith('/api/dining')) return new Response(JSON.stringify(diningSnapshot({ is_open: true })))
      return new Response(JSON.stringify({ reply: 'ok' }))
    })
    renderHome()
    expect(await screen.findByText('Jamaican Jerk Chicken is on the menu at Tower Dining tomorrow')).toBeInTheDocument()
  } finally {
    vi.mocked(authRequest).mockImplementation(base)
  }
})
