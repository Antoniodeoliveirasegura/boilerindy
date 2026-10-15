import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Friends from './Friends'
import { authRequest } from '../lib/authApi'

// Issue #192 on friend matching: "Report user" on match cards and connection
// rows, and "Block" there and on incoming requests, by the user id the page
// already holds. A block ends any connection or request between the two, so
// both lists are read again.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

let matches: { userId: string; displayName: string; sharedCount: number }[]

beforeEach(() => {
  matches = [{ userId: 'user-match', displayName: 'Jordan', sharedCount: 2 }]
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (options?.method === 'POST') return { ok: true }
      if (path === '/api/me/profile-card') return { bio: '', interests: [], discoverable: true }
      if (path === '/api/me/matches') return { matches }
      if (path === '/api/me/connections') {
        return {
          accepted: [{ userId: 'user-friend', displayName: 'Casey', email: 'casey@purdue.edu' }],
          incoming: [{ userId: 'user-asking', displayName: 'Morgan' }],
        }
      }
      throw new Error(`unexpected ${path}`)
    })
})

function renderFriends() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Friends />
    </QueryClientProvider>,
  )
}

function card(text: string) {
  return within(screen.getByText(text).closest('.card') as HTMLElement)
}

describe('Friends report and block', () => {
  it('offers Report user and Block on matches and connections, and Block on requests', async () => {
    renderFriends()
    await screen.findByText('Jordan')
    for (const name of ['Jordan', 'Casey']) {
      expect(card(name).getByRole('button', { name: 'Report user' })).toBeInTheDocument()
      expect(card(name).getByRole('button', { name: 'Block' })).toBeInTheDocument()
    }
    const request = card('Morgan wants to connect')
    expect(request.getByRole('button', { name: 'Block' })).toBeInTheDocument()
    expect(request.queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument()
  })

  it('reports a match as a user, named in the dialog', async () => {
    renderFriends()
    await screen.findByText('Jordan')
    fireEvent.click(card('Jordan').getByRole('button', { name: 'Report user' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Report Jordan' })).getByLabelText('Spam'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await screen.findByRole('status')
    const [, options] = vi.mocked(authRequest).mock.calls.find(([path]) => path === '/api/reports') ?? []
    expect(JSON.parse(String(options?.body))).toEqual({ targetType: 'user', targetId: 'user-match', reason: 'spam', details: '' })
  })

  it('blocks the sender of a request by id, then reads matches and connections again', async () => {
    renderFriends()
    await screen.findByText('Morgan wants to connect')
    fireEvent.click(card('Morgan wants to connect').getByRole('button', { name: 'Block' }))
    const prompt = await screen.findByRole('dialog', { name: 'Block Morgan?' })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Block' }))
    await waitFor(() => expect(authRequest).toHaveBeenCalledWith('/api/me/blocks/user-asking', { method: 'POST' }))
    await waitFor(() => expect(vi.mocked(authRequest).mock.calls.filter(([p]) => p === '/api/me/connections')).toHaveLength(2))
    expect(vi.mocked(authRequest).mock.calls.filter(([p]) => p === '/api/me/matches')).toHaveLength(2)
  })
})

describe('Friends profile and Connect feedback', () => {
  const LIMITED = 'You are posting too quickly. Please wait a moment and try again.'

  function failWith(message: string, status: number) {
    return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
  }

  // The default answers from beforeEach, with one path or method overridden.
  function answer(override: (path: string, method?: string) => unknown) {
    const fallback = vi.mocked(authRequest).getMockImplementation()
    vi.mocked(authRequest).mockImplementation(async (path, options) => {
      const result = override(path, options?.method)
      if (result instanceof Error) throw result
      if (result !== undefined) return result
      return fallback?.(path, options)
    })
  }

  it('keeps the profile form closed when it cannot load, so Save cannot overwrite the saved profile', async () => {
    let profileUp = false
    answer((path, method) => {
      if (path === '/api/me/profile-card' && !method) {
        return profileUp ? { bio: 'CompE junior', interests: ['robotics', 'coffee'], discoverable: true } : failWith('Service unavailable', 503)
      }
      return undefined
    })
    renderFriends()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your profile')
    expect(screen.getByLabelText('Short bio (optional)')).toBeDisabled()
    expect(screen.getByLabelText('Interests, comma-separated (e.g. chess, hiking)')).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Discoverable to classmates' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled()

    profileUp = true
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByLabelText('Short bio (optional)')).toHaveValue('CompE junior'))
    expect(screen.getByLabelText('Interests, comma-separated (e.g. chess, hiking)')).toHaveValue('robotics, coffee')
    expect(screen.getByRole('checkbox', { name: 'Discoverable to classmates' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(vi.mocked(authRequest).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  })

  it('says why a refused Connect put the classmate back', async () => {
    answer((path, method) => (path === '/api/connections' && method === 'POST' ? failWith(LIMITED, 429) : undefined))
    renderFriends()
    await screen.findByText('Jordan')
    fireEvent.click(card('Jordan').getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(LIMITED)
    expect(await screen.findByText('Jordan')).toBeInTheDocument()
  })

  it('confirms a sent request', async () => {
    renderFriends()
    await screen.findByText('Jordan')
    fireEvent.click(card('Jordan').getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Request sent to Jordan.')
    expect(screen.queryByText('Jordan')).not.toBeInTheDocument()
  })

  it('clears a match error once a later reload succeeds', async () => {
    let matchesUp = false
    answer((path, method) => {
      if (path === '/api/me/matches') return matchesUp ? undefined : failWith('Could not load matches. Please try again.', 500)
      if (path === '/api/me/profile-card' && method === 'PUT') return { ok: true }
      return undefined
    })
    renderFriends()
    expect(await screen.findByText('Could not load matches. Please try again.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled())

    matchesUp = true
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(await screen.findByText('Jordan')).toBeInTheDocument()
    expect(screen.queryByText('Could not load matches. Please try again.')).not.toBeInTheDocument()
  })
})
