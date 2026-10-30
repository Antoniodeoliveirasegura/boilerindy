import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'

const mocks = vi.hoisted(() => ({
  authRequest: vi.fn(),
  signOut: vi.fn(),
  signInWithGoogle: vi.fn(),
  replace: vi.fn(),
}))

// One object for every render: Settings re-seeds its fields whenever `user`
// changes identity.
const auth = vi.hoisted(() => ({
  user: { id: 'user-1', name: 'Test Student', email: 'student@example.edu' } as {
    id: string
    name: string
    email: string
    authProvider?: string
  },
  supabaseUser: null as null | { identities?: { provider: string; identity_data?: Record<string, unknown> }[] },
  onboarding: { linkedSourceCount: 0, classCount: 0 },
  refreshSession: () => Promise.resolve(null),
  startPurdueLink: () => {},
  authConfig: { authProvider: 'local', purdueAuthMode: 'mock' },
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => auth,
  useSignOutAndRedirect: () => () => {},
}))
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }))
vi.mock('../lib/authApi', () => ({ authRequest: mocks.authRequest }))
vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signOut: mocks.signOut } },
  signInWithGoogle: mocks.signInWithGoogle,
}))
// The cards with their own data and tests.
vi.mock('../components/settings/PushNotificationsCard', () => ({ default: () => null }))
vi.mock('../components/settings/BlockedUsersCard', () => ({ default: () => null }))
vi.mock('../components/PurdueEmailVerification', () => ({ default: () => null }))

function renderSettings(path = '/settings') {
  return render(
    <MemoryRouter initialEntries={[path]} useTransitions={false}>
      <Settings />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  mocks.authRequest.mockImplementation(async (url: string) => {
    if (url === '/api/me/calendar-feed') return { feedUrl: null }
    return {}
  })
  mocks.signOut.mockResolvedValue({ error: null })
  vi.stubGlobal('location', { ...window.location, replace: mocks.replace })
})

afterEach(() => {
  delete auth.user.authProvider
  auth.supabaseUser = null
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// AI suggestions are opt-in: the box starts off, and checking it saves aiOptIn
// alone, then refreshes the session that Home, Tasks and Events read.
describe('Settings: AI suggestions', () => {
  test('starts off, and checking it saves aiOptIn and refreshes the session', async () => {
    const refreshSession = vi.spyOn(auth, 'refreshSession')
    renderSettings()
    const box = screen.getByRole('checkbox', { name: /show ai suggestions/i })
    expect(box).not.toBeChecked()

    fireEvent.click(box)
    expect(await screen.findByText('AI suggestions turned on.')).toBeInTheDocument()
    expect(mocks.authRequest).toHaveBeenCalledWith('/api/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({ aiOptIn: true }),
    })
    expect(refreshSession).toHaveBeenCalled()
  })

  test('shows why the choice could not be saved', async () => {
    mocks.authRequest.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/me/calendar-feed') return { feedUrl: null }
      if (url === '/api/me/profile' && init?.method === 'PATCH') {
        throw new Error('The AI suggestions setting is not set up yet. Please try again later.')
      }
      return {}
    })
    renderSettings()
    fireEvent.click(screen.getByRole('checkbox', { name: /show ai suggestions/i }))
    expect(await screen.findByText('The AI suggestions setting is not set up yet. Please try again later.')).toBeInTheDocument()
    expect(screen.queryByText('AI suggestions turned on.')).toBeNull()
  })
})

// The account fields had labels with no htmlFor and inputs with no id, so a
// screen reader named them by their placeholders: the Display name field was
// announced as someone else's name.
describe('Settings: account fields', () => {
  test('each account and password field is named by its label', () => {
    renderSettings()
    for (const label of ['Display name', 'Email', 'Current password', 'New password', 'Confirm new password']) {
      expect(screen.getByLabelText(label, { selector: 'input' })).toBeInTheDocument()
    }
    expect(screen.getByLabelText('Display name')).toHaveValue('Test Student')
    expect(screen.queryByPlaceholderText('Antonio Segura')).toBeNull()
  })
})

// A wrong password or a DELETE typo showed its error in the page banner, two
// or three screens above the delete form, so nothing seemed to happen.
describe('Settings: delete account', () => {
  function deleteCard() {
    return screen.getByRole('button', { name: 'Delete my account' }).closest('form') as HTMLFormElement
  }

  async function submitDelete({ password, confirmation }: { password: string; confirmation: string }) {
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: confirmation } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
  }

  test('a wrong password shows its error in the delete form and puts focus on the password', async () => {
    mocks.authRequest.mockImplementation(async (url: string) => {
      if (url === '/api/me/delete-account') throw new Error('Password is incorrect.')
      return { feedUrl: null }
    })
    renderSettings()

    await submitDelete({ password: 'not-my-password', confirmation: 'DELETE' })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }))

    const alert = await within(deleteCard()).findByRole('alert')
    expect(alert).toHaveTextContent('Password is incorrect.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveFocus())
  })

  test('a lowercase confirmation shows its error in the delete form and puts focus on that box', async () => {
    renderSettings()

    await submitDelete({ password: 'my-password', confirmation: 'delete' })

    expect(within(deleteCard()).getByRole('alert')).toHaveTextContent(
      'Type DELETE in the confirmation box to permanently delete your account.',
    )
    expect(screen.getByLabelText('Type DELETE to confirm')).toHaveFocus()
    expect(mocks.authRequest).not.toHaveBeenCalledWith('/api/me/delete-account', expect.anything())
  })

  // Grades, schedule edits, task priorities and the assistant conversation
  // stayed in browser storage after the account was deleted.
  test("a deleted account's stores leave this device", async () => {
    localStorage.setItem('boilerindy-grades-v1-user-1', '[{"courseName":"CS 18000","letterGrade":"B"}]')
    localStorage.setItem('boilerindy-schedule-overrides-v1-user-1', '{"series":{},"manual":[]}')
    localStorage.setItem('boilerindy-task-priority-v1-user-1', '{"task-a":"high"}')
    localStorage.setItem('boilerindy-grades-v1-user-2', '[]')
    sessionStorage.setItem('boilerindy-assistant-history-v1-user-1', '[]')
    renderSettings()

    await submitDelete({ password: 'my-password', confirmation: 'DELETE' })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }))

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/'))
    expect(Object.keys(localStorage)).toEqual(['boilerindy-grades-v1-user-2'])
    expect(sessionStorage.length).toBe(0)
  })
})

// A Google account has no current password, so it could never set one or change its email.
describe('Settings: account details for a Google account', () => {
  test('Confirm with Google returns to Settings, then a first password saves without a current one', async () => {
    auth.user.authProvider = 'google'
    mocks.signInWithGoogle.mockResolvedValue({})
    const { unmount } = renderSettings()
    const accountForm = screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement
    fireEvent.click(within(accountForm).getByRole('button', { name: 'Confirm with Google' }))
    await waitFor(() => expect(mocks.signInWithGoogle).toHaveBeenCalled())
    expect(sessionStorage.getItem('postAuthNext')).toBe('/settings?confirmed=google')
    unmount()

    renderSettings('/settings?confirmed=google')
    expect(screen.getByLabelText('New password')).toHaveFocus()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-new-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'a-new-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.getByText('Settings updated.')).toBeInTheDocument())
    const [, init] = mocks.authRequest.mock.calls.find(([url]) => url === '/api/me/profile') as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ currentPassword: '', newPassword: 'a-new-password' })
  })
})

// Google can offer every account signed in to the browser, and picking another
// one switched the browser to it (or created it) instead of confirming.
// AuthCallback now sends a wrong account back here with ?confirm=wrong-account.
describe('Settings: Confirm with Google names the account', () => {
  test('asks Google for the account by its own Google address and notes the account to expect back', async () => {
    auth.user.authProvider = 'google'
    auth.supabaseUser = { identities: [{ provider: 'google', identity_data: { email: 'pete.google@gmail.com' } }] }
    mocks.signInWithGoogle.mockResolvedValue({})
    renderSettings()
    const accountForm = screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement
    fireEvent.click(within(accountForm).getByRole('button', { name: 'Confirm with Google' }))

    await waitFor(() => expect(mocks.signInWithGoogle).toHaveBeenCalledWith({ loginHint: 'pete.google@gmail.com' }))
    expect(JSON.parse(sessionStorage.getItem('googleConfirm') as string)).toMatchObject({
      email: 'student@example.edu',
      forDelete: false,
    })
  })

  test('says a different Google account confirmed nothing', () => {
    auth.user.authProvider = 'google'
    renderSettings('/settings?confirm=wrong-account')
    expect(screen.getByText(/That was a different Google account, so nothing was confirmed\./)).toBeInTheDocument()
    expect(screen.queryByText(/Google confirmed it/)).toBeNull()
  })

  test('from the delete card, says so in that card and puts its Confirm with Google in focus', () => {
    auth.user.authProvider = 'google'
    renderSettings('/settings?confirm=wrong-account&for=delete')
    const deleteForm = screen.getByRole('button', { name: 'Delete my account' }).closest('form') as HTMLFormElement
    expect(within(deleteForm).getByText(/That was a different Google account, so nothing was confirmed\./)).toBeInTheDocument()
    expect(within(deleteForm).getByRole('button', { name: 'Confirm with Google' })).toHaveFocus()
  })
})

// A Google account has no password, so the password box blocked deletion.
describe('Settings: delete a Google account', () => {
  test('offers Confirm with Google instead of a password, returning to Settings', async () => {
    auth.user.authProvider = 'google'
    mocks.signInWithGoogle.mockResolvedValue({})
    renderSettings()

    expect(screen.queryByLabelText('Password')).toBeNull()
    const deleteForm = screen.getByRole('button', { name: 'Delete my account' }).closest('form') as HTMLFormElement
    fireEvent.click(within(deleteForm).getByRole('button', { name: 'Confirm with Google' }))

    await waitFor(() => expect(mocks.signInWithGoogle).toHaveBeenCalled())
    expect(sessionStorage.getItem('postAuthNext')).toBe('/settings?confirmed=google&for=delete')
    // Google is asked for the account signed in here, by its login email when
    // Supabase has no Google address for it.
    expect(mocks.signInWithGoogle).toHaveBeenCalledWith({ loginHint: 'student@example.edu' })
    // The server is told first, so it counts the Google sign-in that follows.
    const askedAt = mocks.authRequest.mock.calls.findIndex(([url]) => url === '/api/me/provider-confirm')
    expect(mocks.authRequest.mock.calls[askedAt][1]).toEqual({ method: 'POST' })
    expect(mocks.authRequest.mock.invocationCallOrder[askedAt]).toBeLessThan(mocks.signInWithGoogle.mock.invocationCallOrder[0])
  })

  test('does not leave for Google when the server cannot start the confirmation', async () => {
    auth.user.authProvider = 'google'
    mocks.authRequest.mockImplementation(async (url: string) => {
      if (url === '/api/me/provider-confirm') throw new Error('nope')
      return { feedUrl: null }
    })
    renderSettings()
    const deleteForm = screen.getByRole('button', { name: 'Delete my account' }).closest('form') as HTMLFormElement
    fireEvent.click(within(deleteForm).getByRole('button', { name: 'Confirm with Google' }))

    expect(await within(deleteForm).findByRole('alert')).toHaveTextContent('Google sign-in could not be started. Please try again.')
    expect(mocks.signInWithGoogle).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('postAuthNext')).toBeNull()
  })

  test('after the Google confirmation, DELETE alone deletes the account', async () => {
    auth.user.authProvider = 'google'
    renderSettings('/settings?confirmed=google&for=delete')

    const deleteForm = screen.getByRole('button', { name: 'Delete my account' }).closest('form') as HTMLFormElement
    expect(within(deleteForm).getByText(/Google confirmed it's you/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }))

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/'))
    expect(mocks.authRequest).toHaveBeenCalledWith('/api/me/delete-account', {
      method: 'POST',
      body: JSON.stringify({ confirmation: 'DELETE' }),
    })
  })
})
