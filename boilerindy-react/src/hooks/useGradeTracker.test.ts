import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useGradeTracker } from './useGradeTracker'
import { authRequest } from '../lib/authApi'

// Issue #202: a refused grade write (the 500-course cap's 409, the user-write
// limiter's 429) used to leave the optimistic row in the list and the cache
// under a temp id, so the GPA counted a course the account never got and its
// later edits and deletes skipped the server. A refusal now undoes the change
// and reports the server's message; a request with no response still keeps
// the local copy.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))

const CAPPED = 'You can track up to 500 courses. Remove some to add more.'
const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'
const CACHE_KEY = 'boilerindy-grades-v1-user-1'
const saved = { id: 'grade-1', courseName: 'CS 18000', term: 'Fall 2025', creditHours: 4, letterGrade: 'A' }

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
}

let nextWrite: unknown = null
// When set, writes wait here until a test settles them, so requests can overlap.
let held: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] | null = null

beforeEach(() => {
  localStorage.clear()
  nextWrite = null
  held = null
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (_path, options) => {
      if (!options?.method) return { grades: [saved] }
      if (held) {
        const queue = held
        return new Promise((resolve, reject) => queue.push({ resolve, reject }))
      }
      if (nextWrite) {
        const error = nextWrite
        nextWrite = null
        throw error
      }
      if (options.method === 'POST') return { grade: { ...JSON.parse(String(options.body)), id: 'grade-2' } }
      return { ok: true }
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function renderTracker() {
  const hook = renderHook(() => useGradeTracker('user-1'))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

function cachedNames() {
  return (JSON.parse(localStorage.getItem(CACHE_KEY) || '[]') as { courseName: string }[]).map((g) => g.courseName)
}

it.each([
  [409, CAPPED],
  [429, LIMITED],
])('a %i on adding a course removes the optimistic row and reports the message', async (status, message) => {
  const { result } = await renderTracker()
  nextWrite = httpError(status, message)

  let ok = true
  await act(async () => {
    ok = await result.current.addGrade({ courseName: 'MA 26100', letterGrade: 'B' })
  })

  expect(ok).toBe(false)
  expect(result.current.error).toBe(message)
  expect(result.current.grades.map((g) => g.courseName)).toEqual(['CS 18000'])
  expect(cachedNames()).toEqual(['CS 18000'])
})

it('a 429 on editing a course puts the saved row back', async () => {
  const { result } = await renderTracker()
  nextWrite = httpError(429, LIMITED)

  let ok = true
  await act(async () => {
    ok = await result.current.updateGrade('grade-1', { letterGrade: 'C' })
  })

  expect(ok).toBe(false)
  expect(result.current.error).toBe(LIMITED)
  expect(result.current.grades).toEqual([saved])
})

it('a 429 on deleting a course puts it back', async () => {
  const { result } = await renderTracker()
  nextWrite = httpError(429, LIMITED)

  await act(async () => {
    await result.current.deleteGrade('grade-1')
  })

  expect(result.current.error).toBe(LIMITED)
  expect(result.current.grades).toEqual([saved])
  expect(cachedNames()).toEqual(['CS 18000'])
})

it('a network error on adding a course still keeps it on this device', async () => {
  const { result } = await renderTracker()
  nextWrite = new TypeError('Failed to fetch')

  let ok = false
  await act(async () => {
    ok = await result.current.addGrade({ courseName: 'MA 26100', letterGrade: 'B' })
  })

  expect(ok).toBe(true)
  expect(result.current.error).toBe('Failed to fetch')
  expect(result.current.grades.map((g) => g.courseName)).toEqual(['CS 18000', 'MA 26100'])
  expect(cachedNames()).toEqual(['CS 18000', 'MA 26100'])
})

// Overlapping writes (a burst of clicks at the limit): an undo must apply to
// the list as it is when the refusal lands, not to a copy from click time.

const second = { id: 'grade-2', courseName: 'MA 26100', term: 'Other', creditHours: 3, letterGrade: 'B' }

it('an accepted add followed by a refused overlapping add keeps the saved row', async () => {
  const { result } = await renderTracker()
  held = []
  const writes = held
  let first: Promise<boolean> = Promise.resolve(false)
  let refused: Promise<boolean> = Promise.resolve(true)
  act(() => {
    first = result.current.addGrade({ courseName: 'MA 26100', letterGrade: 'B' })
  })
  act(() => {
    refused = result.current.addGrade({ courseName: 'PHYS 17200', letterGrade: 'A' })
  })
  expect(result.current.grades.map((g) => g.courseName)).toEqual(['CS 18000', 'MA 26100', 'PHYS 17200'])

  await act(async () => {
    writes[0].resolve({ grade: second })
    await first
  })
  await act(async () => {
    writes[1].reject(httpError(429, LIMITED))
    await refused
  })

  expect(result.current.grades.map((g) => g.id)).toEqual(['grade-1', 'grade-2'])
  expect(cachedNames()).toEqual(['CS 18000', 'MA 26100'])
  expect(result.current.error).toBe(LIMITED)
})

it('two refused adds of the same course (a double click at the cap) leave no row behind', async () => {
  const { result } = await renderTracker()
  held = []
  const writes = held
  let one: Promise<boolean> = Promise.resolve(true)
  let two: Promise<boolean> = Promise.resolve(true)
  act(() => {
    one = result.current.addGrade({ courseName: 'MA 26100', letterGrade: 'B' })
  })
  act(() => {
    two = result.current.addGrade({ courseName: 'MA 26100', letterGrade: 'B' })
  })

  await act(async () => {
    writes[0].reject(httpError(409, CAPPED))
    await one
  })
  await act(async () => {
    writes[1].reject(httpError(409, CAPPED))
    await two
  })

  expect(result.current.grades.map((g) => g.courseName)).toEqual(['CS 18000'])
  expect(cachedNames()).toEqual(['CS 18000'])
  expect(result.current.error).toBe(CAPPED)
})

it('a refused delete does not bring back a course whose overlapping delete was accepted', async () => {
  const writes: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []
  vi.mocked(authRequest).mockImplementation(async (_path, options) => {
    if (!options?.method) return { grades: [saved, second] }
    return new Promise((resolve, reject) => writes.push({ resolve, reject }))
  })
  const { result } = await renderTracker()
  let refused: Promise<void> = Promise.resolve()
  let accepted: Promise<void> = Promise.resolve()
  act(() => {
    refused = result.current.deleteGrade('grade-1')
  })
  act(() => {
    accepted = result.current.deleteGrade('grade-2')
  })
  expect(result.current.grades).toEqual([])

  await act(async () => {
    writes[1].resolve({ ok: true })
    await accepted
  })
  await act(async () => {
    writes[0].reject(httpError(429, LIMITED))
    await refused
  })

  expect(result.current.grades.map((g) => g.id)).toEqual(['grade-1'])
  expect(cachedNames()).toEqual(['CS 18000'])
})
