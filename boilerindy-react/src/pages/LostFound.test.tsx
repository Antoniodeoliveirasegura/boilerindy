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

// Each post is one row of the list (the list itself is the card).
function card(title: string) {
  return within(screen.getByText(title).closest('li') as HTMLElement)
}

// Issue #527 - the contact line shows on the report card for every signed-in
// student, and the form never said so.
describe('Lost & Found contact field', () => {
  it('says who sees it, tied to the field', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Post an item'))
    expect(screen.getByLabelText('How to reach you (optional)')).toHaveAccessibleDescription('Shown to every signed-in student on your report.')
  })
})

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

describe('Lost & Found errors', () => {
  const POLICY = 'Please keep the campus board respectful - remove profanity or slurs and try again.'

  function failWith(message: string, status: number) {
    return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
  }

  it('shows a rejected post\'s reason in the composer, next to Post item, and keeps the title', async () => {
    vi.mocked(authRequest).mockImplementation(async (path, options) => {
      if (options?.method === 'POST') throw failWith(POLICY, 400)
      if (path === '/api/lost-found') return { items }
      throw new Error(`unexpected ${path}`)
    })
    renderPage()
    await screen.findByText('Blue water bottle')
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Lost my backpack' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post item' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(POLICY)
    // In the form the student just used, not the page header far above it on a phone.
    const composer = screen.getByRole('button', { name: 'Post item' }).closest('form') as HTMLElement
    expect(composer).toContainElement(alert)
    expect(screen.getByLabelText('Title')).toHaveValue('Lost my backpack')
  })

  it('shows a failed Mark resolved in the row that failed', async () => {
    vi.mocked(authRequest).mockImplementation(async (path, options) => {
      if (options?.method === 'PATCH') throw failWith('Could not update the post.', 500)
      if (path === '/api/lost-found') return { items }
      throw new Error(`unexpected ${path}`)
    })
    renderPage()
    await screen.findByText('Black backpack')
    fireEvent.click(card('Black backpack').getByRole('button', { name: 'Mark resolved' }))

    expect(await card('Black backpack').findByRole('alert')).toHaveTextContent('Could not update the post.')
    expect(card('Blue water bottle').queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says a failed load failed, instead of an empty board, and Try again reads the list again', async () => {
    let fail = true
    vi.mocked(authRequest).mockImplementation(async (path) => {
      if (path !== '/api/lost-found') throw new Error(`unexpected ${path}`)
      if (fail) throw failWith('Internal server error.', 500)
      return { items }
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Lost & Found posts.')
    expect(screen.queryByText('Be the first to post a lost or found item.')).not.toBeInTheDocument()

    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Blue water bottle')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    quiet.mockRestore()
  })

  it('tells students the board is unavailable, without the SQL setup step, and holds the composer', async () => {
    vi.mocked(authRequest).mockImplementation(async (path) => {
      if (path === '/api/lost-found') return { items: [], unavailable: true }
      throw new Error(`unexpected ${path}`)
    })
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Lost & Found is temporarily unavailable. Try again in a few minutes.')
    expect(screen.queryByText(/supabase-lost-found\.sql/)).not.toBeInTheDocument()
    expect(screen.queryByText('Be the first to post a lost or found item.')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Keys' } })
    expect(screen.getByRole('button', { name: 'Post item' })).toBeDisabled()
  })

  it('stops each field at the length the server keeps', async () => {
    renderPage()
    await screen.findByText('Blue water bottle')
    expect(screen.getByLabelText('Title')).toHaveAttribute('maxlength', '200')
    expect(screen.getByLabelText('Location (optional)')).toHaveAttribute('maxlength', '200')
    expect(screen.getByLabelText('How to reach you (optional)')).toHaveAttribute('maxlength', '200')
    expect(screen.getByLabelText('Description (optional)')).toHaveAttribute('maxlength', '2000')
  })
})
