import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Assignments from './Assignments'
import { authRequest } from '../lib/authApi'

// Issue #202: the user-write limiter (429) and the 500-task cap (409) refuse a
// write from a server that is up. Before, any failed add, tick or delete put
// the page into device-only mode (taskMeta.local), and every later write
// skipped the server until a reload. A refusal now keeps the page online,
// undoes the change and shows the server's message. A write that gets no
// answer, or a 5xx, does the same with its own message: saving it on this
// device used to hide every task on the account, show the database setup
// notice, and lose the task on the next reload. Only the server's own "no task
// tables" answer (unavailable) still keeps tasks in this browser.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../components/SourceErrorNotice', () => ({ default: () => null }))
vi.mock('../components/TaskCompleteReward', () => ({ default: () => null }))
const auth = vi.hoisted(() => ({ user: { id: 'user-1', aiOptIn: false }, onboarding: { linkedSourceCount: 1 } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'
const CAPPED = 'You can keep up to 500 tasks. Delete some you no longer need to add more.'
const DEVICE_ONLY_BANNER = /Tasks work in this browser/
const NOT_ADDED = 'Could not reach the server, so the task was not added. Please try again.'
const NOT_UPDATED = 'Could not reach the server, so the task was not updated. Please try again.'
const NOT_DELETED = 'Could not reach the server, so the task was not deleted. Please try again.'
const DEVICE_STORE = 'boilerindy-tasks-v1-user-1'

const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()

type Api = {
  completions: { calendar_item_id: string; completed_at: string }[]
  manualTasks: { id: string; title: string; startTime: string | null; completedAt: string | null }[]
  /** Errors thrown by the next matching requests, keyed "METHOD path". */
  failures: Map<string, unknown[]>
  /** Every calendar read fails, as through a gateway 502. */
  calendarDown: boolean
  /** The calendar answers with nothing on it. */
  calendarEmpty: boolean
  /** The server's answer when the task tables are missing. */
  tablesMissing: boolean
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
    calendarDown: false,
    calendarEmpty: false,
    tablesMissing: false,
  }
  // jsdom has no scrollIntoView; the page calls it to bring a task's details on screen.
  Element.prototype.scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      const method = options?.method || 'GET'
      const queued = api.failures.get(`${method} ${path}`)
      if (queued?.length) throw queued.shift()
      const body = options?.body ? JSON.parse(String(options.body)) : {}
      if (path.startsWith('/api/me/calendar?')) {
        if (api.calendarDown) throw httpError(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')
        if (api.calendarEmpty) return { items: [] }
        return { items: [{ id: 'cal-1', title: 'Lab report', category: 'assignment', startTime: inTwoDays() }] }
      }
      if (path === '/api/me/calendar/categories') return { categories: [{ id: 'assignment', label: 'Assignments', count: 1 }] }
      if (path === '/api/me/tasks/meta') {
        if (api.tablesMissing) return { completions: [], manualTasks: [], unavailable: true }
        return { completions: api.completions, manualTasks: api.manualTasks }
      }
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
async function renderPage(ready = 'Read chapter four') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter useTransitions={false}>
        <Assignments />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText(ready)
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

it.each([
  ['no response', new TypeError('Failed to fetch')],
  ['a 500', httpError(500, 'Could not create task')],
])('%s on adding a task keeps the account tasks, the title and the server', async (_case, failure) => {
  await renderPage()
  failNext('POST', '/api/me/tasks/manual', failure)

  await addTask('Offline errand')
  expect(await screen.findByText(NOT_ADDED)).toBeInTheDocument()
  expect(screen.getByLabelText('Title')).toHaveValue('Offline errand')
  expect(screen.getByText('Read chapter four')).toBeInTheDocument()
  expect(screen.queryByText(DEVICE_ONLY_BANNER)).not.toBeInTheDocument()
  expect(localStorage.getItem(DEVICE_STORE)).toBeNull()

  // The next try goes to the server and lands on the account.
  fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
  expect(await screen.findByText('Offline errand', { selector: 'div' })).toBeInTheDocument()
  expect(writesTo('POST', '/api/me/tasks/manual')).toHaveLength(2)
  expect(api.manualTasks.map((t) => t.title)).toContain('Offline errand')
  expect(screen.queryByText(NOT_ADDED)).not.toBeInTheDocument()
})

it('a 500 on ticking a task undoes the tick, keeps the device store out of it and keeps calling the server', async () => {
  await renderPage()
  failNext('POST', '/api/me/tasks/calendar/complete', httpError(500, 'Could not update completion'))

  fireEvent.click(checkboxFor('Lab report'))
  expect(await screen.findByText(NOT_UPDATED)).toBeInTheDocument()
  await waitFor(() => expect(checkboxFor('Lab report')).toHaveAttribute('aria-label', 'Mark as done'))
  expect(screen.queryByText(DEVICE_ONLY_BANNER)).not.toBeInTheDocument()
  expect(localStorage.getItem(DEVICE_STORE)).toBeNull()

  fireEvent.click(checkboxFor('Lab report'))
  await waitFor(() => expect(checkboxFor('Lab report')).toHaveAttribute('aria-label', 'Mark as not done'))
  expect(writesTo('POST', '/api/me/tasks/calendar/complete')).toHaveLength(2)
  expect(api.completions).toHaveLength(1)
})

it('no response on deleting a task keeps it listed and keeps the page online', async () => {
  await renderPage()
  failNext('DELETE', '/api/me/tasks/manual/task-1', new TypeError('Failed to fetch'))

  fireEvent.click(screen.getByText('Read chapter four'))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete task' }))
  expect(await screen.findByText(NOT_DELETED)).toBeInTheDocument()
  expect(screen.getAllByText('Read chapter four').length).toBeGreaterThan(0)
  expect(screen.queryByText(DEVICE_ONLY_BANNER)).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
  await waitFor(() => expect(screen.queryByText('Read chapter four')).not.toBeInTheDocument())
  expect(writesTo('DELETE', '/api/me/tasks/manual/task-1')).toHaveLength(2)
})

// A 503 while Render wakes used to read as "no task tables": the page hid the
// account's tasks, showed the SQL notice, and kept the next add in this
// browser, gone after a reload.
it('a failed task read says so with Try again, and an add still goes to the server', async () => {
  failNext('GET', '/api/me/tasks/meta', httpError(503, '<html>Service Unavailable</html>'))
  await renderPage('Lab report')

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Could not load your tasks, so your own tasks and check marks are missing.')
  expect(screen.queryByText(DEVICE_ONLY_BANNER)).not.toBeInTheDocument()

  await addTask('Finish lab write-up')
  await waitFor(() => expect(writesTo('POST', '/api/me/tasks/manual')).toHaveLength(1))
  expect(api.manualTasks.map((t) => t.title)).toContain('Finish lab write-up')
  expect(localStorage.getItem(DEVICE_STORE)).toBeNull()
  // The add refreshed the task list, which now answers.
  expect(await screen.findByText('Read chapter four')).toBeInTheDocument()
  expect(screen.getByText('Finish lab write-up', { selector: 'div' })).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('Try again reloads a failed task read', async () => {
  failNext('GET', '/api/me/tasks/meta', new TypeError('Failed to fetch'))
  await renderPage('Lab report')

  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Read chapter four')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('only missing task tables keep tasks in this browser', async () => {
  api.tablesMissing = true
  await renderPage('Lab report')
  expect(screen.getByText(DEVICE_ONLY_BANNER)).toBeInTheDocument()

  await addTask('Offline errand')
  expect(await screen.findByText('Offline errand', { selector: 'div' })).toBeInTheDocument()
  expect(localStorage.getItem(DEVICE_STORE)).toContain('Offline errand')
  expect(writesTo('POST', '/api/me/tasks/manual')).toHaveLength(0)
})

it('a failed calendar read says so instead of "No items found"', async () => {
  api.calendarDown = true
  api.manualTasks = []
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter useTransitions={false}>
        <Assignments />
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your calendar, so imported assignments are missing.')
  expect(screen.queryByText('No items found')).not.toBeInTheDocument()
  expect(screen.queryByText(/502 Bad Gateway/)).not.toBeInTheDocument()

  api.calendarDown = false
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Lab report')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

// A cleared date field used to make Add task do nothing, silently.
it('a cleared due date says a date is needed and sends nothing', async () => {
  await renderPage()
  fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '' } })
  await addTask('Finish problem set')

  expect(await screen.findByText('Pick a due date for this task.')).toBeInTheDocument()
  expect(writesTo('POST', '/api/me/tasks/manual')).toHaveLength(0)
  expect(screen.getByLabelText('Title')).toHaveValue('Finish problem set')
})

// The mobile app makes to-dos with no deadline; they sorted first under a
// blank heading and the details ended in a bare "Due in".
it('a task with no due date is listed last under "No due date" and its details say so', async () => {
  api.manualTasks.push({ id: 'task-2', title: 'Email advisor', startTime: null, completedAt: null })
  await renderPage()

  const headings = Array.from(document.querySelectorAll('ol.dep'), (list) => list.previousElementSibling?.textContent)
  expect(headings.at(-1)).toBe('No due date')

  fireEvent.click(screen.getByText('Email advisor'))
  const details = (await screen.findByRole('button', { name: 'Close details' })).closest('.card') as HTMLElement
  expect(details).toHaveTextContent('No due date')
  expect(details).not.toHaveTextContent(/Due in/)
})

it('the details close button has a name and closes the details', async () => {
  await renderPage()
  fireEvent.click(screen.getByText('Lab report'))
  fireEvent.click(await screen.findByRole('button', { name: 'Close details' }))
  expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument()
})

// The row is a role=button whose Enter and Space open the details. The keys
// bubbled up from the nested Mark as done button too, and the row's
// preventDefault cancelled the button's own click, so the keyboard could not
// tick a task from the list.
it("Enter and Space on a row's Mark as done button are left to the button", async () => {
  await renderPage()
  const checkbox = checkboxFor('Lab report')
  expect(fireEvent.keyDown(checkbox, { key: 'Enter' })).toBe(true)
  expect(fireEvent.keyDown(checkbox, { key: ' ' })).toBe(true)
  expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument()

  // On the row itself the keys still open the details.
  expect(fireEvent.keyDown(checkbox.closest('[role="button"]') as HTMLElement, { key: 'Enter' })).toBe(false)
  expect(await screen.findByRole('button', { name: 'Mark done' })).toBeInTheDocument()
})

// Below lg the details card sits under the whole list; a tap on a phone
// used to open it off screen, so nothing seemed to happen.
it('selecting a task on a narrow screen scrolls its details into view and focuses the title', async () => {
  await renderPage()
  fireEvent.click(screen.getByText('Lab report'))

  const title = await screen.findByRole('heading', { name: 'Lab report' })
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' }))
  await waitFor(() => expect(document.activeElement).toBe(title))
})

describe('AI Insights', () => {
  const assistantCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/assistant')

  function answerAssistant(status: number, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
  }

  beforeEach(() => {
    auth.user.aiOptIn = true
  })

  afterEach(() => {
    auth.user.aiOptIn = false
    vi.unstubAllGlobals()
  })

  // AI suggestions are opt-in (Settings): without them the card is not there.
  it('is not shown until the student turns on AI suggestions', async () => {
    auth.user.aiOptIn = false
    await renderPage()
    expect(screen.queryByText('AI Insights')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull()
  })

  // Generate used to read only `reply`, so a refusal or a failure put the
  // button back with the original hint and nothing said.
  it.each([
    [429, { error: 'You have hit the hourly assistant limit. Try again in a little while.' }, 'You have hit the hourly assistant limit. Try again in a little while.'],
    [502, { error: 'The assistant is having trouble right now.' }, 'The assistant is having trouble right now.'],
    [200, { reply: 'The assistant is busy right now. Give it a minute and ask again.', source: 'busy' }, 'The assistant is busy right now. Give it a minute and ask again.'],
  ])('a %i says why Generate failed and caches nothing', async (status, body, message) => {
    answerAssistant(status, body)
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    expect(await screen.findByText(message)).toHaveAttribute('role', 'alert')
    expect(assistantCalls()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument()
    expect(Object.keys(localStorage).filter((k) => k.includes('assignments'))).toEqual([])
  })

  it('no response says the assistant could not be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByText("Couldn't reach the assistant right now. Try again in a moment.")).toBeInTheDocument()
  })

  it('a reply is shown and the message from a failed try is cleared', async () => {
    answerAssistant(429, { error: 'You have hit the hourly assistant limit. Try again in a little while.' })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText(/hourly assistant limit/)

    answerAssistant(200, { reply: '- **Fri** Lab report' })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByText('Lab report', { selector: 'li' })).toBeInTheDocument()
    expect(screen.queryByText(/hourly assistant limit/)).not.toBeInTheDocument()
  })
})

// Issue #376: the nav calls this page Tasks, so the page does too: its heading,
// the tab title and the notes it shows. The route is still /assignments, and
// "Assignments" stays where it names a category of item (the filter pills).
describe('naming', () => {
  it('is Tasks in the heading and the tab title, and keeps Assignments as a category filter', async () => {
    await renderPage()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tasks')
    expect(document.title).toBe('Tasks - BoilerIndy')
    expect(screen.getByRole('button', { name: 'Assignments (1)' })).toBeInTheDocument()
  })

  it('says tasks while it loads', async () => {
    vi.mocked(authRequest).mockImplementation(() => new Promise(() => {}))
    await renderPage('Loading tasks...')
    expect(screen.queryByText(/Loading assignments/)).not.toBeInTheDocument()
  })

  it('says tasks when nothing is upcoming', async () => {
    api.calendarEmpty = true
    api.manualTasks = []
    await renderPage('No items found')
    expect(screen.getByText('No upcoming tasks or events.')).toBeInTheDocument()
  })

  it('says tasks when no calendar is connected yet', async () => {
    auth.onboarding.linkedSourceCount = 0
    try {
      api.calendarEmpty = true
      api.manualTasks = []
      await renderPage('No items found')
      expect(screen.getByText('Connect your Brightspace calendar to see tasks and events.')).toBeInTheDocument()
    } finally {
      auth.onboarding.linkedSourceCount = 1
    }
  })
})
