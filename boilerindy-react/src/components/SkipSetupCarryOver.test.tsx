import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import SkipSetupCarryOver from './SkipSetupCarryOver'
import { calendarRemindersOff, setSkipSetup } from '../lib/authApi'

// Antoniodeoliveirasegura/boilerindy-app#150: a "Don't ask again" this browser
// saved before the account kept the choice is sent to the account, once.

type User = { id: string; calendarRemindersOff?: boolean }
const auth = vi.hoisted(() => ({
  user: null as User | null,
  refreshSession: vi.fn(),
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>
const patches = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/me/profile' && init?.method === 'PATCH')

beforeEach(() => {
  localStorage.clear()
  auth.user = null
  auth.refreshSession.mockReset().mockResolvedValue(null)
  fetchMock = vi.fn(async () => jsonResponse(200, { user: { id: 'u1', calendarRemindersOff: true } }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('sends the browser choice to an account with reminders on, then re-reads the session', async () => {
  setSkipSetup(true)
  auth.user = { id: 'u1', calendarRemindersOff: false }
  const { rerender } = render(<SkipSetupCarryOver />)
  await waitFor(() => expect(auth.refreshSession).toHaveBeenCalledTimes(1))
  expect(patches()).toHaveLength(1)
  expect(JSON.parse(patches()[0][1].body as string)).toEqual({ calendarRemindersOff: true })

  // The account has it now: a session read that has not caught up sends nothing more.
  auth.user = { id: 'u1', calendarRemindersOff: false }
  rerender(<SkipSetupCarryOver />)
  auth.user = { id: 'u1', calendarRemindersOff: true }
  rerender(<SkipSetupCarryOver />)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(patches()).toHaveLength(1)
})

test('tries once per page load while the account cannot take it, and the browser choice keeps standing in', async () => {
  fetchMock.mockImplementation(async () =>
    jsonResponse(503, {
      error: { message: 'Not set up yet.', code: 'calendar_reminders_schema_missing', status: 503 },
    }),
  )
  setSkipSetup(true)
  auth.user = { id: 'u1', calendarRemindersOff: false }
  const { rerender, unmount } = render(<SkipSetupCarryOver />)
  await waitFor(() => expect(patches()).toHaveLength(1))
  auth.user = { id: 'u1', calendarRemindersOff: false }
  rerender(<SkipSetupCarryOver />)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(patches()).toHaveLength(1)
  expect(auth.refreshSession).not.toHaveBeenCalled()
  expect(calendarRemindersOff(auth.user)).toBe(true)

  // The next visit tries again.
  unmount()
  render(<SkipSetupCarryOver />)
  await waitFor(() => expect(patches()).toHaveLength(2))
})

test('sends nothing signed out, without a browser choice, before the API has the flag, or when the account has it', async () => {
  setSkipSetup(true)
  const { rerender } = render(<SkipSetupCarryOver />)
  auth.user = { id: 'u1' }
  rerender(<SkipSetupCarryOver />)
  auth.user = { id: 'u1', calendarRemindersOff: true }
  rerender(<SkipSetupCarryOver />)
  // Turned back on in the app afterwards: that wins over this browser's old flag.
  auth.user = { id: 'u1', calendarRemindersOff: false }
  rerender(<SkipSetupCarryOver />)

  localStorage.clear()
  auth.user = { id: 'u2', calendarRemindersOff: false }
  rerender(<SkipSetupCarryOver />)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fetchMock).not.toHaveBeenCalled()
})
