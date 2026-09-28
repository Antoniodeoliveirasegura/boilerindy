import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PurdueEmailVerification from './PurdueEmailVerification'
import { authRequest } from '../lib/authApi'

// Issue #181: the Purdue email card, one test per state: the address, the
// code step with its resend countdown, a wrong code, an expired code, a
// failed delivery, and the verified link, plus a code picked up again after a
// reload, an address that was already linked, the server's cooldown, and the
// development link.

const auth = vi.hoisted(() => ({ user: { id: 'u1' }, refreshSession: vi.fn() }))
vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

const EMAIL = 'jdoe@purdue.edu'
const UNSENT = 'We could not send the code right now. Please try again in a few minutes.'

type Answer = unknown | (() => unknown)
let answers: Record<string, Answer[]>
let status: unknown
let client: QueryClient

function refusal(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status, ...extra } } })
}

function queue(path: string, ...next: Answer[]) {
  answers[path] = [...(answers[path] || []), ...next]
}

function bodiesSentTo(path: string) {
  return vi
    .mocked(authRequest)
    .mock.calls.filter(([p]) => p === path)
    .map(([, options]) => JSON.parse(String(options?.body)))
}

beforeEach(() => {
  answers = {}
  status = { linked: false, purdueEmail: null, pending: null }
  auth.refreshSession.mockReset().mockResolvedValue(null)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path === '/api/me/purdue-email/status') return status
      const next = answers[String(path)]?.shift()
      if (next === undefined) throw new Error(`unexpected ${path}`)
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next() : next
    })
})

afterEach(() => {
  vi.useRealTimers()
})

function renderCard(props: { allowDevLink?: boolean; onLinked?: (email: string) => void } = {}) {
  return render(
    <QueryClientProvider client={client}>
      <PurdueEmailVerification {...props} />
    </QueryClientProvider>,
  )
}

async function requestCode(email = EMAIL) {
  fireEvent.change(await screen.findByLabelText('Purdue email address'), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
}

const sent = { ok: true, email: EMAIL, expiresAt: '2026-09-28T12:10:00.000Z', cooldownSeconds: 60 }

describe('PurdueEmailVerification', () => {
  it('asks for the address, then shows where the code went, with the resend countdown', async () => {
    queue('/api/me/purdue-email/request', sent)
    renderCard()
    await requestCode('  JDoe@Purdue.edu ')
    expect(await screen.findByText(/We sent a 6-digit code to/)).toHaveTextContent(`We sent a 6-digit code to ${EMAIL}. It expires in 10 minutes.`)
    expect(bodiesSentTo('/api/me/purdue-email/request')).toEqual([{ email: 'JDoe@Purdue.edu' }])
    expect(screen.getByLabelText('Verification code')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send a new code in 1:00' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Verify code' })).toBeDisabled()
  })

  it('lets a new code be sent once the minute is up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    queue('/api/me/purdue-email/request', sent, sent)
    renderCard()
    await requestCode()
    await screen.findByRole('button', { name: /Send a new code in/ })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    const resend = screen.getByRole('button', { name: 'Send a new code' })
    expect(resend).toBeEnabled()
    fireEvent.click(resend)
    await waitFor(() => expect(bodiesSentTo('/api/me/purdue-email/request')).toHaveLength(2))
    expect(bodiesSentTo('/api/me/purdue-email/request')[1]).toEqual({ email: EMAIL })
  })

  it('shows a wrong code as the server words it and keeps the code step', async () => {
    queue('/api/me/purdue-email/request', sent)
    queue('/api/me/purdue-email/verify', refusal(400, 'That code is not right.'))
    renderCard()
    await requestCode()
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '000 000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.')
    expect(bodiesSentTo('/api/me/purdue-email/verify')).toEqual([{ code: '000000' }])
    expect(screen.getByLabelText('Verification code')).toHaveValue('')
    expect(auth.refreshSession).not.toHaveBeenCalled()
  })

  it('says an expired code has expired, and offers a new one', async () => {
    status = { linked: false, purdueEmail: null, pending: { email: EMAIL, expiresAt: '2026-09-28T12:10:00.000Z', attemptsLeft: 5 } }
    queue('/api/me/purdue-email/verify', refusal(400, 'That code has expired. Request a new one.'))
    queue('/api/me/purdue-email/request', sent)
    renderCard()
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That code has expired. Request a new one.')
    fireEvent.click(screen.getByRole('button', { name: 'Send a new code' }))
    await waitFor(() => expect(bodiesSentTo('/api/me/purdue-email/request')).toEqual([{ email: EMAIL }]))
    expect(await screen.findByRole('button', { name: 'Send a new code in 1:00' })).toBeDisabled()
  })

  it('shows a failed delivery in the server\'s words and lets the student try again', async () => {
    queue('/api/me/purdue-email/request', refusal(503, UNSENT), sent)
    renderCard()
    await requestCode()
    expect(await screen.findByRole('alert')).toHaveTextContent(UNSENT)
    expect(screen.getByLabelText('Purdue email address')).toHaveValue(EMAIL)
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect(await screen.findByText(/We sent a 6-digit code to/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('links the address on the right code, refreshing the session and the per-user queries', async () => {
    const onLinked = vi.fn()
    queue('/api/me/purdue-email/request', sent)
    queue('/api/me/purdue-email/verify', { ok: true, purdueEmail: EMAIL })
    client.setQueryData(['me', 'u1', 'calendar'], { items: [] })
    renderCard({ onLinked })
    await requestCode()
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }))
    expect(await screen.findByRole('status')).toHaveTextContent(`Verified. ${EMAIL} is linked to your account.`)
    expect(bodiesSentTo('/api/me/purdue-email/verify')).toEqual([{ code: '123456' }])
    expect(auth.refreshSession).toHaveBeenCalledTimes(1)
    expect(onLinked).toHaveBeenCalledWith(EMAIL)
    expect(client.getQueryState(['me', 'u1', 'calendar'])?.isInvalidated).toBe(true)
  })

  it('picks up a code sent before a reload, and can switch to another address', async () => {
    status = { linked: false, purdueEmail: null, pending: { email: EMAIL, expiresAt: '2026-09-28T12:10:00.000Z', attemptsLeft: 3 } }
    renderCard()
    expect(await screen.findByText(/We sent a 6-digit code to/)).toHaveTextContent(EMAIL)
    fireEvent.click(screen.getByRole('button', { name: 'Use a different address' }))
    expect(screen.getByLabelText('Purdue email address')).toHaveValue(EMAIL)
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument()
  })

  it('treats an address the profile already holds as linked', async () => {
    queue('/api/me/purdue-email/request', { ok: true, alreadyLinked: true })
    renderCard()
    await requestCode()
    expect(await screen.findByRole('status')).toHaveTextContent(`Verified. ${EMAIL} is linked to your account.`)
    expect(auth.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('waits out the server\'s cooldown before sending again', async () => {
    queue(
      '/api/me/purdue-email/request',
      refusal(429, 'Please wait a minute before requesting another code.', { retryAfterSeconds: 42 }),
    )
    renderCard()
    await requestCode()
    expect(await screen.findByRole('alert')).toHaveTextContent('Please wait a minute before requesting another code.')
    expect(screen.getByRole('button', { name: 'Send code in 0:42' })).toBeDisabled()
  })

  it('offers the development link only when asked to, and it links through the mock', async () => {
    queue('/api/purdue/mock-link', { ok: true })
    const { unmount } = renderCard()
    await screen.findByLabelText('Purdue email address')
    expect(screen.queryByRole('button', { name: 'Link without a code (development)' })).not.toBeInTheDocument()
    unmount()

    renderCard({ allowDevLink: true })
    fireEvent.change(await screen.findByLabelText('Purdue email address'), { target: { value: EMAIL } })
    fireEvent.click(screen.getByRole('button', { name: 'Link without a code (development)' }))
    expect(await screen.findByRole('status')).toHaveTextContent(`Verified. ${EMAIL} is linked to your account.`)
    expect(bodiesSentTo('/api/purdue/mock-link')).toEqual([{ email: EMAIL }])
    expect(bodiesSentTo('/api/me/purdue-email/request')).toEqual([])
  })
})
