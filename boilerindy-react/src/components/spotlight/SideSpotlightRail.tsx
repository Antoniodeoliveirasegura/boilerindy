import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'
import { getActiveAds, trackAdEvent } from '../../lib/spotlightApi'
import SpotlightCard, { type SpotlightAd } from './SpotlightCard'

const SPONSOR_ROTATE_MS = 8000
const NO_ADS: SpotlightAd[] = []

// The fetched pool remembers which account it was fetched for, so a sponsor
// loaded for one user never shows for the next one and nothing lingers after
// sign-out.
type RailPool = { userId: string | null; ads: SpotlightAd[] }

/**
 * Sticky side-column sponsor banners for xl+ viewports. Left and right rails
 * show different sponsors when possible and rotate through the pool.
 *
 * AppLayout mounts the rails beside the routed page, outside RequireAuth, and
 * GET /api/spotlight/active needs a session. So the rails wait for the session
 * query: while it is still loading, or when it resolves without a user, they
 * fetch nothing and render nothing (issue #246). Before this a signed-out
 * visit to an app route sent two requests that answered 401 before the
 * redirect to /login.
 */
export default function SideSpotlightRail({ side = 'left' }: { side?: 'left' | 'right' }) {
  const { user, loading } = useAuth()
  const userId = (user?.id as string | undefined) ?? null
  const reducedMotion = usePrefersReducedMotion()
  const [pool, setPool] = useState<RailPool>({ userId: null, ads: NO_ADS })
  const [rotateIndex, setRotateIndex] = useState(0)
  const impressionRef = useRef<string | null>(null)

  useEffect(() => {
    if (loading || !userId) return undefined
    let active = true
    getActiveAds('side-rail', 10).then((list) => {
      if (active) setPool({ userId, ads: list as SpotlightAd[] })
    })
    return () => {
      active = false
    }
  }, [loading, userId])

  const ads = userId && pool.userId === userId ? pool.ads : NO_ADS

  useEffect(() => {
    if (reducedMotion || ads.length <= 1) return undefined
    const timer = window.setInterval(() => {
      setRotateIndex((i) => (i + 1) % ads.length)
    }, SPONSOR_ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [ads.length, reducedMotion])

  const offset = side === 'right' ? 1 : 0
  const currentAd = ads.length > 0 ? ads[(rotateIndex + offset) % ads.length] : null

  useEffect(() => {
    if (!currentAd?.campaignId) return
    if (impressionRef.current === currentAd.campaignId) return
    impressionRef.current = currentAd.campaignId
    trackAdEvent(currentAd.campaignId, 'impression')
  }, [currentAd?.campaignId])

  if (!currentAd) return null

  const positionCls = side === 'left'
    ? 'left-[max(0px,calc((100vw-1100px)/2-220px))]'
    : 'right-[max(0px,calc((100vw-1100px)/2-220px))]'

  return (
    <aside
      className={`hidden xl:block fixed top-24 z-[5] w-[180px] ${positionCls}`}
      aria-label={`${side} sponsor banner`}
    >
      <SpotlightCard
        ad={currentAd}
        variant="rail"
        onTap={() => trackAdEvent(currentAd.campaignId ?? '', 'tap')}
      />
    </aside>
  )
}
