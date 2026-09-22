import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import StudyGroups from './StudyGroups'
import { authRequest } from '../lib/authApi'

// Issue #202: PATCH /api/me/study-groups/opt-in shares the user-write bucket.
// A 429 left the button unchanged with no explanation; the page now says why.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'

let nextWrite: unknown = null

beforeEach(() => {
  nextWrite = null
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (options?.method === 'PATCH') {
        if (nextWrite) {
          const error = nextWrite
          nextWrite = null
          throw error
        }
        return { optIn: JSON.parse(String(options.body)).optIn }
      }
      if (path === '/api/me/study-groups/courses') return { optIn: false, courses: [] }
      return { groups: [] }
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('a 429 on the opt-in toggle keeps the setting and shows the message until the next try', async () => {
  render(<StudyGroups />)
  const toggle = await screen.findByRole('button', { name: 'Opt in' })
  nextWrite = Object.assign(new Error(LIMITED), { status: 429, payload: { error: { message: LIMITED, status: 429 } } })

  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent(LIMITED)
  expect(toggle).toHaveAttribute('aria-pressed', 'false')

  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
