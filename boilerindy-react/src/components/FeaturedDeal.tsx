import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from './Icons'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'

type Deal = {
  featured?: boolean
  businessName?: string
  description?: string
  [key: string]: unknown
}

// Featured-deal banner for the Home dashboard (issue #24). Renders nothing when
// there is no featured deal (or the deals table is missing), so it is safe to
// always mount at the top of Home.
export default function FeaturedDeal() {
  const [deal, setDeal] = useState<Deal | null>(null)

  useEffect(() => {
    let active = true
    authRequest('/api/deals')
      .then((data) => {
        if (!active) return
        const payload = data as { deals?: Deal[] } | null
        const deals = Array.isArray(payload?.deals) ? payload.deals : []
        setDeal(deals.find((d) => d.featured) || null)
      })
      .catch(() => {
        /* optional UI - ignore failures (e.g. table not migrated yet) */
      })
    return () => {
      active = false
    }
  }, [])

  if (!deal) return null

  return (
    <Link
      to="/perks"
      onClick={() => track('deal_clicked')}
      className="card r-ink block mb-6 px-4 py-3 no-underline"
    >
      <div className="flex items-center gap-3">
        <div className="route-badge">
          <Icon name="sparkles" size={16} />
        </div>
        <div className="min-w-0">
          <div className="font-display text-[11px] font-extrabold text-[var(--color-txt-2)] uppercase tracking-[0.12em]">Featured perk</div>
          <div className="font-display text-[15px] font-bold text-[var(--color-txt-0)] truncate mt-0.5">
            {deal.businessName}
            {deal.description ? <span className="text-[var(--color-txt-2)] font-normal"> - {deal.description}</span> : null}
          </div>
        </div>
        <Icon name="chevronRight" size={16} className="text-[var(--color-txt-3)] ml-auto shrink-0" />
      </div>
    </Link>
  )
}
