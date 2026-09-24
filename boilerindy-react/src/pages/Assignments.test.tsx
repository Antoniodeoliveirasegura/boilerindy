import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Assignments from './Assignments'
import { authRequest } from '../lib/authApi'

// Issue #202: the user-write limiter (429) and the 500-task cap (409) refuse a
// write from a server that is up. Before, any failed add, tick or delete put
// the page into device-only mode (taskMeta.local), and every later write
// skipped the server until a reload. A refusal now keeps the page online,
// undoes the change and shows the server's message; only a request that gets
// no response still falls back to this device.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../components/SourceErrorNotice', () => ({ default: () => null }))
vi.mock('../components/TaskCompleteReward', () => ({ default: () => null }))
const auth = vi.hoisted(() => ({ user: { id: 'user-1' }, onboarding: { linkedSourceCount: 1 } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'
const CAPPED = 'You can keep up to 500 tasks. Delete some you no longer need to add more.'
const DEVICE_ONLY_BANNER = /Tasks work in this browser/

const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()

type Api = {
  completions: { calendar_item_id: string; completed_at: string }[]
  manualTasks: { id: string; title: string; startTime: string; completedAt: string | null }[]
  /** Errors thrown by the next matching writes, keyed "METHOD path". */
  failures: Map<string, unknown[]>
}
let api: Api

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
}

function failNext(method: string, path: string, error: unknown) {
  const key = `${method} ${path}`
  api.failures.set(key, [...(api.failures.get(key) || []), error])
}

function writesTo(method: string, path: string) {
  return vi.mocked(authRequest).mock.calls.filter(([p, o]) => p === path && o?.method === method)
}

beforeEach(() => {
  localStorage.clear()
  api = {
    completions: [],
    manualTasks: [{ id: 'task-1', title: 'Read chapter four', startTime: inTwoDays(), completedAt: null }],
    failures: new Map(),
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      const method = options?.method || 'GET'
      const queued = api.failures.get(`${method} ${path}`)
      if (queued?.length) throw queued.shift()
      const body = options?.body ? JSON.parse(String(options.body)) : {}
      if (path.startsWith('/api/me/calendar?')) {
        return { items: [{ id: 'cal-1', title: 'Lab report', category: 'assignment', startTime: inTwoDays() }] }
      }
      if (path === '/api/me/calendar/categories') return { categories: [{ id: 'assignment', label: 'Assignments', count: 1 }] }
      if (path === '/api/me/tasks/meta') return { completions: api.completions, manualTasks: api.manualTasks }
      if (path === '/api/me/tasks/manual' && method === 'POST') {
        const task = { id: `task-${api.manualTasks.length + 1}`, title: body.title, startTime: body.dueAt, completedAt: null }
        api.manualTasks.push(task)
        return { task }
      }
      if (path === '/api/me/tasks/calendar/complete' && method === 'POST') {
        if (body.completed) api.completions.push({ calendar_item_id: body.calendarItemId, completed_at: new Date().toISOString() })
        else api.completions = api.completions.filter((c) => c.calendar_item_id !== body.calendarItemId)
        return { ok: true }
      }
      if (path.startsWith('/api/me/tasks/manual/') && method === 'DELETE') {
        api.manualTasks = api.manualTasks.filter((t) => `/api/me/tasks/manual/${t.id}` !== path)
        return { ok: true }
      }
      return {}
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// The page reads its calendar, categories and task metadata through the query
// cache (issue #327); a client per test keeps nothing between cases.
async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Assignments />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText('Read chapter four')
}

async function addTask(title: string) {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: title } })
  fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
}

function checkboxFor(title: string) {
  const card = screen.getByText(title).closest('[role="button"]') as HTMLElement
  return card.querySelector('button[aria-label^="Mark as"]') as HTMLButtonElement
}

it.each([
  [409, CAPPED],
  [429, LIMITED],
])('a %i on adding a task keeps the page online, keeps the title and shows the message', async (status, message) => {
  await renderPage()
  failNext('POST', '/api/me/tasks/manual', httpError(status, message))

  await addTask('Finish problem set')
  expect(await screen.findByText(message)).toBeInTheDocument()
  expect(screen.getByLabelText('Title')).toHaveValue('Finish problem set')
  expect(screen.queryByText('Finish problem set', { selector: 'div' })).not.toBeInTheDocument()
  expect(screen.queryByText(DEVICE_ONLY_BANNER)).not.toBeInTheDocument()
  expect(localStorage.getItem('boilerindy-tasks-v1-user-1')).toBeNull()

  // Still online: the retry goes to the server and the message clears.
  fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
  expect(await screen.findByText('Finish problem set', { selector: 'div' })).toBeInTheDocument()
  expect(writesTo('POST', '/api/me/tasks/manual')).toHaveLength(2)
  expect(screen.queryByText(message)).not.toBeInTheDocument()

  // A later write still reaches the server instead of the device-only store.
  fireEvent.click(checkboxFor('Lab report'))
  await waitFor(() => expect(writesTo('POST', '/api/me/tasks/calendar/complete')).toHaveLength(1))
})

it('a 429 on ticking a task undoes the tick, shows the message and keeps calling the server', async () => {
  await renderPage()
  failNext('POST', '/api/me/tasks/calendar/complete', httpError(429, LIMITED))

  fireEvent.click(checkboxFor('Lab report'))
  expect(await screen.findByText(LIMITED)).toBeInTheDocument()
  await waitFor(() => expect(checkboxFor('Lab report')).toHaveAttribute('aria-label', 'Mark as done'))
  expect(screen.queryByText(DEVICE_ONLY_BANNER)).not.toBeInTheDocument()
  expect(localStorage.getItem('boilerindy-tasks-v1-user-1')).toBeNull()

  fireEvent.click(checkboxFor('Lab report'))
  await waitFor(() => expect(checkboxFor('Lab report')).toHaveAttribute('aria-label', 'Mark as not done'))
  expect(writesTo('POST', '/api/me/tasks/calendar/complete')).toHaveLength(2)
  expect(api.completions).toHaveLength(1)
})

it('a 429 on deleting a task keeps it listed and keeps the page online', async () => {
  await renderPage()
  failNext('DELETE', '/api/me/tasks/manual/task-1', httpError(429, LIMITED))

  fireEvent.click(screen.getByText('Read chapter four'))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete task' }))
  expect(await screen.findByText(LIMITED)).toBeInTheDocument()
  expect(screen.getAllByText('Read chapter four').length).toBeGreaterThan(0)
  expect(screen.queryByText(DEVICE_ONLY_BANNER)).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
  await waitFor(() => expect(screen.queryByText('Read chapter four')).not.toBeInTheDocument())
  expect(writesTo('DELETE', '/api/me/tasks/manual/task-1')).toHaveLength(2)
})

it('a network error on adding a task still saves it on this device only', async () => {
  await renderPage()
  failNext('POST', '/api/me/tasks/manual', new TypeError('Failed to fetch'))

  await addTask('Offline errand')
  expect(await screen.findByText('Offline errand', { selector: 'div' })).toBeInTheDocument()
  expect(screen.getByText(DEVICE_ONLY_BANNER)).toBeInTheDocument()
  expect(localStorage.getItem('boilerindy-tasks-v1-user-1')).toContain('Offline errand')

  // Device-only mode: the next add stays on this device.
  await addTask('Second offline errand')
  expect(await screen.findByText('Second offline errand', { selector: 'div' })).toBeInTheDocument()
  expect(writesTo('POST', '/api/me/tasks/manual')).toHaveLength(1)
})
