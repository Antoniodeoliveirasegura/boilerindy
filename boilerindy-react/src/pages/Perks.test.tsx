import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Perks from './Perks'
import { authRequest } from '../lib/authApi'

// A deal's expiry is a day on campus: validateDealInput stores a picked day as
// 23:59 that day in Indianapolis. The card used to read the stored instant in
// the browser's zone and the edit form took its UTC date, so the card and the
// form could name different days.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'admin-1', isAdmin: true } }) }))

// What the server stores for an expiry of Oct 31, 2026: 23:59 EDT.
const OCT_31_ON_CAMPUS = '2026-11-01T03:59:00.000Z'

beforeEach(() => {
  vi.mocked(authRequest)
    .mockReset()
    .mockResolvedValue({
      deals: [{ id: 'deal-1', businessName: 'Bean Counter Cafe', category: 'coffee', expiresAt: OCT_31_ON_CAMPUS, active: true }],
    })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Perks expiry', () => {
  it.each(['America/Indiana/Indianapolis', 'Asia/Seoul'])(
    'names the picked day on the card and in the edit form, with the browser in %s',
    async (zone) => {
      vi.stubEnv('TZ', zone)
      render(<Perks />)
      // Oct 31, 2026 the way this browser writes a date.
      const oct31 = new Date(2026, 9, 31).toLocaleDateString()
      expect(await screen.findByText(`Expires ${oct31}`)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      expect(screen.getByDisplayValue('2026-10-31')).toBeInTheDocument()
    },
  )
})
