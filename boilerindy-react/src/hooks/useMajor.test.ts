import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useMajor } from './useMajor'
import { authRequest } from '../lib/authApi'

// Issue #202: PUT /api/me/degree shares the user-write bucket. A 429 used to
// be swallowed as "offline": the picker and cache showed the new major until
// the next load quietly put the old one back. A refusal now restores the
// major the server has and sets `error`; no response still keeps the choice.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))

const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'
const CACHE_KEY = 'boilerindy-major-v1-user-1'

beforeEach(() => {
  localStorage.clear()
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (_path, options) => (options?.method ? { major: 'x' } : { major: 'computer-science' }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function renderMajor() {
  const hook = renderHook(() => useMajor('user-1'))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

it('a 429 on saving the major puts back the saved one and reports the message', async () => {
  const { result } = await renderMajor()
  vi.mocked(authRequest).mockRejectedValueOnce(
    Object.assign(new Error(LIMITED), { status: 429, payload: { error: { message: LIMITED, status: 429 } } }),
  )

  act(() => result.current.setMajor('informatics'))
  expect(result.current.major).toBe('informatics')

  await waitFor(() => expect(result.current.error).toBe(LIMITED))
  expect(result.current.major).toBe('computer-science')
  expect(localStorage.getItem(CACHE_KEY)).toBe('computer-science')
})

it('a network error on saving the major keeps the choice on this device', async () => {
  const { result } = await renderMajor()
  vi.mocked(authRequest).mockRejectedValueOnce(new TypeError('Failed to fetch'))

  act(() => result.current.setMajor('informatics'))
  await act(async () => {})

  expect(result.current.error).toBe('')
  expect(result.current.major).toBe('informatics')
  expect(localStorage.getItem(CACHE_KEY)).toBe('informatics')
})
