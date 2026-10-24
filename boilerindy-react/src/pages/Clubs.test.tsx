import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Clubs from './Clubs'
import { authRequest } from '../lib/authApi'
import type { Club } from '../lib/clubs'

// Issue #16: following a club from /clubs. A signed-in student gets a Follow
// toggle on every card once their follows have loaded, and a Following view of
// the clubs they follow. The directory is the mocked GET /api/clubs; the
// follows go through authRequest, as on the real page.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
const auth = vi.hoisted(() => ({ value: { user: { id: 'user-1' } as { id: string } | null, loading: false } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.value }))

function club(id: string, name: string, overrides: Partial<Club> = {}): Club {
  return {
    id,
    name,
    shortName: null,
    slug: `club${id}`,
    url: `https://boilerlink.purdue.edu/organization/club${id}`,
    imageUrl: null,
    blurb: `${name} meets every week.`,
    categories: ['Hobby'],
    indianapolis: true,
    ...overrides,
  }
}

const CHESS = club('404807', 'Chess Club Purdue Indianapolis')
const TAEKWONDO = club('401442', 'Taekwondo Club of Purdue Indianapolis', { categories: ['Club Sports'] })
const USB = club('420522', 'USB Indy', { categories: ['Service'] })
const DIRECTORY = [CHESS, TAEKWONDO, USB]

function searchResult(clubs: Club[]) {
  return {
    ok: true,
    source: 'boilerlink-organizations',
    sourceUrl: 'https://boilerlink.purdue.edu/api/discovery/search/organizations',
    fetchedAt: new Date().toISOString(),
    stale: false,
    directoryTotal: clubs.length,
    indianapolisTotal: clubs.length,
    q: '',
    category: '',
    scope: 'indianapolis',
    page: 1,
    pageSize: 24,
    pages: 1,
    total: clubs.length,
    clubs,
    categories: [
      { name: 'Club Sports', count: 1, indianapolisCount: 1 },
      { name: 'Hobby', count: 1, indianapolisCount: 1 },
      { name: 'Service', count: 1, indianapolisCount: 1 },
    ],
  }
}

// What the server holds for the student, and what each follow route answers.
let followed: string[]
let followsAnswer: (() => unknown) | null
let writeAnswer: ((method: string, key: string) => unknown) | null
const followsBody = () => ({
  follows: followed,
  clubs: DIRECTORY.filter((c) => followed.includes(`boilerlink:${c.id}`)).map((c) => ({ ...c, organizationKey: `boilerlink:${c.id}` })),
})

beforeEach(() => {
  auth.value = { user: { id: 'user-1' }, loading: false }
  followed = ['boilerlink:401442']
  followsAnswer = null
  writeAnswer = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url)
      if (path.startsWith('/api/clubs')) return new Response(JSON.stringify(searchResult(DIRECTORY)), { status: 200 })
      if (path === '/api/campus-news') return new Response(JSON.stringify({ ok: true, posts: [] }), { status: 200 })
      throw new Error(`unexpected fetch of ${path}`)
    }),
  )
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      const url = String(path)
      if (url === '/api/me/club-follows') return followsAnswer ? followsAnswer() : followsBody()
      const match = /^\/api\/me\/club-follows\/(.+)$/.exec(url)
      if (match) {
        const key = decodeURIComponent(match[1])
        const method = String(options?.method)
        if (writeAnswer) return writeAnswer(method, key)
        followed = method === 'PUT' ? [...new Set([...followed, key])] : followed.filter((k) => k !== key)
        return { ok: true, organizationKey: key, following: method === 'PUT' }
      }
      throw new Error(`unexpected request to ${url}`)
    })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderPage(path = '/clubs') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]} useTransitions={false}>
        <Clubs />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const card = (c: Club) => document.querySelector(`[data-club-id="${c.id}"]`) as HTMLElement
const toggleOf = (c: Club) => within(card(c)).getByRole('button', { name: new RegExp(`^Follow(ing)? ${c.name}$`) })
const writes = () =>
  vi
    .mocked(authRequest)
    .mock.calls.filter(([, options]) => options?.method)
    .map(([url, options]) => `${options?.method} ${String(url)}`)

describe('the Follow toggle', () => {
  it('shows each club as followed or not, from the account, once the follows have loaded', async () => {
    renderPage()
    await waitFor(() => expect(toggleOf(TAEKWONDO)).toHaveAttribute('aria-pressed', 'true'))
    expect(toggleOf(TAEKWONDO)).toHaveTextContent('Following')
    expect(toggleOf(CHESS)).toHaveAttribute('aria-pressed', 'false')
    expect(toggleOf(CHESS)).toHaveTextContent('Follow')
    expect(vi.mocked(authRequest)).toHaveBeenCalledWith('/api/me/club-follows', expect.objectContaining({ signal: expect.anything() }))
  })

  it('follows with PUT and unfollows with DELETE, the key encoded, flipping before the server answers', async () => {
    // The server holds each write until the test lets it through.
    let release: () => void = () => {}
    writeAnswer = (method, key) =>
      new Promise((resolve) => {
        release = () => {
          followed = method === 'PUT' ? [...new Set([...followed, key])] : followed.filter((k) => k !== key)
          resolve({ ok: true, organizationKey: key, following: method === 'PUT' })
        }
      })
    renderPage()
    await waitFor(() => expect(toggleOf(CHESS)).toHaveAttribute('aria-pressed', 'false'))

    fireEvent.click(toggleOf(CHESS))
    await waitFor(() => expect(toggleOf(CHESS)).toHaveAttribute('aria-pressed', 'true'))
    expect(toggleOf(CHESS)).toBeDisabled() // until the server answers
    expect(screen.getByRole('button', { name: 'Following (2)' })).toBeInTheDocument()
    expect(writes()).toEqual(['PUT /api/me/club-follows/boilerlink%3A404807'])
    release()
    await waitFor(() => expect(toggleOf(CHESS)).not.toBeDisabled())
    expect(toggleOf(CHESS)).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggleOf(TAEKWONDO))
    await waitFor(() => expect(toggleOf(TAEKWONDO)).toHaveAttribute('aria-pressed', 'false'))
    expect(writes()).toContain('DELETE /api/me/club-follows/boilerlink%3A401442')
    release()
    await waitFor(() => expect(toggleOf(TAEKWONDO)).not.toBeDisabled())
    expect(followed).toEqual(['boilerlink:404807'])
    expect(screen.getByRole('button', { name: 'Following (1)' })).toBeInTheDocument()
  })

  it('a refused follow flips back and says why, in the server\'s words', async () => {
    writeAnswer = () => {
      throw Object.assign(new Error('You can follow up to 100 clubs. Unfollow some to follow more.'), {
        status: 409,
        code: 'club_follows_limit',
        payload: { error: { message: 'You can follow up to 100 clubs. Unfollow some to follow more.', code: 'club_follows_limit', status: 409 } },
      })
    }
    renderPage()
    await waitFor(() => expect(toggleOf(CHESS)).toHaveAttribute('aria-pressed', 'false'))
    fireEvent.click(toggleOf(CHESS))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not follow Chess Club Purdue Indianapolis. You can follow up to 100 clubs. Unfollow some to follow more.',
    )
    await waitFor(() => expect(toggleOf(CHESS)).toHaveAttribute('aria-pressed', 'false'))
  })

  it('shows no follow UI before the server has the follows table', async () => {
    followsAnswer = () => {
      throw Object.assign(new Error('Following clubs is not set up yet. Please try again later.'), { status: 503, code: 'club_follows_schema_missing' })
    }
    renderPage()
    await screen.findByText('3 organizations in Indianapolis')
    await waitFor(() => expect(vi.mocked(authRequest)).toHaveBeenCalledTimes(1))
    expect(within(card(CHESS)).queryByRole('button', { name: /Follow/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Following/ })).not.toBeInTheDocument()
    // Not set up is not a failure to report.
    expect(document.querySelector('[data-clubs-follows-failed]')).toBeNull()
  })

  it('shows no follow UI and asks for no follows signed out', async () => {
    auth.value = { user: null, loading: false }
    renderPage()
    await screen.findByText('3 organizations in Indianapolis')
    expect(within(card(CHESS)).queryByRole('button', { name: /Follow/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Following/ })).not.toBeInTheDocument()
    expect(authRequest).not.toHaveBeenCalled()
  })
})

describe('the Following view', () => {
  it('lists the clubs followed, filtered by the same search and category, and its empty states lead back', async () => {
    followed = ['boilerlink:401442', 'boilerlink:420522']
    renderPage('/clubs?following=1')
    expect(await screen.findByText('2 clubs you follow')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Following (2)' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Indianapolis (3)' })).toHaveAttribute('aria-pressed', 'false')
    const listed = () => [...document.querySelectorAll('[data-club-id]')].map((el) => el.getAttribute('data-club-id'))
    expect(listed()).toEqual(['401442', '420522'])

    // The category menu counts the followed clubs.
    const menu = screen.getByLabelText('Category') as HTMLSelectElement
    expect([...menu.options].map((option) => option.textContent)).toEqual(['All categories', 'Club Sports (1)', 'Service (1)'])
    fireEvent.change(menu, { target: { value: 'Service' } })
    expect(await screen.findByText('1 match in Service among the clubs you follow')).toBeInTheDocument()
    expect(listed()).toEqual(['420522'])

    fireEvent.change(menu, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Search organizations'), { target: { value: 'robotics' } })
    expect(await screen.findByText('None of the clubs you follow match "robotics".', {}, { timeout: 2000 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(listed()).toEqual(['401442', '420522']))

    // Unfollowing from the view takes the club off it.
    fireEvent.click(toggleOf(USB))
    await waitFor(() => expect(listed()).toEqual(['401442']))
  })

  it('with nothing followed, says how following works and leads back to the directory', async () => {
    followed = []
    renderPage('/clubs?following=1')
    expect(await screen.findByText(/You do not follow any clubs yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Browse clubs' }))
    expect(await screen.findByText('3 organizations in Indianapolis')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Indianapolis (3)' })).toHaveAttribute('aria-pressed', 'true')
  })
})
