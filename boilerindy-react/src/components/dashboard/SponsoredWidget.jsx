import { useEffect, useRef, useState } from 'react'
import Icon from '../Icons'
import { getActiveAd, trackAdEvent } from '../../lib/spotlightApi'

// Sponsored ad slot on the student home dashboard (advertiser-portal M3).
// Fetches one active campaign for the home-widget placement, logs an impression
// once on load, and logs a tap when the student clicks through. Renders nothing
// when there's no active ad, so the slot simply disappears (like smart-alerts).

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

  const handleTap = () => {
    trackAdEvent(ad.campaignId, 'tap')
  }

  const hasLink = Boolean(ad.ctaUrl)

  const body = (
    <>
      <div className="flex items-center gap-2 mb-3">
        <Icon name="briefcase" size={13} className="text-[var(--color-txt-3)]" />
        <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Sponsored</span>
      </div>

      {ad.imageUrl && (
        <img
          src={ad.imageUrl}
          alt=""
          className="w-full h-28 object-cover rounded-lg mb-3 border border-[var(--color-border)]"
          loading="lazy"
        />
      )}

      {ad.headline && <h3 className="text-[14px] font-bold tracking-tight text-[var(--color-txt-0)]">{ad.headline}</h3>}
      {ad.body && <p className="text-[13px] text-[var(--color-txt-1)] mt-1 leading-relaxed">{ad.body}</p>}

      {hasLink && (
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-accent)] mt-3">
          {ad.ctaLabel || 'Learn more'}
          <Icon name="arrowUpRight" size={13} />
        </span>
      )}
    </>
  )

  // The whole card is the click target when there's a CTA URL. External link →
  // always rel="noopener noreferrer"; the served URL is http/https-validated.
  if (hasLink) {
    return (
      <a
        href={ad.ctaUrl}
        target="_blank"
        rel="noopener noreferrer sponsored"
        onClick={handleTap}
        className="card p-4 block no-underline border-[var(--color-border)] hover:border-[var(--color-gold)]/40 transition-colors"
      >
        {body}
      </a>
    )
  }

  return <div className="card p-4 border-[var(--color-border)]">{body}</div>
}
