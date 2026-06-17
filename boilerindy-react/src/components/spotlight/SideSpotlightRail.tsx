import { useEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'
import { getActiveAds, trackAdEvent } from '../../lib/spotlightApi'
import SpotlightCard, { type SpotlightAd } from './SpotlightCard'

const SPONSOR_ROTATE_MS = 8000

/**
 * Sticky side-column sponsor banners for xl+ viewports. Left and right rails
 * show different sponsors when possible and rotate through the pool.
 */
export default function SideSpotlightRail({ side = 'left' }: { side?: 'left' | 'right' }) {
  const reducedMotion = usePrefersReducedMotion()
  const [ads, setAds] = useState<SpotlightAd[]>([])
  const [rotateIndex, setRotateIndex] = useState(0)
  const impressionRef = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    getActiveAds('side-rail', 10).then((list) => {
      if (active) setAds(list as SpotlightAd[])
    })
    return () => {
      active = false
    }
  }, [])

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
