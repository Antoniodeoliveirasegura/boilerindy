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
