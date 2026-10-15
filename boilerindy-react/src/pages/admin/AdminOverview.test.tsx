import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminOverview from './AdminOverview'

// The Release stuck Purdue link field was named only by its placeholder, so
// a screen reader announced "student@purdue.edu" with no label.

vi.mock('../../lib/adminApi', () => ({
  getAdminOverview: vi.fn(async () => ({ overview: { newLeads: 0, pendingCampaigns: 0, activeCampaigns: 0, advertisers: 0 } })),
  clearAdminPurdueLink: vi.fn(),
}))

afterEach(cleanup)

it('labels the Purdue release email field', async () => {
  render(
    <MemoryRouter>
      <AdminOverview />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('textbox', { name: 'Student Purdue email' })).toHaveAttribute('type', 'email')
})
