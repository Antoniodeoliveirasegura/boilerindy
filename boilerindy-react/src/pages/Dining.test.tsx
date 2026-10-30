import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom'
import Dining from './Dining'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'

// Issue #202: starring a dish past the 300-favorite cap (409) or the
// user-write limiter (429) rolled the star back with no word of why. The
// rollback stays (favorites have no device-only copy) and the page now says
// what happened: the server's message for a refusal, a generic line otherwise.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

// The page reads the session from useAuth (issue #366), which throws outside
// AuthProvider; each test sets the state it needs, signed in by default, with
// AI suggestions on so the AI pick is there.
type AuthState = { loading: boolean; user: null | { id: string; aiOptIn?: boolean } }
const SIGNED_IN: AuthState = { loading: false, user: { id: 'user-1', aiOptIn: true } }
const auth = vi.hoisted(() => ({ value: { loading: false, user: { id: 'user-1' } } as AuthState }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.value }))

const CAPPED = 'You can save up to 300 favorites. Remove some to add more.'
const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'

const snapshot = {
  ok: true,
  date: '2026-09-09',
  weekday: 'Wednesday',
  cached: false,
  stale: false,
  locations: [
    {
      id: 'tower-dining',
      slug: 'tower-dining',
      name: 'Tower Dining',
      kind: 'dining-hall',
      address: 'University Tower, 911 W North St, Indianapolis, IN 46202',
      is_open: true,
      hours: '7:00 AM - 9:00 PM',
      closes_at: '9:00 PM',
      opens_at: null,
      open24h: false,
      meal: 'Menus: breakfast, lunch, dinner',
      menusPublished: true,
      stations: [{ name: 'Daily Grill', items: [{ name: 'Veggie Burger', calories: 160, icons: [] }] }],
    },
  ],
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
}

let nextWrite: unknown = null
let savedFavorites: string[] = []

beforeEach(() => {
  nextWrite = null
  savedFavorites = []
  auth.value = SIGNED_IN
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(snapshot)))
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (_path, options) => {
      if (!options?.method) return { favorites: savedFavorites }
      if (nextWrite) {
        const error = nextWrite
        nextWrite = null
        throw error
      }
      return { ok: true }
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// The address the page left, and how it got there.
function Where() {
  const { pathname, search } = useLocation()
  return (
    <p data-testid="where" data-navigation={useNavigationType()}>
      {pathname + search}
    </p>
  )
}

// The page reads the menu through the query cache (issue #251); each test
// gets its own client so nothing leaks between cases. The hall and meal on
// screen live in the address, so it renders in a router at `entry`.
function renderDining(entry = '/dining') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]} useTransitions={false}>
        <Dining />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(tree())
  return {
    ...view,
    /** Re-render after changing auth.value, as a session change would. */
    rerenderDining: () => view.rerender(tree()),
  }
}

// The star, not the dish's own button, which opens its details (issue #468).
async function star() {
  return screen.findByRole('button', { name: /Veggie Burger (to|from) favorites/ })
}

it.each([
  [409, CAPPED],
  [429, LIMITED],
])('a %i on starring a dish rolls the star back and shows the message', async (status, message) => {
  renderDining()
  nextWrite = httpError(status, message)

  fireEvent.click(await star())
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(await star()).toHaveAttribute('aria-pressed', 'false')

  // The next toggle clears the notice and saves.
  fireEvent.click(await star())
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(await star()).toHaveAttribute('aria-pressed', 'true')
})

it('a network error on starring a dish rolls it back with a generic message', async () => {
  renderDining()
  nextWrite = new TypeError('Failed to fetch')

  fireEvent.click(await star())
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save that favorite. Please try again.')
  expect(await star()).toHaveAttribute('aria-pressed', 'false')
})

// Issue #367 - signed-in pages title the tab after their heading too.
it('titles the tab after the page', async () => {
  renderDining()
  await star()
  expect(document.title).toBe('Campus Dining - BoilerIndy')
})

// Issue #366: signed-out visitors can open the page. They get the menus and
// none of the per-user pieces, and the page never calls the per-user API,
// whose 401 would send them to /login with a false "session expired".
describe('signed out (the public preview)', () => {
  beforeEach(() => {
    auth.value = { loading: false, user: null }
  })

  it('shows the menu with no stars, favorites or AI pick, and no per-user request', async () => {
    renderDining()
    expect(await screen.findByText('Veggie Burger')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh menus' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /favorites/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /What should I eat/ })).toBeNull()
    expect(document.querySelector('[data-dining-favorites]')).toBeNull()
    expect(authRequest).not.toHaveBeenCalled()
  })

  it('signing out drops the favorites the page had loaded', async () => {
    auth.value = SIGNED_IN
    savedFavorites = ['veggie burger']
    const { rerenderDining } = renderDining()
    expect(await screen.findByRole('button', { name: 'Remove Veggie Burger from favorites' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('[data-dining-favorites]')).not.toBeNull()

    auth.value = { loading: false, user: null }
    rerenderDining()
    expect(screen.queryByRole('button', { name: /favorites/ })).toBeNull()
    expect(document.querySelector('[data-dining-favorites]')).toBeNull()
    expect(screen.getByText('Veggie Burger')).toBeInTheDocument()
  })
})

describe('signed in', () => {
  it('shows the stars and the AI pick', async () => {
    renderDining()
    expect(await star()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /What should I eat/ })).toBeInTheDocument()
    expect(authRequest).toHaveBeenCalledWith('/api/me/dining/favorites')
  })

  // AI suggestions are opt-in (Settings): without them the stars stay and the
  // AI pick goes.
  it('leaves out the AI pick until the student turns on AI suggestions', async () => {
    auth.value = { loading: false, user: { id: 'user-1', aiOptIn: false } }
    renderDining()
    expect(await star()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /What should I eat/ })).toBeNull()
  })

  it('reads favorites only once auth has settled', async () => {
    auth.value = { loading: true, user: { id: 'user-1' } }
    const { rerenderDining } = renderDining()
    expect(await screen.findByText('Veggie Burger')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /favorites/ })).toBeNull()
    expect(authRequest).not.toHaveBeenCalled()

    auth.value = SIGNED_IN
    rerenderDining()
    expect(await star()).toBeInTheDocument()
    expect(authRequest).toHaveBeenCalledTimes(1)
    expect(authRequest).toHaveBeenCalledWith('/api/me/dining/favorites')
  })
})

// What should I eat? read only `reply`, so the hourly limit's 429, the 502 when
// Groq fails or no answer at all put the button back with nothing said (R60).
describe('the AI pick', () => {
  const LIMIT = 'You have hit the hourly assistant limit. Try again in a little while.'

  function assistantAnswers(answer: () => Promise<Response>) {
    vi.mocked(globalThis.fetch).mockImplementation(async (url) =>
      url === '/api/assistant' ? answer() : new Response(JSON.stringify(snapshot)),
    )
  }

  async function ask() {
    renderDining()
    await star()
    fireEvent.click(screen.getByRole('button', { name: 'What should I eat?' }))
  }

  it('shows the pick', async () => {
    assistantAnswers(async () => new Response(JSON.stringify({ reply: 'Try the **Veggie Burger** at Tower Dining.' })))
    await ask()
    expect(await screen.findByText(/at Tower Dining\./)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says why the pick failed', async () => {
    assistantAnswers(async () => new Response(JSON.stringify({ error: LIMIT }), { status: 429 }))
    await ask()
    expect(await screen.findByRole('alert')).toHaveTextContent(LIMIT)
    expect(screen.getByRole('button', { name: 'What should I eat?' })).toBeEnabled()
  })

  it('says the assistant could not be reached when the request fails', async () => {
    assistantAnswers(async () => {
      throw new TypeError('Failed to fetch')
    })
    await ask()
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the assistant right now. Try again in a moment.")
  })
})

// Issue #465: on a weekend the feed flags Tower closed while it serves a full
// menu. The server sends is_open: null and "Hours not listed"; the page says a
// menu is posted, prints "Not listed" for those days, and links the official hours.
describe('a day the feed flags closed but that has a menu', () => {
  const saturday = {
    ...snapshot,
    date: '2026-10-17',
    weekday: 'Saturday',
    locations: [
      {
        ...snapshot.locations[0],
        is_open: null,
        hours: 'Hours not listed',
        closes_at: null,
        opens_at: null,
        weekly_hours: {
          Monday: '7:00 AM - 9:00 PM',
          Tuesday: '7:00 AM - 9:00 PM',
          Wednesday: '7:00 AM - 9:00 PM',
          Thursday: '7:00 AM - 9:00 PM',
          Friday: '7:00 AM - 9:00 PM',
          Saturday: 'Hours not listed',
          Sunday: 'Hours not listed',
        },
      },
    ],
  }

  it('says a menu is posted and the hours are not listed, never Closed', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify(saturday)))
    const { container } = renderDining()

    // The header and the weekly hours card both carry the status line.
    expect(await screen.findAllByText('Menu posted · hours not listed')).toHaveLength(2)
    expect(container.querySelector('[data-dining-status]')).toHaveTextContent('Menu posted · hours not listed')
    expect(screen.getByText('Today: Hours not listed · Menus: breakfast, lunch, dinner')).toBeInTheDocument()
    expect(screen.queryByText(/Closed/)).toBeNull()
    expect(screen.getAllByText('Not listed')).toHaveLength(2)
    expect(container.querySelector('.status-closed')).toBeNull()
    expect(container.querySelectorAll('.status-unknown').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Official hours at IU Indy Eats' })).toHaveAttribute(
      'href',
      'https://dineoncampus.com/iuindy/hours-of-operation',
    )
    expect(screen.getByText('Veggie Burger')).toBeInTheDocument()
  })
})

// Issue #466: one tab per meal, opening on the meal being served on campus
// time, with the day's specials first and the every-day stations collapsed.
describe('meal tabs', () => {
  const tower = snapshot.locations[0]
  const grill = { name: 'Daily Grill', everyday: true, items: [{ name: 'Cheeseburger', calories: 300, icons: [] }] }
  const withMenus = (menus: unknown[]) => ({ ...snapshot, date: '2026-10-14', weekday: 'Wednesday', locations: [{ ...tower, menus }] })
  const week = withMenus([
    { meal: 'breakfast', stations: [{ name: 'Breakfast Entree Line', everyday: false, items: [{ name: 'Pancakes', calories: 200, icons: [] }] }] },
    { meal: 'lunch', stations: [grill, { name: 'Chef Made Soups', everyday: false, items: [{ name: 'Chicken Miso Soup', calories: 90, icons: [] }] }] },
    { meal: 'dinner', stations: [grill, { name: 'Homestyle', everyday: false, items: [{ name: 'Beef Stroganoff', calories: 450, icons: [] }] }] },
  ])
  const serve = (body: unknown) => vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify(body)))
  const campusTime = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on the meal being served, specials first, every-day stations collapsed', async () => {
    campusTime('2026-10-14T12:30:00-04:00')
    serve(week)
    renderDining()

    expect(await screen.findByRole('button', { name: 'Lunch' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Breakfast' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Chicken Miso Soup')).toBeVisible()
    expect(screen.getByText("Today's specials")).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: /^Every day/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Cheeseburger')).not.toBeVisible()
    fireEvent.click(toggle)
    expect(screen.getByText('Cheeseburger')).toBeVisible()

    // Another meal: its own specials, and the every-day group collapsed again.
    fireEvent.click(screen.getByRole('button', { name: 'Dinner' }))
    expect(screen.getByRole('button', { name: 'Dinner' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Beef Stroganoff')).toBeVisible()
    expect(screen.queryByText('Chicken Miso Soup')).toBeNull()
    expect(screen.getByRole('button', { name: /^Every day/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens on breakfast in the morning and dinner in the evening, by the campus clock', async () => {
    campusTime('2026-10-14T08:00:00-04:00')
    serve(week)
    const { unmount } = renderDining()
    expect(await screen.findByRole('button', { name: 'Breakfast' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Pancakes')).toBeVisible()
    unmount()

    // 9 AM in Seoul is 8 PM on campus.
    campusTime('2026-10-15T09:00:00+09:00')
    renderDining()
    expect(await screen.findByRole('button', { name: 'Dinner' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows every-day stations open when a meal has nothing else, like a weekend breakfast', async () => {
    campusTime('2026-10-17T09:00:00-04:00')
    serve(withMenus([{ meal: 'breakfast', stations: [{ name: 'Grill Breakfast Options', everyday: true, items: [{ name: 'Scrambled Eggs', calories: 150, icons: [] }] }] }]))
    renderDining()
    expect(await screen.findByRole('button', { name: /^Every day/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Scrambled Eggs')).toBeVisible()
    expect(screen.queryByText("Today's specials")).toBeNull()
  })

  it('a snapshot from before per-meal menus shows its merged list with no tabs', async () => {
    serve(snapshot)
    renderDining()
    expect(await screen.findByText('Veggie Burger')).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Meal' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Every day/ })).toBeNull()
  })
})

// Share links (docs/share-links.md): the hall and meal were component state,
// so a link to the page always opened on Tower Dining and the meal being
// served. They now live in the address, and the Share button sends both.
describe('the hall and meal in the address', () => {
  const tower = {
    ...snapshot.locations[0],
    menus: [
      { meal: 'breakfast', stations: [{ name: 'Breakfast Entree Line', everyday: false, items: [{ name: 'Pancakes', calories: 200, icons: [] }] }] },
      { meal: 'lunch', stations: [{ name: 'Chef Made Soups', everyday: false, items: [{ name: 'Chicken Miso Soup', calories: 90, icons: [] }] }] },
      { meal: 'dinner', stations: [{ name: 'Homestyle', everyday: false, items: [{ name: 'Beef Stroganoff', calories: 450, icons: [] }] }] },
    ],
  }
  const campusCenter = {
    ...snapshot.locations[0],
    id: 'campus-center',
    slug: 'campus-center',
    name: 'Campus Center',
    kind: 'retail',
    menusPublished: false,
    menus: [],
    stations: [],
    menu_source: null,
  }
  const writeText = vi.fn(async (_text: string) => {})

  beforeEach(() => {
    // 12:30 PM on campus: lunch.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-14T12:30:00-04:00'))
    vi.mocked(globalThis.fetch).mockImplementation(
      async () => new Response(JSON.stringify({ ...snapshot, date: '2026-10-14', locations: [tower, campusCenter] })),
    )
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.mocked(track).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('opens on the hall and meal a shared link names, signed out too', async () => {
    auth.value = { loading: false, user: null }
    renderDining('/dining?hall=tower-dining&meal=dinner&ref=share-dining')

    expect(await screen.findByRole('button', { name: 'Dinner' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Beef Stroganoff')).toBeVisible()
    expect(screen.queryByText('Chicken Miso Soup')).toBeNull()
  })

  it('opens on another hall a shared link names', async () => {
    renderDining('/dining?hall=campus-center')
    expect(await screen.findByRole('button', { name: 'Campus Center' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Tower Dining' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('region', { name: 'Campus Center vendors' })).toBeInTheDocument()
  })

  it('falls back to Tower Dining and the meal being served for a hall or meal not on the feed', async () => {
    renderDining('/dining?hall=gone-dining&meal=late-night')
    expect(await screen.findByRole('button', { name: 'Lunch' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Tower Dining' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('leaves a plain /dining as it is until a student picks', async () => {
    renderDining()
    expect(await screen.findByRole('button', { name: 'Lunch' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/dining$/)
  })

  it('a pill writes the hall and meal in place and keeps the ref, and the meal picked survives a look at another hall', async () => {
    renderDining('/dining?ref=share-dining')
    const where = screen.getByTestId('where')

    fireEvent.click(await screen.findByRole('button', { name: 'Dinner' }))
    expect(where).toHaveTextContent(/^\/dining\?ref=share-dining&hall=tower-dining&meal=dinner$/)
    expect(where).toHaveAttribute('data-navigation', 'REPLACE')
    expect(screen.getByText('Beef Stroganoff')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Campus Center' }))
    expect(where).toHaveTextContent(/^\/dining\?ref=share-dining&hall=campus-center&meal=dinner$/)
    expect(screen.getByRole('region', { name: 'Campus Center vendors' })).toBeInTheDocument()

    // Back on Tower, still on the dinner picked there.
    fireEvent.click(screen.getByRole('button', { name: 'Tower Dining' }))
    expect(screen.getByRole('button', { name: 'Dinner' })).toHaveAttribute('aria-pressed', 'true')
    expect(where).toHaveAttribute('data-navigation', 'REPLACE')
  })

  it('shares the hall and meal on screen, before they are in the address too', async () => {
    renderDining()
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/dining?hall=tower-dining&meal=lunch&ref=share-dining`),
    )
    expect(track).toHaveBeenCalledWith('share_clicked', { page: 'dining' })
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument()
  })

  it('shares the hall picked, with no meal for a food court', async () => {
    renderDining('/dining?hall=campus-center&meal=dinner&utm_source=instagram')
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/dining?hall=campus-center&ref=share-dining`))
  })
})

// Issue #467: an always-visible link to the official menu for a dining hall,
// and a notice when the feed has gone stale.
describe('the official menu and a stale feed', () => {
  const tower = snapshot.locations[0]
  const serve = (body: unknown) => vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify(body)))

  it('links the official menu from a dining hall, not from a food court, and says nothing when the feed is fresh', async () => {
    serve({
      ...snapshot,
      locations: [
        { ...tower, menu_source: { last_updated: '2026-10-10T04:26:22Z', stale: false, reason: null } },
        { ...tower, id: 'campus-center', slug: 'campus-center', name: 'Campus Center', kind: 'retail', stations: [], menu_source: null },
      ],
    })
    renderDining()
    const link = await screen.findByRole('link', { name: 'Official menu' })
    expect(link).toHaveAttribute('href', 'https://dineoncampus.com/iuindy/whats-on-the-menu')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Campus Center' }))
    expect(screen.queryByRole('link', { name: 'Official menu' })).toBeNull()
  })

  it('says when the feed has not been updated, and links the official menu there too', async () => {
    serve({ ...snapshot, locations: [{ ...tower, menu_source: { last_updated: '2026-09-12T06:49:29Z', stale: true, reason: 'not_updated' } }] })
    renderDining()
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('The campus menu feed has not been updated since Sep 12, so this menu may be out of date.')
    expect(within(notice).getByRole('link', { name: 'Official menu at IU Indy Eats' })).toHaveAttribute(
      'href',
      'https://dineoncampus.com/iuindy/whats-on-the-menu',
    )
    // The menu it has still shows.
    expect(screen.getByText('Veggie Burger')).toBeInTheDocument()
  })
})

// Issue #468: diet filters from the feed's labels, with the allergen caveat
// always beside them, and a dish that opens its details.
describe('diet filters and dish details', () => {
  const tower = snapshot.locations[0]
  const lunch = {
    ...snapshot,
    locations: [
      {
        ...tower,
        menus: [
          {
            meal: 'lunch',
            stations: [
              {
                name: 'Daily Grill',
                everyday: false,
                items: [
                  { id: 11, name: 'Veggie Burger', calories: 160, icons: ['Vegetarian'] },
                  { id: 12, name: 'Black Bean Burger', calories: 210, icons: ['Vegan', 'Vegetarian'], protein: 9, thumb: 'https://images.example.test/bean.220x0.jpg' },
                  { id: 13, name: 'Cheeseburger', calories: 300, icons: [] },
                ],
              },
              { name: 'Chef Made Soups', everyday: false, items: [{ id: 21, name: 'Chicken Miso Soup', calories: 90, icons: [] }] },
            ],
          },
        ],
      },
    ],
  }
  const detail = {
    ok: true,
    date: '2026-09-09',
    food: { id: 12, name: 'Black Bean Burger', description: null, image: null, thumb: null, serving: '1 each', ingredients: 'Black Bean Patty^', icons: ['Vegan'], nutrition: { calories: 210, g_protein: 9 } },
  }

  beforeEach(() => {
    localStorage.clear()
    vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
      String(input).startsWith('/api/dining/foods/') ? new Response(JSON.stringify(detail)) : new Response(JSON.stringify(lunch)),
    )
  })

  it('filters the meal by a label, says labels are not allergen information, and remembers the choice', async () => {
    renderDining()
    await screen.findByText('Cheeseburger')
    expect(screen.getByText(/They are not allergen information: the feed lists no allergens/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Vegetarian' }))
    expect(screen.getByRole('button', { name: 'Vegetarian' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Veggie Burger')).toBeInTheDocument()
    expect(screen.getByText('Black Bean Burger')).toBeInTheDocument()
    expect(screen.queryByText('Cheeseburger')).toBeNull()
    // The soup station has nothing left and is hidden.
    expect(screen.queryByText('Chef Made Soups')).toBeNull()
    expect(JSON.parse(localStorage.getItem('boilerindy-dining-diet-filters-v1') || '[]')).toEqual(['Vegetarian'])

    fireEvent.click(screen.getByRole('button', { name: 'Avoiding Gluten' }))
    expect(screen.getByText('Nothing on this menu is labelled Vegetarian and Avoiding Gluten.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByText('Cheeseburger')).toBeInTheDocument()
    expect(localStorage.getItem('boilerindy-dining-diet-filters-v1')).toBe('[]')
  })

  it('applies the filters saved on this device', async () => {
    localStorage.setItem('boilerindy-dining-diet-filters-v1', '["Vegan"]')
    renderDining()
    expect(await screen.findByText('Black Bean Burger')).toBeInTheDocument()
    expect(screen.queryByText('Veggie Burger')).toBeNull()
    expect(screen.getByRole('button', { name: 'Vegan' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('a dish opens its details, loaded for the snapshot\'s date', async () => {
    renderDining()
    fireEvent.click(await screen.findByRole('button', { name: 'Black Bean Burger' }))
    const dialog = screen.getByRole('dialog', { name: 'Black Bean Burger' })
    expect(await within(dialog).findByText('Black Bean Patty^')).toBeInTheDocument()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/dining/foods/12?date=2026-09-09', expect.anything())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Black Bean Burger' })).toHaveFocus()
  })
})

// Issue #469: today's headliners for the meal on screen, and the favorites
// coming up for a signed-in student.
describe('headliners and favorites coming up', () => {
  const tower = snapshot.locations[0]
  const today = {
    ...snapshot,
    date: '2026-10-14',
    weekday: 'Wednesday',
    locations: [
      {
        ...tower,
        menus: [
          {
            meal: 'lunch',
            stations: [{ name: 'Homestyle', everyday: false, items: [{ id: 31, name: 'Honey Garlic Fried Chicken', calories: 326, icons: [] }] }],
          },
        ],
      },
    ],
  }
  const upcoming = {
    ok: true,
    today: '2026-10-14',
    days: [
      {
        date: '2026-10-14',
        tentative: false,
        holiday: null,
        meals: [
          {
            meal: 'lunch',
            location: 'Tower Dining',
            headliners: [
              { name: 'Honey Garlic Fried Chicken', image: 'https://images.example.test/chicken.1024x0.jpg' },
              { name: 'Fried Cauliflower', image: null },
            ],
            specials: [],
          },
        ],
      },
      { date: '2026-10-15', tentative: false, holiday: null, meals: [{ meal: 'dinner', location: 'Tower Dining', headliners: [{ name: 'Veggie Burger', image: null }], specials: [] }] },
    ],
  }

  beforeEach(() => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/dining/upcoming')) return new Response(JSON.stringify(upcoming))
      if (url.startsWith('/api/dining/foods/')) return new Response(JSON.stringify({ ok: true, date: '2026-10-14', food: { id: 31, name: 'Honey Garlic Fried Chicken', nutrition: {}, icons: [] } }))
      return new Response(JSON.stringify(today))
    })
  })

  it('shows today\'s headliners for the meal, and one on the menu opens its details', async () => {
    renderDining()
    const strip = await screen.findByRole('region', { name: "Today's headliners" })
    expect(within(strip).getByText('Fried Cauliflower')).toBeInTheDocument()
    expect(strip.querySelector('img')).toHaveAttribute('src', 'https://images.example.test/chicken.1024x0.jpg')
    // Fried Cauliflower is not on this menu, so it is not a button.
    expect(within(strip).queryByRole('button', { name: 'Fried Cauliflower' })).toBeNull()
    fireEvent.click(within(strip).getByRole('button', { name: 'Honey Garlic Fried Chicken' }))
    expect(screen.getByRole('dialog', { name: 'Honey Garlic Fried Chicken' })).toBeInTheDocument()
  })

  it('lists a starred dish that is coming back', async () => {
    savedFavorites = ['veggie burger']
    renderDining()
    const card = await screen.findByText('Favorites coming up')
    const section = card.closest('[data-dining-coming-up]') as HTMLElement
    expect(within(section).getByText('Veggie Burger is back tomorrow')).toBeInTheDocument()
    expect(within(section).getByText('Dinner, Tower Dining')).toBeInTheDocument()
  })

  it('shows neither to a signed-out visitor\'s favorites, which do not exist, but keeps the headliners', async () => {
    auth.value = { loading: false, user: null }
    renderDining()
    expect(await screen.findByRole('region', { name: "Today's headliners" })).toBeInTheDocument()
    expect(screen.queryByText('Favorites coming up')).toBeNull()
  })
})

// Issue #477: the Campus Center posts no menu, so its food court vendors stand
// in for one, with Dine On Campus linked for their hours.
describe('the Campus Center vendors', () => {
  const tower = snapshot.locations[0]
  const campusCenter = {
    ...tower,
    id: 'campus-center',
    slug: 'campus-center',
    name: 'Campus Center',
    kind: 'retail',
    meal: 'Retail dining, no posted menu',
    menusPublished: false,
    menus: [],
    stations: [],
    menu_source: null,
  }

  it('lists the food court vendors by floor and links their hours, while Tower keeps its menu', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ ...snapshot, locations: [tower, campusCenter] })))
    renderDining()
    expect(await screen.findByText('Veggie Burger')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Campus Center vendors' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Campus Center' }))
    const vendors = screen.getByRole('region', { name: 'Campus Center vendors' })
    expect(within(vendors).getByRole('heading', { name: 'Level 1, Citizens Commons' })).toBeInTheDocument()
    expect(within(vendors).getByText('Chick-fil-A')).toBeInTheDocument()
    expect(within(vendors).getByText('The Daily Bagel')).toBeInTheDocument()
    expect(within(vendors).getByRole('link', { name: 'Hours for each vendor' })).toHaveAttribute('href', 'https://dineoncampus.com/iuindy/hours-of-operation')
    expect(screen.queryByText('No menu posted for today')).toBeNull()
    expect(screen.queryByText('Veggie Burger')).toBeNull()
  })
})
