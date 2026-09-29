import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BlockedUsersCard from './BlockedUsersCard'
import { authRequest } from '../../lib/authApi'

// Issue #192: Settings lists everyone the student blocked, with Unblock for
// each, from GET /api/me/blocks; unblocking refetches the list.

vi.mock('../../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

let blocks: { userId: string; displayName: string; createdAt: string }[]

function refusal(status: number, message: string) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BlockedUsersCard />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  blocks = [
    { userId: 'user-2', displayName: 'Riley', createdAt: '2026-09-27T10:00:00.000Z' },
    { userId: 'user-3', displayName: 'Avery', createdAt: '2026-09-26T10:00:00.000Z' },
  ]
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (path === '/api/me/blocks') return { blocks }
      const unblock = /^\/api\/me\/blocks\/(.+)$/.exec(String(path))
      if (unblock && options?.method === 'DELETE') {
        blocks = blocks.filter((b) => b.userId !== unblock[1])
        return { ok: true }
      }
      throw new Error(`unexpected ${path}`)
    })
})

afterEach(cleanup)

describe('BlockedUsersCard', () => {
  it('lists the blocked users, newest first', async () => {
    renderCard()
    expect(await screen.findByText('Riley')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['RileyUnblock', 'AveryUnblock'])
  })

  it('says so when nobody is blocked', async () => {
    blocks = []
    renderCard()
    expect(await screen.findByText('You have not blocked anyone.')).toBeInTheDocument()
  })

  it('unblocks one person and shows the list the server now has', async () => {
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Unblock Riley' }))
    await waitFor(() => expect(screen.queryByText('Riley')).not.toBeInTheDocument())
    expect(authRequest).toHaveBeenCalledWith('/api/me/blocks/user-2', { method: 'DELETE' })
    expect(screen.getByRole('button', { name: 'Unblock Avery' })).toBeEnabled()
  })

  it('keeps the row and shows the server message when unblocking is refused', async () => {
    const answer = vi.mocked(authRequest).getMockImplementation()
    vi.mocked(authRequest).mockImplementation(async (path, options) => {
      if (options?.method === 'DELETE') throw refusal(429, 'Too many changes. Please wait a moment.')
      return answer?.(path, options)
    })
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Unblock Riley' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many changes. Please wait a moment.')
    expect(screen.getByText('Riley')).toBeInTheDocument()
  })

  it('says the list could not be loaded when the read fails', async () => {
    vi.mocked(authRequest).mockRejectedValue(refusal(503, 'Blocked users are not set up yet.'))
    renderCard()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your blocked users.')
  })
})
