import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getAdminOverview, clearAdminPurdueLink } from '../../lib/adminApi'
import { AlertBanner, PageHeader } from './adminShared'

function StatCard({ label, value, hint, to, accent }) {
  const inner = (
    <div className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 h-full ${to ? 'hover:border-[var(--color-gold)]/40 transition-colors' : ''}`}>
      <div className="text-[12px] font-medium text-[var(--color-txt-2)] uppercase tracking-wide">{label}</div>
      <div className={`text-3xl font-semibold mt-2 tabular-nums ${accent || 'text-[var(--color-txt-0)]'}`}>{value}</div>
      {hint && <div className="text-[12px] text-[var(--color-txt-3)] mt-2">{hint}</div>}
    </div>
  )
  if (to) {
    return (
      <Link to={to} className="no-underline block h-full">
        {inner}
      </Link>
    )
  }
  return inner
}

export default function AdminOverview() {
  const [overview, setOverview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [purdueReleaseEmail, setPurdueReleaseEmail] = useState('')
  const [releasing, setReleasing] = useState(false)

  useEffect(() => {
    let active = true
    getAdminOverview()
      .then((data) => {
        if (active) setOverview(data.overview)
      })
      .catch((err) => {
        if (active) setError(err.message || 'Could not load overview.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function handleReleasePurdueLink(e) {
    e.preventDefault()
    const email = purdueReleaseEmail.trim().toLowerCase()
    if (!email) return
    if (!window.confirm(`Release Purdue link for ${email}? The student can link again after signing out/in.`)) return
    setReleasing(true)
    setError('')
    setSuccess('')
    try {
      const data = await clearAdminPurdueLink({ purdueEmail: email })
      setSuccess(`Released Purdue link for ${data.cleared.map((r) => r.purdueEmail).join(', ')}.`)
      setPurdueReleaseEmail('')
    } catch (err) {
      setError(err.message || 'Could not release Purdue link.')
    } finally {
      setReleasing(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Monitor advertiser onboarding, campaign approvals, and platform health at a glance."
      />
      <AlertBanner message={error} onDismiss={() => setError('')} />
      <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />

      {loading ? (
        <div className="text-[13px] text-[var(--color-txt-2)]">Loading metrics…</div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
            <StatCard
              label="New access requests"
              value={overview?.newLeads ?? 0}
              hint="Advertisers waiting for onboarding"
              to="/admin/leads"
              accent={overview?.newLeads > 0 ? 'text-[var(--color-gold-dark)]' : undefined}
            />
            <StatCard
              label="Campaigns in review"
              value={overview?.pendingCampaigns ?? 0}
              hint="Awaiting your approval to go live"
              to="/admin/campaigns"
              accent={overview?.pendingCampaigns > 0 ? 'text-[var(--color-gold-dark)]' : undefined}
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

          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <h2 className="text-[14px] font-semibold text-[var(--color-txt-0)] mb-2">Quick actions</h2>
            <ul className="text-[13px] text-[var(--color-txt-2)] space-y-2 list-disc pl-5">
              <li>
                <Link to="/admin/leads" className="text-[var(--color-accent)] hover:underline">Review access requests</Link>
                {' '}and create advertiser accounts.
              </li>
              <li>
                <Link to="/admin/campaigns" className="text-[var(--color-accent)] hover:underline">Approve or reject campaigns</Link>
                {' '}submitted for review.
              </li>
              <li>
                Share the advertiser portal link:{' '}
                <code className="text-[12px] bg-[var(--color-bg-2)] px-1.5 py-0.5 rounded">/advertise</code>
              </li>
            </ul>
          </div>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 mt-4">
            <h2 className="text-[14px] font-semibold text-[var(--color-txt-0)] mb-2">Release stuck Purdue link</h2>
            <p className="text-[13px] text-[var(--color-txt-2)] mb-3">
              If a student sees &quot;already linked&quot; or &quot;in use&quot; after resetting their account, clear the old link here.
            </p>
            <form onSubmit={handleReleasePurdueLink} className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                value={purdueReleaseEmail}
                onChange={(e) => setPurdueReleaseEmail(e.target.value)}
                placeholder="student@purdue.edu"
                className="flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-0)] px-3 py-2.5 text-[13px]"
              />
              <button
                type="submit"
                disabled={releasing || !purdueReleaseEmail.trim()}
                className="rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-[13px] font-medium hover:bg-[var(--color-bg-2)] cursor-pointer disabled:opacity-50"
              >
                {releasing ? 'Releasing…' : 'Release link'}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  )
}
