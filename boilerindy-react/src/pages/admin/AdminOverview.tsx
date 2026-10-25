import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { getAdminOverview, clearAdminPurdueLink } from '../../lib/adminApi'
import { AlertBanner, PageHeader } from './adminShared'
import Icon from '../../components/Icons'
import { useConfirm } from '../../hooks/useConfirm'
import PageTitle from '../../components/PageTitle'

type Overview = {
  newLeads?: number
  pendingCampaigns?: number
  activeCampaigns?: number
  advertisers?: number
  /** Listings whose photos wait in the photo queue (#504); null until README step 46 has run. */
  pendingPhotos?: number | null
}

// A quick-action row: 1px rules between rows and a small square marker in the
// card's route colour, level with the first line of text.
const QUICK_ACTION_ROW =
  'relative pl-5 py-2.5 border-t border-[var(--color-border)] first:border-t-0 first:pt-0 last:pb-0 before:absolute before:left-0 before:top-[15px] first:before:top-[5px] before:w-2 before:h-2 before:rounded-[2px] before:bg-[var(--route)]'

function StatCard({
  label,
  value,
  hint,
  to,
  urgent,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  to?: string
  urgent?: boolean
}) {
  // An amber eyebrow square only while the count is work waiting on an admin.
  const inner = (
    <>
      <div className={`eyebrow items-start min-h-[30px] leading-[1.3] before:mt-[2.5px] ${urgent ? 'signal' : ''}`}>{label}</div>
      <div className="flex items-end justify-between gap-3 mt-4">
        <div className="big-stat">{value}</div>
        {to && <Icon name="arrowUpRight" size={18} className="mb-1 text-[var(--color-txt-3)]" />}
      </div>
      {hint && <div className="text-[12.5px] leading-snug text-[var(--color-txt-2)] mt-2">{hint}</div>}
    </>
  )
  if (to) {
    return (
      <Link to={to} className="card card-pad block h-full no-underline">
        {inner}
      </Link>
    )
  }
  return <div className="card card-pad h-full">{inner}</div>
}

export default function AdminOverview() {
  const { confirm, confirmDialog } = useConfirm()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [purdueReleaseEmail, setPurdueReleaseEmail] = useState('')
  const [releasing, setReleasing] = useState(false)

  useEffect(() => {
    let active = true
    getAdminOverview()
      .then((data) => {
        const d = data as { overview?: Overview }
        if (active) setOverview(d.overview ?? null)
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load overview.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function handleReleasePurdueLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const email = purdueReleaseEmail.trim().toLowerCase()
    if (!email) return
    if (!(await confirm({ title: `Release Purdue link for ${email}?`, message: 'The student can link again after signing out/in.', confirmLabel: 'Release', tone: 'danger' }))) return
    setReleasing(true)
    setError('')
    setSuccess('')
    try {
      const data = (await clearAdminPurdueLink({ purdueEmail: email })) as {
        cleared: { purdueEmail: string }[]
      }
      setSuccess(`Released Purdue link for ${data.cleared.map((r) => r.purdueEmail).join(', ')}.`)
      setPurdueReleaseEmail('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not release Purdue link.')
    } finally {
      setReleasing(false)
    }
  }

  return (
    <div>
      <PageTitle>Admin overview</PageTitle>
      {confirmDialog}
      <PageHeader
        title="Overview"
        description="Monitor marketplace photos waiting for review, advertiser onboarding, campaign approvals, and platform health at a glance."
      />
      <AlertBanner message={error} onDismiss={() => setError('')} />
      <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />

      {loading ? (
        <div className="text-[13.5px] text-[var(--color-txt-2)]">Loading metrics…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 mb-4">
            {/* Student moderation on a row of its own, so the four portal cards keep their layout. */}
            <div className="col-span-2 xl:col-span-4">
              <StatCard
                label="Photos to review"
                value={typeof overview?.pendingPhotos === 'number' ? overview.pendingPhotos : '-'}
                hint={typeof overview?.pendingPhotos === 'number' ? 'Marketplace listings waiting for an admin' : 'Photo review is not set up yet'}
                to="/admin/photos"
                urgent={(overview?.pendingPhotos ?? 0) > 0}
              />
            </div>
            <StatCard
              label="New access requests"
              value={overview?.newLeads ?? 0}
              hint="Advertisers waiting for onboarding"
              to="/admin/leads"
              urgent={(overview?.newLeads ?? 0) > 0}
            />
            <StatCard
              label="Campaigns in review"
              value={overview?.pendingCampaigns ?? 0}
              hint="Awaiting your approval to go live"
              to="/admin/campaigns"
              urgent={(overview?.pendingCampaigns ?? 0) > 0}
            />
            <StatCard
              label="Live campaigns"
              value={overview?.activeCampaigns ?? 0}
              hint="Currently serving to students"
              to="/admin/campaigns"
            />
            <StatCard
              label="Advertiser accounts"
              value={overview?.advertisers ?? 0}
              hint="Active portal sign-ins"
              to="/admin/advertisers"
            />
          </div>

          <div className="grid xl:grid-cols-2 gap-4 items-stretch">
            <section className="card card-pad r-ink">
              <header className="card-head">
                <span className="route-badge">
                  <Icon name="rocket" size={18} />
                </span>
                <div>
                  <h2 className="card-title">Quick actions</h2>
                </div>
              </header>
              <ul className="text-[13.5px] leading-snug text-[var(--color-txt-2)]">
                <li className={QUICK_ACTION_ROW}>
                  <Link to="/admin/leads" className="font-display font-bold text-[var(--color-accent)] hover:underline underline-offset-2">Review access requests</Link>
                  {' '}and create advertiser accounts.
                </li>
                <li className={QUICK_ACTION_ROW}>
                  <Link to="/admin/campaigns" className="font-display font-bold text-[var(--color-accent)] hover:underline underline-offset-2">Approve or reject campaigns</Link>
                  {' '}submitted for review.
                </li>
                <li className={QUICK_ACTION_ROW}>
                  Share the advertiser portal link:{' '}
                  <code className="font-mono text-[12.5px] text-[var(--color-txt-0)] bg-[var(--color-stat)] px-1.5 py-0.5 rounded-sm">/advertise</code>
                </li>
              </ul>
            </section>
            <section className="card card-pad r-ink">
              <header className="card-head">
                <span className="route-badge">
                  <Icon name="graduation" size={18} />
                </span>
                <div>
                  <h2 className="card-title">Release stuck Purdue link</h2>
                </div>
              </header>
              <p className="text-[13.5px] leading-relaxed text-[var(--color-txt-2)] mb-4">
                If a student sees &quot;already linked&quot; or &quot;in use&quot; after resetting their account, clear the old link here.
              </p>
              <form onSubmit={handleReleasePurdueLink} className="flex flex-col sm:flex-row gap-2">
                {/* Named for screen readers; the placeholder alone was its only name. */}
                <input
                  type="email"
                  aria-label="Student Purdue email"
                  value={purdueReleaseEmail}
                  onChange={(e) => setPurdueReleaseEmail(e.target.value)}
                  placeholder="student@purdue.edu"
                  className="input flex-1 min-w-0"
                />
                <button
                  type="submit"
                  disabled={releasing || !purdueReleaseEmail.trim()}
                  className="btn btn-secondary min-h-[44px]"
                >
                  {releasing ? 'Releasing…' : 'Release link'}
                </button>
              </form>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
