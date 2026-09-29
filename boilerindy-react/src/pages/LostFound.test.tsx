import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LostFound from './LostFound'
import { authRequest } from '../lib/authApi'

// Issue #192 on Lost & Found: someone else's post can be reported or its
// author blocked; your own keeps Mark resolved and Delete.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))

let items: { id: string; type: string; title: string; status: string; isOwner: boolean }[]

beforeEach(() => {
  items = [
    { id: 'item-theirs', type: 'found', title: 'Blue water bottle', status: 'open', isOwner: false },
    { id: 'item-mine', type: 'lost', title: 'Black backpack', status: 'open', isOwner: true },
  ]
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (options?.method === 'POST') return { ok: true }
      if (path === '/api/lost-found') return { items }
      throw new Error(`unexpected ${path}`)
    })
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <LostFound />
    </QueryClientProvider>,
  )
}

function card(title: string) {
  return within(screen.getByText(title).closest('.card') as HTMLElement)
}

describe('Lost & Found report and block', () => {
  it('offers Report and Block author on someone else\'s post only', async () => {
    renderPage()
    await screen.findByText('Blue water bottle')
    expect(card('Blue water bottle').getByRole('button', { name: 'Report' })).toBeInTheDocument()
    expect(card('Blue water bottle').getByRole('button', { name: 'Block author' })).toBeInTheDocument()
    expect(card('Black backpack').getByRole('button', { name: 'Mark resolved' })).toBeInTheDocument()
    expect(card('Black backpack').queryByRole('button', { name: 'Report' })).not.toBeInTheDocument()
    expect(card('Black backpack').queryByRole('button', { name: 'Block author' })).not.toBeInTheDocument()
  })

  it('reports a post through the dialog', async () => {
    renderPage()
    await screen.findByText('Blue water bottle')
    fireEvent.click(card('Blue water bottle').getByRole('button', { name: 'Report' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Report this post' })).getByLabelText('Scam or fraud'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await screen.findByRole('status')
    const [, options] = vi.mocked(authRequest).mock.calls.find(([path]) => path === '/api/reports') ?? []
    expect(JSON.parse(String(options?.body))).toMatchObject({ targetType: 'lost_found', targetId: 'item-theirs', reason: 'scam' })
  })

  it('blocks the author, then reads the list again', async () => {
    renderPage()
    await screen.findByText('Blue water bottle')
    items = items.filter((i) => i.id !== 'item-theirs')
    fireEvent.click(card('Blue water bottle').getByRole('button', { name: 'Block author' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Block this author?' })).getByRole('button', { name: 'Block' }))
    await waitFor(() => expect(screen.queryByText('Blue water bottle')).not.toBeInTheDocument())
    expect(authRequest).toHaveBeenCalledWith('/api/me/blocks/content/lost_found/item-theirs', { method: 'POST' })
  })
})
