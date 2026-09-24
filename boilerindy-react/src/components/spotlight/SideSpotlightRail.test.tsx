import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import SideSpotlightRail from './SideSpotlightRail'
import { getActiveAds } from '../../lib/spotlightApi'

// Issue #246 - AppLayout mounts the rails outside RequireAuth, so a signed-out
// visit to an app route used to send two GET /api/spotlight/active requests
// that answered 401 before the redirect to /login. The rails now wait for the
// session: no user, no fetch, no aside.

const auth = vi.hoisted(() => ({
  current: { user: null as { id: string } | null, loading: false },
}))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth.current }))
vi.mock('../../lib/spotlightApi', () => ({
  getActiveAds: vi.fn().mockResolvedValue([]),
  trackAdEvent: vi.fn(),
}))

const AD = { campaignId: 'camp-1', headline: 'Sponsor one', imageUrl: 'https://img.example/one.jpg' }

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(getActiveAds).mockReset()
  vi.mocked(getActiveAds).mockResolvedValue([])
})

describe('SideSpotlightRail', () => {
  test('fetches nothing and renders nothing while signed out', () => {
    auth.current = { user: null, loading: false }
    const { container } = render(<SideSpotlightRail side="left" />)
    expect(getActiveAds).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  test('fetches nothing while the session is still loading', () => {
    auth.current = { user: null, loading: true }
    const { container } = render(<SideSpotlightRail side="right" />)
    expect(getActiveAds).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  test('fetches the side-rail pool once the session resolves with a user', async () => {
    auth.current = { user: { id: 'u1' }, loading: false }
    vi.mocked(getActiveAds).mockResolvedValue([AD])
    render(<SideSpotlightRail side="left" />)
    await waitFor(() => expect(getActiveAds).toHaveBeenCalledTimes(1))
    expect(getActiveAds).toHaveBeenCalledWith('side-rail', 10)
    await screen.findByRole('complementary', { name: 'left sponsor banner' })
  })

  test('drops the pool on sign-out instead of showing a stale sponsor', async () => {
    auth.current = { user: { id: 'u1' }, loading: false }
    vi.mocked(getActiveAds).mockResolvedValue([AD])
    const { container, rerender } = render(<SideSpotlightRail side="left" />)
    await screen.findByRole('complementary', { name: 'left sponsor banner' })

    auth.current = { user: null, loading: false }
    rerender(<SideSpotlightRail side="left" />)
    expect(container).toBeEmptyDOMElement()
    expect(getActiveAds).toHaveBeenCalledTimes(1)
  })
})
