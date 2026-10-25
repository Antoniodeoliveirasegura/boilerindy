import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminOverview from './AdminOverview'
import { getAdminOverview } from '../../lib/adminApi'

// The Release stuck Purdue link field was named only by its placeholder, so
// a screen reader announced "student@purdue.edu" with no label.

vi.mock('../../lib/adminApi', () => ({
  getAdminOverview: vi.fn(async () => ({ overview: { newLeads: 0, pendingCampaigns: 0, activeCampaigns: 0, advertisers: 0 } })),
  clearAdminPurdueLink: vi.fn(),
}))

afterEach(cleanup)

function renderOverview() {
  return render(
    <MemoryRouter useTransitions={false}>
      <AdminOverview />
    </MemoryRouter>,
  )
}

it('labels the Purdue release email field', async () => {
  renderOverview()
  expect(await screen.findByRole('textbox', { name: 'Student Purdue email' })).toHaveAttribute('type', 'email')
})

// The photo queue (#504): the overview counts listings whose photos wait for
// an admin and links to the queue, and says so when it cannot count them yet.
it('counts the photos waiting for review and links to the queue', async () => {
  vi.mocked(getAdminOverview).mockResolvedValueOnce({
    overview: { newLeads: 0, pendingCampaigns: 0, activeCampaigns: 0, advertisers: 0, pendingPhotos: 3 },
  })
  renderOverview()
  const card = await screen.findByRole('link', { name: /Photos to review/ })
  expect(card).toHaveAttribute('href', '/admin/photos')
  expect(card).toHaveTextContent('3')
  expect(card).toHaveTextContent('Marketplace listings waiting for an admin')
})

it('shows no count while photo review is not set up', async () => {
  vi.mocked(getAdminOverview).mockResolvedValueOnce({
    overview: { newLeads: 0, pendingCampaigns: 0, activeCampaigns: 0, advertisers: 0, pendingPhotos: null },
  })
  renderOverview()
  const card = await screen.findByRole('link', { name: /Photos to review/ })
  expect(card).toHaveTextContent('-')
  expect(card).toHaveTextContent('Photo review is not set up yet')
})
