import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import StudyGroups from './StudyGroups'
import { authRequest } from '../lib/authApi'

// Issue #202: PATCH /api/me/study-groups/opt-in shares the user-write bucket.
// A 429 left the button unchanged with no explanation; the page now says why.
// Issue #192: a group someone else started can be reported and its creator
// blocked; your own group offers neither.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'

let nextWrite: unknown = null
let myGroups: { id: string; title: string; courseCode: string; memberCount: number; joinedByMe: boolean; isMine: boolean }[] = []

// The Report and Block actions refresh per-user queries, so the page needs a client.
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderUi(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  nextWrite = null
  myGroups = []
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (options?.method === 'PATCH') {
        if (nextWrite) {
          const error = nextWrite
          nextWrite = null
          throw error
        }
        return { optIn: JSON.parse(String(options.body)).optIn }
      }
      if (path === '/api/me/study-groups/courses') return { optIn: false, courses: [] }
      if (options?.method === 'POST') return { ok: true }
      if (path === '/api/me/study-groups') return { groups: myGroups }
      return { groups: [] }
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('a 429 on the opt-in toggle keeps the setting and shows the message until the next try', async () => {
  render(<StudyGroups />)
  const toggle = await screen.findByRole('button', { name: 'Opt in' })
  nextWrite = Object.assign(new Error(LIMITED), { status: 429, payload: { error: { message: LIMITED, status: 429 } } })

  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent(LIMITED)
  expect(toggle).toHaveAttribute('aria-pressed', 'false')

  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('offers Report and Block author on a group someone else started, and neither on your own', async () => {
  myGroups = [
    { id: 'g-theirs', title: 'Exam 2 review crew', courseCode: 'CS 18000', memberCount: 3, joinedByMe: true, isMine: false },
    { id: 'g-mine', title: 'Lab partners', courseCode: 'CS 18000', memberCount: 1, joinedByMe: true, isMine: true },
  ]
  render(<StudyGroups />)
  const theirs = within((await screen.findByText('Exam 2 review crew')).closest('.card') as HTMLElement)
  const mine = within(screen.getByText('Lab partners').closest('.card') as HTMLElement)
  expect(mine.queryByRole('button', { name: 'Report' })).not.toBeInTheDocument()
  expect(mine.queryByRole('button', { name: 'Block author' })).not.toBeInTheDocument()

  fireEvent.click(theirs.getByRole('button', { name: 'Report' }))
  expect(screen.getByRole('dialog', { name: 'Report this group' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  fireEvent.click(theirs.getByRole('button', { name: 'Block author' }))
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Block this author?' })).getByRole('button', { name: 'Block' }))
  await waitFor(() => expect(authRequest).toHaveBeenCalledWith('/api/me/blocks/content/study_group/g-theirs', { method: 'POST' }))
  // The creator's groups leave the list, so it is read again.
  await waitFor(() => expect(vi.mocked(authRequest).mock.calls.filter(([p]) => p === '/api/me/study-groups')).toHaveLength(2))
})
