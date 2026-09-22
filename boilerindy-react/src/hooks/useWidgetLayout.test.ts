import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useWidgetLayout, type WidgetLayoutEntry } from './useWidgetLayout'
import { authRequest } from '../lib/authApi'

// Issue #202: layout PUTs (home dashboard and Services board) share the
// user-write bucket. A 429 used to be swallowed as "offline", leaving a layout
// on screen and in the cache that the next load silently replaced. A refusal
// now puts back the layout the server last accepted and sets saveError; a
// request with no response still keeps the change for the next PUT to carry.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))

const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'

const serverLayout: WidgetLayoutEntry[] = [
  { id: 'a', visible: true, size: 'md' },
  { id: 'b', visible: true, size: 'md' },
  { id: 'c', visible: true, size: 'md' },
]
const cache = new Map<string, unknown>()
const board = {
  endpoint: '/api/me/dashboard',
  defaultLayout: () => serverLayout,
  normalizeLayout: (input: unknown) => (Array.isArray(input) ? (input as WidgetLayoutEntry[]) : serverLayout),
  loadLocalLayout: () => (cache.get('layout') as WidgetLayoutEntry[] | undefined) ?? null,
  saveLocalLayout: (_userId: unknown, layout: unknown) => void cache.set('layout', layout),
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
}

const order = (layout: WidgetLayoutEntry[]) => layout.map((w) => w.id).join('')

beforeEach(() => {
  cache.clear()
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (_path, options) => (options?.method ? { ok: true } : { layout: serverLayout }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function renderBoard() {
  const hook = renderHook(() => useWidgetLayout({ userId: 'user-1', ...board }))
  await waitFor(() => expect(authRequest).toHaveBeenCalledWith('/api/me/dashboard'))
  return hook
}

it('a 429 on saving a layout puts back the saved layout and reports the message', async () => {
  const { result } = await renderBoard()
  vi.mocked(authRequest).mockRejectedValueOnce(httpError(429, LIMITED))

  act(() => result.current.moveToTop('c'))
  expect(order(result.current.layout)).toBe('cab')

  await waitFor(() => expect(result.current.saveError).toBe(LIMITED))
  expect(order(result.current.layout)).toBe('abc')
  expect(order(cache.get('layout') as WidgetLayoutEntry[])).toBe('abc')

  // The next change clears the message and saves.
  act(() => result.current.moveToTop('b'))
  expect(result.current.saveError).toBe('')
  await waitFor(() => expect(vi.mocked(authRequest).mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(2))
  expect(order(result.current.layout)).toBe('bac')
})

it('restores past a refused move only after a slower accepted one lands', async () => {
  const { result } = await renderBoard()
  let acceptFirst: (value: unknown) => void = () => {}
  vi.mocked(authRequest)
    .mockImplementationOnce(() => new Promise((resolve) => (acceptFirst = resolve)))
    .mockRejectedValueOnce(httpError(429, LIMITED))

  act(() => result.current.moveToTop('c')) // cab, accepted but slow
  act(() => result.current.moveToTop('b')) // bca, refused at once
  await act(async () => {})
  expect(result.current.saveError).toBe('')
  expect(order(result.current.layout)).toBe('bca')

  await act(async () => acceptFirst({ ok: true }))
  await waitFor(() => expect(result.current.saveError).toBe(LIMITED))
  expect(order(result.current.layout)).toBe('cab')
})

it('a network error on saving a layout keeps the change for the next save', async () => {
  const { result } = await renderBoard()
  vi.mocked(authRequest).mockRejectedValueOnce(new TypeError('Failed to fetch'))

  act(() => result.current.moveToTop('c'))
  await act(async () => {})

  expect(result.current.saveError).toBe('')
  expect(order(result.current.layout)).toBe('cab')
  expect(order(cache.get('layout') as WidgetLayoutEntry[])).toBe('cab')
})
