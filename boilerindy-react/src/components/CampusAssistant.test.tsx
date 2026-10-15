import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom'
import CampusAssistant from './CampusAssistant'

// Issue #369 (comment): the welcome message froze the first name in a
// useState initializer, so a name that arrived later (auth finishing, or a
// name set during setup) never showed until a remount. The greeting now
// follows the current name.

const auth = vi.hoisted(() => ({ firstName: 'Student' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, getFirstName: () => auth.firstName }),
}))
vi.mock('../lib/authApi', () => ({ authRequest: vi.fn(async () => ({})) }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

beforeEach(() => sessionStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function ui() {
  return (
    <MemoryRouter>
      <CampusAssistant />
    </MemoryRouter>
  )
}

describe('CampusAssistant greeting', () => {
  test('follows the first name when it changes after mount', () => {
    auth.firstName = 'Student'
    const { rerender } = render(ui())
    expect(screen.getByText(/Hey Student!/)).toBeInTheDocument()
    auth.firstName = 'Pete'
    rerender(ui())
    expect(screen.getByText(/Hey Pete!/)).toBeInTheDocument()
    expect(screen.queryByText(/Hey Student!/)).toBeNull()
  })
})

// AppLayout keeps the assistant mounted across routes, so the panel used to
// stay open over the next page after a link, Back or Forward, its backdrop
// eating the first tap on the tab bar. Escape did nothing either.

function NavButtons() {
  const navigate = useNavigate()
  const [, setSearchParams] = useSearchParams()
  return (
    <>
      <button type="button" onClick={() => navigate('/events')}>Go to events</button>
      <button type="button" onClick={() => navigate('/events', { replace: true })}>Replace with events</button>
      {/* What the Clubs search box does 300ms after the last keystroke. */}
      <button type="button" onClick={() => setSearchParams({ q: 'chess' }, { replace: true })}>Search</button>
      <button type="button" onClick={() => navigate(-1)}>Go back</button>
      <button type="button" onClick={() => navigate(1)}>Go forward</button>
    </>
  )
}

function renderOnSchedule() {
  return render(
    <MemoryRouter initialEntries={['/dashboard', '/schedule']} initialIndex={1}>
      <NavButtons />
      <CampusAssistant />
    </MemoryRouter>,
  )
}

const fab = () => screen.getByRole('button', { name: 'BoilerIndy' })
// The panel is always rendered; closing it only fades its wrapper and stops
// it taking pointer events.
const panelOpen = () => screen.getByTestId('assistant-panel').parentElement!.classList.contains('opacity-100')

describe('CampusAssistant: navigation closes the panel', () => {
  test('Back closes the panel and keeps the conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ reply: 'Try the library.' }) })))
    renderOnSchedule()

    fireEvent.click(fab())
    expect(panelOpen()).toBe(true)
    const input = screen.getByPlaceholderText('Ask about campus...')
    fireEvent.change(input, { target: { value: 'Where can I study?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Try the library.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(panelOpen()).toBe(false)

    fireEvent.click(fab())
    expect(panelOpen()).toBe(true)
    expect(screen.getByText('Where can I study?')).toBeInTheDocument()
    expect(screen.getByText('Try the library.')).toBeInTheDocument()
  })

  test('a link to another page closes the panel', () => {
    renderOnSchedule()
    fireEvent.click(fab())
    expect(panelOpen()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Go to events' }))
    expect(panelOpen()).toBe(false)
  })

  test('Forward back onto the page it was opened on does not reopen it', () => {
    renderOnSchedule()
    fireEvent.click(fab())
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(panelOpen()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Go forward' }))
    expect(panelOpen()).toBe(false)
  })

  test('a replace on the same page (a debounced search) leaves it open', () => {
    renderOnSchedule()
    fireEvent.click(fab())
    expect(panelOpen()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(panelOpen()).toBe(true)
  })

  test('a replace onto another page still closes it', () => {
    renderOnSchedule()
    fireEvent.click(fab())

    fireEvent.click(screen.getByRole('button', { name: 'Replace with events' }))
    expect(panelOpen()).toBe(false)
  })

  test('the open-campus-assistant event still opens it after a navigation', () => {
    renderOnSchedule()
    fireEvent.click(screen.getByRole('button', { name: 'Go to events' }))

    act(() => {
      window.dispatchEvent(new CustomEvent('open-campus-assistant'))
    })
    expect(panelOpen()).toBe(true)
  })
})

describe('CampusAssistant: Escape', () => {
  test('closes the panel and returns focus to the floating button', async () => {
    renderOnSchedule()
    fireEvent.click(fab())
    const input = screen.getByPlaceholderText('Ask about campus...')
    await waitFor(() => expect(input).toHaveFocus())

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(panelOpen()).toBe(false)
    expect(fab()).toHaveFocus()
  })
})

// The closed panel was only faded, so its controls stayed in the tab order
// and a navigation that closed it left focus in the hidden input, where
// typing and Enter still sent a question nobody could see.
describe('CampusAssistant: focus when the panel closes', () => {
  const wrapper = () => screen.getByTestId('assistant-panel').parentElement!

  test('the closed panel is inert and the open one is not', () => {
    renderOnSchedule()
    expect(wrapper()).toHaveAttribute('inert')

    fireEvent.click(fab())
    expect(wrapper()).not.toHaveAttribute('inert')
  })

  test('a navigation that closes it moves focus from the input to the floating button', async () => {
    renderOnSchedule()
    fireEvent.click(fab())
    const input = screen.getByPlaceholderText('Ask about campus...')
    await waitFor(() => expect(input).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(panelOpen()).toBe(false)
    expect(fab()).toHaveFocus()
  })

  test('the Close button hands focus to the floating button', () => {
    renderOnSchedule()
    fireEvent.click(fab())
    const close = screen.getByRole('button', { name: 'Close the assistant' })
    close.focus()

    fireEvent.click(close)
    expect(panelOpen()).toBe(false)
    expect(fab()).toHaveFocus()
  })
})

// requireAuth (401) and the final error handler (413) answer with the
// envelope { error: { message } }, not the route's own string errors. The
// object went into the reply as is and rendered an empty bubble, and a 401
// left the student in the panel instead of sending them to sign in.
describe('CampusAssistant: error answers from outside the route', () => {
  function ask(question: string) {
    fireEvent.click(fab())
    const input = screen.getByPlaceholderText('Ask about campus...')
    fireEvent.change(input, { target: { value: question } })
    fireEvent.keyDown(input, { key: 'Enter' })
  }

  test('shows the message from an error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 413,
        json: async () => ({ error: { message: 'That request was too large.', status: 413 } }),
      })),
    )
    renderOnSchedule()
    ask('When is my next class?')

    expect(await screen.findByText('That request was too large.')).toBeInTheDocument()
  })

  test("still shows the route's own string error", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 429,
        json: async () => ({ error: 'You have hit the hourly assistant limit. Try again in a little while.' }),
      })),
    )
    renderOnSchedule()
    ask('When is my next class?')

    expect(await screen.findByText(/hit the hourly assistant limit/)).toBeInTheDocument()
  })

  test('a 401 sends them to sign in with the session-expired notice', async () => {
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, pathname: '/schedule', search: '?day=mon', replace })
    const json = vi.fn(async () => ({ error: { message: 'You must sign in to access this resource.', status: 401 } }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, json })))
    renderOnSchedule()
    ask('When is my next class?')

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/login?next=%2Fschedule%3Fday%3Dmon&message=session-expired'),
    )
    expect(json).not.toHaveBeenCalled()
    expect(screen.queryByText('You must sign in to access this resource.')).toBeNull()
  })
})
