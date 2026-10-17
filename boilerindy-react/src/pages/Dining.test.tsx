import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Dining from './Dining'
import { authRequest } from '../lib/authApi'

// Issue #202: starring a dish past the 300-favorite cap (409) or the
// user-write limiter (429) rolled the star back with no word of why. The
// rollback stays (favorites have no device-only copy) and the page now says
// what happened: the server's message for a refusal, a generic line otherwise.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

// The page reads the session from useAuth (issue #366), which throws outside
// AuthProvider; each test sets the state it needs, signed in by default.
type AuthState = { loading: boolean; user: null | { id: string } }
const SIGNED_IN: AuthState = { loading: false, user: { id: 'user-1' } }
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

// The page reads the menu through the query cache (issue #251); each test
// gets its own client so nothing leaks between cases.
function renderDining() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <Dining />
    </QueryClientProvider>,
  )
  return {
    ...view,
    /** Re-render after changing auth.value, as a session change would. */
    rerenderDining: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Dining />
        </QueryClientProvider>,
      ),
  }
}

async function star() {
  return screen.findByRole('button', { name: /Veggie Burger/ })
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
