import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Dining from './Dining'
import { authRequest } from '../lib/authApi'

// Issue #202: starring a dish past the 300-favorite cap (409) or the
// user-write limiter (429) rolled the star back with no word of why. The
// rollback stays (favorites have no device-only copy) and the page now says
// what happened: the server's message for a refusal, a generic line otherwise.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

const CAPPED = 'You can save up to 300 favorites. Remove some to add more.'
const LIMITED = 'You are making changes too quickly. Please wait a moment and try again.'

const snapshot = {
  ok: true,
  date: '2026-09-09',
  weekday: 'Wednesday',
  cached: false,
  stale: false,
  locations: [
    {
      id: 'tower-dining',
      slug: 'tower-dining',
      name: 'Tower Dining',
      kind: 'dining-hall',
      address: 'University Tower, 911 W North St, Indianapolis, IN 46202',
      is_open: true,
      hours: '7:00 AM - 9:00 PM',
      closes_at: '9:00 PM',
      opens_at: null,
      open24h: false,
      meal: 'Menus: breakfast, lunch, dinner',
      menusPublished: true,
      stations: [{ name: 'Daily Grill', items: [{ name: 'Veggie Burger', calories: 160, icons: [] }] }],
    },
  ],
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
}

let nextWrite: unknown = null

beforeEach(() => {
  nextWrite = null
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(snapshot)))
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (_path, options) => {
      if (!options?.method) return { favorites: [] }
      if (nextWrite) {
        const error = nextWrite
        nextWrite = null
        throw error
      }
      return { ok: true }
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function star() {
  return screen.findByRole('button', { name: /Veggie Burger/ })
}

it.each([
  [409, CAPPED],
  [429, LIMITED],
])('a %i on starring a dish rolls the star back and shows the message', async (status, message) => {
  render(<Dining />)
  nextWrite = httpError(status, message)

  fireEvent.click(await star())
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(await star()).toHaveAttribute('aria-pressed', 'false')

  // The next toggle clears the notice and saves.
  fireEvent.click(await star())
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(await star()).toHaveAttribute('aria-pressed', 'true')
})

it('a network error on starring a dish rolls it back with a generic message', async () => {
  render(<Dining />)
  nextWrite = new TypeError('Failed to fetch')

  fireEvent.click(await star())
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save that favorite. Please try again.')
  expect(await star()).toHaveAttribute('aria-pressed', 'false')
})
