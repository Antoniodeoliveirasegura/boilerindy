import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  // Each group is one row of the list (the list itself is the card).
  const theirs = within((await screen.findByText('Exam 2 review crew')).closest('li') as HTMLElement)
  const mine = within(screen.getByText('Lab partners').closest('li') as HTMLElement)
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

describe('Study group join, leave and create', () => {
  const COURSE_PATH = `/api/study-groups?course=${encodeURIComponent('CS 25100')}`
  const FULL = 'This group is full.'
  const CAPACITY = 'Capacity must be a whole number between 2 and 100'
  type Group = { id: string; title: string; courseCode: string; memberCount: number; capacity?: number; joinedByMe: boolean; isMine: boolean }
  let courseGroups: Group[]
  let join: (() => Promise<unknown>) | null

  function refusal(message: string, status: number) {
    return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
  }

  beforeEach(() => {
    courseGroups = [{ id: 'g-crew', title: 'Exam 2 review crew', courseCode: 'CS 25100', memberCount: 7, capacity: 8, joinedByMe: false, isMine: false }]
    join = null
    vi.mocked(authRequest).mockImplementation(async (path, options) => {
      if (path === '/api/me/study-groups/courses') return { optIn: true, courses: [{ code: 'CS 25100', classmateCount: 3 }] }
      if (path === COURSE_PATH) return { groups: courseGroups }
      if (path === '/api/me/study-groups') return { groups: myGroups }
      if (path === '/api/study-groups/g-crew/join' && join) return join()
      if (path === '/api/study-groups' && options?.method === 'POST') {
        // As validateStudyGroupInput: null (or no size) means no limit, anything else must be a whole number.
        const { capacity } = JSON.parse(String(options.body))
        if (capacity != null && !Number.isInteger(Number(capacity))) throw refusal(CAPACITY, 400)
        return { group: {} }
      }
      if (options?.method === 'POST') return { ok: true }
      return { groups: [] }
    })
  })

  async function openCourse() {
    render(<StudyGroups />)
    fireEvent.click(await screen.findByRole('button', { name: /^CS 25100/ }))
    return within((await screen.findByText('Exam 2 review crew')).closest('li') as HTMLElement)
  }

  function joinCalls() {
    return vi.mocked(authRequest).mock.calls.filter(([p]) => p === '/api/study-groups/g-crew/join')
  }

  it('says a group filled up when Join is refused, and then shows it as full', async () => {
    join = async () => {
      courseGroups = [{ ...courseGroups[0], memberCount: 8 }]
      throw refusal(FULL, 409)
    }
    const row = await openCourse()
    fireEvent.click(row.getByRole('button', { name: 'Join' }))

    const crew = within((await screen.findByRole('alert')).closest('li') as HTMLElement)
    expect(crew.getByRole('alert')).toHaveTextContent(FULL)
    await waitFor(() => expect(crew.getByRole('button', { name: 'Full' })).toBeDisabled())
    expect(crew.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
  })

  it('sends one join for a double tap', async () => {
    let release = () => {}
    join = () => new Promise((resolve) => { release = () => resolve({ ok: true }) })
    const row = await openCourse()
    const button = row.getByRole('button', { name: 'Join' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button).toBeDisabled()
    release()
    await waitFor(() => expect(vi.mocked(authRequest).mock.calls.filter(([p]) => p === COURSE_PATH)).toHaveLength(2))
    expect(joinCalls()).toHaveLength(1)
  })

  it('sends a size that is not a number as typed, so the server refuses it instead of making the group unlimited', async () => {
    await openCourse()
    fireEvent.click(screen.getByRole('button', { name: 'New group' }))
    fireEvent.change(screen.getByPlaceholderText('Group name (e.g. Exam 2 review crew)'), { target: { value: 'Midterm grind' } })
    fireEvent.change(screen.getByPlaceholderText('Max size (optional, 2-100)'), { target: { value: 'six' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))

    expect(await screen.findByText(CAPACITY)).toBeInTheDocument()
    const [, options] = vi.mocked(authRequest).mock.calls.find(([p, o]) => p === '/api/study-groups' && o?.method === 'POST') ?? []
    expect(JSON.parse(String(options?.body)).capacity).toBe('six')
  })
})
