import { useEffect, useMemo, useState } from 'react'
import Icon from '../Icons'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'

const PHOTO_INTERVAL_MS = 4500

/**
 * Shared sponsor banner: photo carousel, headline/body, click-through to website.
 * @param {'compact'|'rail'} variant compact = home widget, rail = side column
 */
export default function SpotlightCard({ ad, variant = 'compact', onTap, className = '' }) {
  const reducedMotion = usePrefersReducedMotion()
  const photos = useMemo(() => {
    const urls = ad?.imageUrls?.length ? ad.imageUrls : (ad?.imageUrl ? [ad.imageUrl] : [])
    return urls.filter(Boolean)
  }, [ad])
  const [photoIndex, setPhotoIndex] = useState(0)

  useEffect(() => {
    setPhotoIndex(0)
  }, [ad?.campaignId])

  useEffect(() => {
    if (reducedMotion || photos.length <= 1) return undefined
    const timer = window.setInterval(() => {
      setPhotoIndex((i) => (i + 1) % photos.length)
    }, PHOTO_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [photos.length, reducedMotion, ad?.campaignId])

  if (!ad) return null

  const hasLink = Boolean(ad.ctaUrl)
  const isRail = variant === 'rail'
  const imageHeight = isRail ? 'h-[220px]' : 'h-36'

  const body = (
    <>
      {!isRail && (
        <div className="flex items-center gap-2 mb-3">
          <Icon name="briefcase" size={13} className="text-[var(--color-txt-3)]" />
          <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Sponsored</span>
        </div>
      )}

      {photos.length > 0 && (
        <div className={`relative ${imageHeight} rounded-xl overflow-hidden mb-3 border border-[var(--color-border)] bg-[var(--color-bg-2)]`}>
          <img
            src={photos[photoIndex]}
            alt={ad.headline || 'Sponsor'}
            className="w-full h-full object-cover"
            loading="lazy"
          />
          {photos.length > 1 && (
            <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
              {photos.map((_, idx) => (
                <span
                  key={idx}
                  className={`h-1.5 rounded-full transition-all ${idx === photoIndex ? 'w-4 bg-white' : 'w-1.5 bg-white/50'}`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {isRail && (
        <div className="text-[10px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-1.5">Sponsored</div>
      )}

      {ad.headline && (
        <h3 className={`font-bold tracking-tight text-[var(--color-txt-0)] ${isRail ? 'text-[13px] leading-snug' : 'text-[14px]'}`}>
          {ad.headline}
        </h3>
      )}
      {ad.body && (
        <p className={`text-[var(--color-txt-1)] mt-1 leading-relaxed ${isRail ? 'text-[11px] line-clamp-4' : 'text-[13px]'}`}>
          {ad.body}
        </p>
      )}

      {hasLink && (
        <span className={`inline-flex items-center gap-1.5 font-semibold text-[var(--color-accent)] mt-2 ${isRail ? 'text-[11px]' : 'text-[12px]'}`}>
          {ad.ctaLabel || 'Visit website'}
          <Icon name="arrowUpRight" size={12} />
        </span>
      )}
    </>
  )

  const shellCls = isRail
    ? `block rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm ${className}`
    : `card p-4 block no-underline border-[var(--color-border)] ${className}`

  if (hasLink) {
    return (
      <a
        href={ad.ctaUrl}
        target="_blank"
        rel="noopener noreferrer sponsored"
        onClick={onTap}
        className={`${shellCls} hover:border-[var(--color-gold)]/40 transition-colors`}
      >
        {body}
      </a>
    )
  }

  return <div className={shellCls}>{body}</div>
}
