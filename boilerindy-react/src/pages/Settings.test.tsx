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
    <MemoryRouter initialEntries={[path]}>
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
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
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

// A Google account has no password, so the password box blocked deletion.
describe('Settings: delete a Google account', () => {
  test('offers Confirm with Google instead of a password, returning to Settings', async () => {
    auth.user.authProvider = 'google'
    mocks.signInWithGoogle.mockResolvedValue({})
    renderSettings()

    expect(screen.queryByLabelText('Password')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm with Google' }))

    await waitFor(() => expect(mocks.signInWithGoogle).toHaveBeenCalled())
    expect(sessionStorage.getItem('postAuthNext')).toBe('/settings?delete=confirmed')
  })

  test('after the Google confirmation, DELETE alone deletes the account', async () => {
    auth.user.authProvider = 'google'
    renderSettings('/settings?delete=confirmed')

    expect(screen.getByText(/Google confirmed it's you/)).toBeInTheDocument()
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
