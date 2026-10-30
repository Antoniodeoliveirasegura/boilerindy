import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Board from './Board'
import { authRequest } from '../lib/authApi'

// Issue #192 on the campus board: Report on every post and reply that is not
// the student's own, Block author only on a named one. Anonymous posts and
// replies are reported only (owner decision, 2026-09-27): the Blocked users
// list names everyone on it, so blocking an anonymous author would unmask them.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
// AI suggestions on, so the AI helpers below are there; one describe turns them off.
const auth = vi.hoisted(() => ({ user: { id: 'u1', aiOptIn: true } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

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
  vi.useRealTimers()
  vi.restoreAllMocks()
  auth.user.aiOptIn = true
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

// A reply typed into a thread used to live only in the input's state, so
// leaving the board (a link, Back, a session-expiry bounce) lost it while the
// new-post draft next to it survived. Replies are kept the same way now.
describe('Board reply drafts', () => {
  const draft = 'I can bring snacks too'

  async function article(title: string) {
    return (await screen.findByText(title)).closest('article') as HTMLElement
  }

  it('keeps a typed reply and reopens its thread after leaving the board and coming back', async () => {
    const first = renderBoard()
    fireEvent.change(within(await article('Where is the quiet floor?')).getByPlaceholderText('Share what you know…'), {
      target: { value: draft },
    })
    first.unmount()

    renderBoard()
    const thread = await article('Where is the quiet floor?')
    expect(within(thread).getByPlaceholderText('Share what you know…')).toHaveValue(draft)
    expect(within(thread).getByRole('button', { name: /3 replies/ })).toHaveAttribute('aria-expanded', 'true')
    const other = await article('Anyone else locked out?')
    expect(within(other).getByRole('button', { name: /replies/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('forgets the draft once the reply is posted', async () => {
    renderBoard()
    const thread = await article('Where is the quiet floor?')
    fireEvent.change(within(thread).getByPlaceholderText('Share what you know…'), { target: { value: draft } })
    expect(localStorage.getItem('boilerindy-board-draft-v1-u1-reply-p-named')).toBe(draft)
    fireEvent.click(within(thread).getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(localStorage.getItem('boilerindy-board-draft-v1-u1-reply-p-named')).toBeNull())
  })

  // A restored draft asked for an AI reply tip on every board visit and sort
  // change, one request per drafted thread, with a "Thinking" box nobody had
  // asked for. Only a draft changed in this visit asks now.
  it('asks for no reply tip on a restored draft until the student edits it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.setItem('boilerindy-board-draft-v1-u1-reply-p-named', 'The third floor has outlets by the windows')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => ({ replyTip: 'Say which building.' }) } as Response)
    const tipRequests = () => fetchSpy.mock.calls.filter(([url]) => url === '/api/board/ai-suggestions')

    renderBoard()
    const thread = await article('Where is the quiet floor?')
    const input = within(thread).getByPlaceholderText('Share what you know…')
    expect(input).toHaveValue('The third floor has outlets by the windows')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(tipRequests()).toHaveLength(0)
    expect(screen.queryByText(/Thinking/)).toBeNull()

    fireEvent.change(input, { target: { value: 'The third floor has outlets by the north windows' } })
    expect(within(thread).getByText(/Thinking/)).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(tipRequests()).toHaveLength(1)
    expect(await within(thread).findByText('Say which building.')).toBeInTheDocument()
  })
})

async function article(title: string) {
  return (await screen.findByText(title)).closest('article') as HTMLElement
}

function openComposer() {
  fireEvent.click(screen.getByRole('button', { name: 'New question' }))
}

/** The JSON bodies of every POST to one path, in order. */
function sentTo(path: string) {
  return vi
    .mocked(authRequest)
    .mock.calls.filter(([p, options]) => p === path && options?.method === 'POST')
    .map(([, options]) => JSON.parse(String(options?.body)))
}

// The composer paired a role="checkbox" square with a hidden native input in
// one label: a click on the square toggled twice and changed nothing, Space did
// nothing, and screen readers met two checkboxes, one of them unnamed (R3).
describe('Board anonymity checkbox', () => {
  it('is one checkbox named Post anonymously that its square toggles, and the post sends what it shows', async () => {
    renderBoard()
    await article('Where is the quiet floor?')
    openComposer()
    const box = screen.getByRole('checkbox', { name: 'Post anonymously' })
    const label = box.closest('label') as HTMLElement
    expect(label.querySelectorAll('input, [role="checkbox"], [tabindex]')).toHaveLength(1)
    const square = label.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(box).toBeChecked()

    fireEvent.click(square)
    expect(box).not.toBeChecked()
    fireEvent.click(screen.getByText('Post anonymously'))
    expect(box).toBeChecked()
    fireEvent.click(square)
    expect(box).not.toBeChecked()
    fireEvent.click(square)
    expect(box).toBeChecked()

    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: 'Where can I print?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(sentTo('/api/board/posts')).toHaveLength(1))
    expect(sentTo('/api/board/posts')[0]).toMatchObject({ title: 'Where can I print?', anon: true })
  })
})

// A failed board read cleared the list and showed "No threads yet", inviting a
// first post on a board that had not loaded; a failed Load more or Show all
// replies only reset its button (R18).
describe('Board read failures', () => {
  const SERVER = 'Something went wrong. Please try again.'

  function failing(match: (path: string) => boolean) {
    const answer = vi.mocked(authRequest).getMockImplementation()
    vi.mocked(authRequest).mockImplementation(async (path, options) => {
      if (match(String(path))) throw Object.assign(new Error(SERVER), { status: 500 })
      return answer?.(path, options)
    })
  }

  it('shows a failed board read with Try again instead of an empty board', async () => {
    let down = true
    failing((path) => down && path.startsWith('/api/board/posts?'))
    renderBoard()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the board')
    expect(alert).toHaveTextContent(SERVER)
    expect(screen.queryByText('No threads yet')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ask a question' })).toBeNull()

    down = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Where is the quiet floor?')).toBeInTheDocument()
    expect(screen.queryByText('Could not load the board')).toBeNull()
  })

  it('says when Load more posts fails and keeps the button for another try', async () => {
    const answer = vi.mocked(authRequest).getMockImplementation()
    vi.mocked(authRequest).mockImplementation(async (path, options) => {
      if (path === '/api/board/posts?sort=recent&page=0') return { posts, page: 0, hasMore: true }
      if (path === '/api/board/posts?sort=recent&page=1') throw Object.assign(new Error(SERVER), { status: 500 })
      return answer?.(path, options)
    })
    renderBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more posts' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(SERVER)
    expect(screen.getByRole('button', { name: 'Load more posts' })).toBeEnabled()
  })

  it('says when Show all replies fails', async () => {
    posts[0] = post(posts[0].id, posts[0].title, { ...posts[0], replyCount: 8, hasMoreReplies: true })
    failing((path) => path.startsWith('/api/board/posts/p-named/replies'))
    renderBoard()
    const thread = await article('Where is the quiet floor?')
    fireEvent.click(within(thread).getByRole('button', { name: /^8 replies$/ }))
    fireEvent.click(within(thread).getByRole('button', { name: 'Show all 8 replies' }))
    expect(await within(thread).findByRole('alert')).toHaveTextContent(SERVER)
    expect(within(thread).getByRole('button', { name: 'Show all 8 replies' })).toBeEnabled()
  })
})

// Replies were always sent with anon: false, so a follow-up in your own
// anonymous thread showed your name under a post shown as Anonymous (R19).
describe('Board reply anonymity', () => {
  it('starts a reply in your own anonymous thread anonymous, and one elsewhere under your name', async () => {
    posts.push(post('p-mine-anon', 'How do I ask for an extension?', { user: 'Anonymous', anon: true, isMine: true }))
    renderBoard()

    const own = await article('How do I ask for an extension?')
    fireEvent.click(within(own).getByRole('button', { name: /0 replies/ }))
    expect(within(own).getByRole('checkbox', { name: 'Reply anonymously' })).toBeChecked()
    fireEvent.change(within(own).getByPlaceholderText('Share what you know…'), { target: { value: 'Update: the dean helped' } })
    fireEvent.click(within(own).getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(sentTo('/api/board/posts/p-mine-anon/reply')).toEqual([{ body: 'Update: the dean helped', anon: true }]))

    const named = await article('Selling a lab coat')
    const box = within(named).getByRole('checkbox', { name: 'Reply anonymously' })
    expect(box).not.toBeChecked()
    fireEvent.change(within(named).getByPlaceholderText('Share what you know…'), { target: { value: 'Still available' } })
    fireEvent.click(within(named).getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(sentTo('/api/board/posts/p-mine/reply')).toEqual([{ body: 'Still available', anon: false }]))

    const other = await article('Anyone else locked out?')
    fireEvent.click(within(other).getByRole('checkbox', { name: 'Reply anonymously' }))
    fireEvent.change(within(other).getByPlaceholderText('Share what you know…'), { target: { value: 'Me too' } })
    fireEvent.click(within(other).getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(sentTo('/api/board/posts/p-anon/reply')).toEqual([{ body: 'Me too', anon: true }]))
  })
})

// Enter pressed twice or a double click on Reply during a slow send posted the
// same reply twice, and a reply cannot be deleted (R20).
describe('Board reply sending', () => {
  it('sends one reply however often Enter or Reply is pressed while it is on its way', async () => {
    let answer: (value: unknown) => void = () => {}
    const original = vi.mocked(authRequest).getMockImplementation()
    vi.mocked(authRequest).mockImplementation(async (path, options) => {
      if (path === '/api/board/posts/p-named/reply') return new Promise((resolve) => (answer = resolve))
      return original?.(path, options)
    })
    renderBoard()
    const thread = await article('Where is the quiet floor?')
    const input = within(thread).getByPlaceholderText('Share what you know…')
    fireEvent.change(input, { target: { value: 'I can drive' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    const button = within(thread).getByRole('button', { name: 'Sending…' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(sentTo('/api/board/posts/p-named/reply')).toHaveLength(1)
    expect(button).toBeDisabled()
    expect(input).toHaveAttribute('readonly')

    await act(async () => {
      answer({ reply: { id: 'r-new', body: 'I can drive', user: 'Test Student', anon: false, isMine: true } })
    })
    expect(within(thread).getAllByText('I can drive')).toHaveLength(1)
    expect(within(thread).getByRole('button', { name: /4 replies/ })).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(input).not.toHaveAttribute('readonly')
  })
})

// The closed composer and collapsed replies were only styled away, so Tab
// walked through about 13 invisible controls and typing went into a hidden
// title; the upvote was named only by its count (R21).
describe('Board hidden controls', () => {
  it('makes the closed composer and collapsed replies inert, and names the upvote', async () => {
    renderBoard()
    const thread = await article('Where is the quiet floor?')
    const title = () => document.getElementById('board-new-title') as HTMLElement
    expect(title().closest('[inert]')).not.toBeNull()
    openComposer()
    expect(title().closest('[inert]')).toBeNull()

    const reply = () => within(thread).getByText('Third floor of the library')
    expect(reply().closest('[inert]')).not.toBeNull()
    fireEvent.click(within(thread).getByRole('button', { name: /3 replies/ }))
    expect(reply().closest('[inert]')).toBeNull()

    expect(within(thread).getByRole('button', { name: 'Upvote, 0' })).toHaveTextContent('0')
  })
})

// Polish with AI and Summarize long thread read only `reply`: a refusal put the
// button back with nothing said, and a busy server's status line replaced the
// draft title (R60).
describe('Board AI helpers', () => {
  const LIMIT = 'You have hit the hourly assistant limit. Try again in a little while.'
  const BUSY = 'The assistant is busy right now. Give it a minute and ask again.'

  function assistantAnswers(status: number, body: unknown) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      url === '/api/assistant'
        ? new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
        : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
  }

  async function polish(title: string) {
    renderBoard()
    await article('Where is the quiet floor?')
    openComposer()
    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: title } })
    fireEvent.click(screen.getByRole('button', { name: 'Polish with AI' }))
  }

  it('says why Polish with AI failed and keeps the draft', async () => {
    assistantAnswers(429, { error: LIMIT })
    await polish('where to print')
    expect(await screen.findByRole('alert')).toHaveTextContent(LIMIT)
    expect(screen.getByLabelText('Question title')).toHaveValue('where to print')
    expect(screen.getByRole('button', { name: 'Polish with AI' })).toBeEnabled()
  })

  it('shows a busy status line as the message, never as the title', async () => {
    assistantAnswers(200, { reply: BUSY, source: 'busy' })
    await polish('where to print')
    expect(await screen.findByRole('alert')).toHaveTextContent(BUSY)
    expect(screen.getByLabelText('Question title')).toHaveValue('where to print')
  })

  it('says the assistant could not be reached when the request itself fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    await polish('where to print')
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the assistant right now. Try again in a moment.")
  })

  it('says why Summarize long thread failed and keeps the button', async () => {
    posts[0] = { ...posts[0], replyCount: 6 }
    assistantAnswers(502, { error: 'The assistant is unavailable right now.' })
    renderBoard()
    const thread = await article('Where is the quiet floor?')
    fireEvent.click(within(thread).getByRole('button', { name: /6 replies/ }))
    fireEvent.click(within(thread).getByRole('button', { name: 'Summarize long thread' }))
    expect(await within(thread).findByRole('alert')).toHaveTextContent('The assistant is unavailable right now.')
    expect(within(thread).getByRole('button', { name: 'Summarize long thread' })).toBeEnabled()
  })
})

// AI suggestions are opt-in (Settings). With them off the board shows none of
// its AI helpers, and no draft or thread goes to the assistant while typing.
describe('Board without AI suggestions', () => {
  it('shows no AI helpers and sends nothing to the assistant', async () => {
    auth.user.aiOptIn = false
    vi.useFakeTimers({ shouldAdvanceTime: true })
    posts[0] = { ...posts[0], replyCount: 6 }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const aiRequests = () =>
      fetchSpy.mock.calls.filter(([url]) => url === '/api/board/ai-suggestions' || url === '/api/assistant')

    renderBoard()
    const thread = await article('Where is the quiet floor?')
    fireEvent.click(within(thread).getByRole('button', { name: /6 replies/ }))
    expect(within(thread).queryByRole('button', { name: 'Summarize long thread' })).toBeNull()
    fireEvent.change(within(thread).getByPlaceholderText('Share what you know…'), {
      target: { value: 'The third floor has outlets by the windows' },
    })

    openComposer()
    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: 'Where can I print near the library?' } })
    expect(screen.queryByRole('button', { name: 'Polish with AI' })).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(aiRequests()).toHaveLength(0)
    expect(screen.queryByText(/Thinking/)).toBeNull()
    expect(screen.queryByText('Live suggestions')).toBeNull()
  })
})
