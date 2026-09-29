import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Guide from './Guide'
import { authRequest } from '../lib/authApi'

// Issue #192 on the Neighborhood Guide: every card has its action row now,
// with Report and Block author on someone else's tip and Delete on your own.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', isAdmin: false } }) }))
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false }) }))

let recommendations: { id: string; title: string; category: string; upvotes: number; isMine: boolean }[]

beforeEach(() => {
  recommendations = [
    { id: 'rec-theirs', title: 'Greyhouse Coffee', category: 'food', upvotes: 4, isMine: false },
    { id: 'rec-mine', title: 'Quiet corner in the library', category: 'study', upvotes: 1, isMine: true },
  ]
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (options?.method === 'POST') return { ok: true }
      if (String(path).startsWith('/api/guide')) return { recommendations }
      throw new Error(`unexpected ${path}`)
    })
})

function renderGuide() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Guide />
    </QueryClientProvider>,
  )
}

function card(title: string) {
  return within(screen.getByText(title).closest('.card') as HTMLElement)
}

describe('Guide report and block', () => {
  it('offers Report and Block author on someone else\'s tip, and Delete alone on your own', async () => {
    renderGuide()
    await screen.findByText('Greyhouse Coffee')
    expect(card('Greyhouse Coffee').getByRole('button', { name: 'Report' })).toBeInTheDocument()
    expect(card('Greyhouse Coffee').getByRole('button', { name: 'Block author' })).toBeInTheDocument()
    expect(card('Greyhouse Coffee').queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(card('Quiet corner in the library').getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(card('Quiet corner in the library').queryByRole('button', { name: 'Report' })).not.toBeInTheDocument()
  })

  it('blocks the author of a tip, then reads the guide again', async () => {
    renderGuide()
    await screen.findByText('Greyhouse Coffee')
    recommendations = recommendations.filter((r) => r.id !== 'rec-theirs')
    fireEvent.click(card('Greyhouse Coffee').getByRole('button', { name: 'Block author' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Block this author?' })).getByRole('button', { name: 'Block' }))
    await waitFor(() => expect(screen.queryByText('Greyhouse Coffee')).not.toBeInTheDocument())
    expect(authRequest).toHaveBeenCalledWith('/api/me/blocks/content/guide/rec-theirs', { method: 'POST' })
  })
})
