import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Board from './Board'
import { authRequest } from '../lib/authApi'

// Issue #192 on the campus board: Report on every post and reply that is not
// the student's own, Block author only on a named one. Anonymous posts and
// replies are reported only (owner decision, 2026-09-27): the Blocked users
// list names everyone on it, so blocking an anonymous author would unmask them.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

const reply = (id: string, body: string, fields: { user: string; anon: boolean; isMine: boolean }) => ({
  id,
  body,
  time: '2026-09-27T10:00:00.000Z',
  ...fields,
})

const post = (id: string, title: string, fields: Record<string, unknown>) => ({
  id,
  title,
  body: '',
  time: '2026-09-27T09:00:00.000Z',
  upvotes: 0,
  tags: [],
  replies: [],
  replyCount: 0,
  ...fields,
})

let posts: ReturnType<typeof post>[]

beforeEach(() => {
  localStorage.clear()
  posts = [
    post('p-named', 'Where is the quiet floor?', {
      user: 'Riley',
      anon: false,
      isMine: false,
      replies: [
        reply('r-named', 'Third floor of the library', { user: 'Avery', anon: false, isMine: false }),
        reply('r-anon', 'Try the business school', { user: 'Anonymous', anon: true, isMine: false }),
        reply('r-mine', 'Thanks all', { user: 'Test Student', anon: false, isMine: true }),
      ],
      replyCount: 3,
    }),
    post('p-anon', 'Anyone else locked out?', { user: 'Anonymous', anon: true, isMine: false }),
    post('p-mine', 'Selling a lab coat', { user: 'Test Student', anon: false, isMine: true }),
  ]
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (String(path).startsWith('/api/board/posts?')) return { posts, page: 0, hasMore: false }
      if (options?.method === 'POST') return { ok: true }
      throw new Error(`unexpected ${path}`)
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Board />
    </QueryClientProvider>,
  )
}

/** The post's own action buttons, leaving out the ones on its replies. */
async function postActions(title: string) {
  const article = (await screen.findByText(title)).closest('article') as HTMLElement
  return within(article)
    .getAllByRole('button')
    .filter((b) => !b.closest('li'))
    .map((b) => b.textContent?.trim())
}

function replyActions(body: string) {
  const item = screen.getByText(body).closest('li') as HTMLElement
  return within(item).queryAllByRole('button').map((b) => b.textContent?.trim())
}

describe('Board report and block', () => {
  it('offers Report and Block author on a named post, Report alone on an anonymous one, and neither on your own', async () => {
    renderBoard()
    expect(await postActions('Where is the quiet floor?')).toEqual(expect.arrayContaining(['Report', 'Block author']))
    const anonymous = await postActions('Anyone else locked out?')
    expect(anonymous).toContain('Report')
    expect(anonymous).not.toContain('Block author')
    const mine = await postActions('Selling a lab coat')
    expect(mine).not.toContain('Report')
    expect(mine).not.toContain('Block author')
    expect(mine).toEqual(expect.arrayContaining(['Edit', 'Delete']))
  })

  it('applies the same rules to each reply', async () => {
    renderBoard()
    await screen.findByText('Third floor of the library')
    expect(replyActions('Third floor of the library')).toEqual(['Report', 'Block author'])
    expect(replyActions('Try the business school')).toEqual(['Report'])
    expect(replyActions('Thanks all')).toEqual([])
  })

  it('reports a reply through the dialog', async () => {
    renderBoard()
    await screen.findByText('Try the business school')
    const item = screen.getByText('Try the business school').closest('li') as HTMLElement
    fireEvent.click(within(item).getByRole('button', { name: 'Report' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Report this reply' })).getByLabelText('Harassment'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Thanks, our team will review it.')
    const [, options] = vi.mocked(authRequest).mock.calls.find(([path]) => path === '/api/reports') ?? []
    expect(JSON.parse(String(options?.body))).toEqual({ targetType: 'board_reply', targetId: 'r-anon', reason: 'harassment', details: '' })
  })

  it('blocks a post author after the prompt, then reads the board again', async () => {
    renderBoard()
    const article = (await screen.findByText('Where is the quiet floor?')).closest('article') as HTMLElement
    const block = within(article)
      .getAllByRole('button', { name: 'Block author' })
      .find((b) => !b.closest('li')) as HTMLElement
    posts = posts.filter((p) => p.id !== 'p-named')
    fireEvent.click(block)
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Block this author?' })).getByRole('button', { name: 'Block' }))
    await waitFor(() => expect(screen.queryByText('Where is the quiet floor?')).not.toBeInTheDocument())
    expect(authRequest).toHaveBeenCalledWith('/api/me/blocks/content/board_post/p-named', { method: 'POST' })
    expect(screen.getByRole('status')).toHaveTextContent('Blocked. You can unblock them in Settings.')
  })
})
