import { useEffect, useRef, useState } from 'react'
import { getActiveAd, trackAdEvent } from '../../lib/spotlightApi'
import SpotlightCard from '../spotlight/SpotlightCard'

// Sponsored ad slot on the student home dashboard. Renders nothing when no ad
// is active so the widget slot collapses cleanly.

export default function SponsoredWidget() {
  const [ad, setAd] = useState(null)
  const impressionFired = useRef(false)

  useEffect(() => {
    let active = true
    getActiveAd('home-widget').then((served) => {
      if (!active || !served) return
      setAd(served)
      if (!impressionFired.current) {
        impressionFired.current = true
        trackAdEvent(served.campaignId, 'impression')
      }
    })
    return () => {
      active = false
    }
  }, [])

  if (!ad) return null

  return (
    <SpotlightCard
      ad={ad}
      variant="compact"
      onTap={() => trackAdEvent(ad.campaignId, 'tap')}
    />
  )
}
