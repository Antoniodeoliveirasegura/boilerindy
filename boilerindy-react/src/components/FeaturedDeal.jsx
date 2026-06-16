import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from './Icons'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'

// Featured-deal banner for the Home dashboard (issue #24). Renders nothing when
// there is no featured deal (or the deals table is missing), so it is safe to
// always mount at the top of Home.
export default function FeaturedDeal() {
  const [deal, setDeal] = useState(null)

  useEffect(() => {
    let active = true
    authRequest('/api/deals')
      .then((data) => {
        if (!active) return
        const deals = Array.isArray(data?.deals) ? data.deals : []
        setDeal(deals.find((d) => d.featured) || null)
      })
      .catch(() => {
        /* optional UI — ignore failures (e.g. table not migrated yet) */
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
      className="block mb-6 rounded-2xl border border-[var(--color-gold)]/40 bg-[var(--color-gold)]/5 px-4 py-3 no-underline hover:bg-[var(--color-gold)]/10 transition-colors"
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center shrink-0">
          <Icon name="sparkles" size={16} className="text-[var(--color-gold-dark)]" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-[var(--color-gold-muted)] uppercase tracking-wider">Featured perk</div>
          <div className="text-[14px] font-medium text-[var(--color-txt-0)] truncate">
            {deal.businessName}
            {deal.description ? <span className="text-[var(--color-txt-2)] font-normal"> — {deal.description}</span> : null}
          </div>
        </div>
        <Icon name="chevronRight" size={16} className="text-[var(--color-txt-3)] ml-auto shrink-0" />
      </div>
    </Link>
  )
}
