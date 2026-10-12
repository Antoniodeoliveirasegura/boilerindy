import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Icon from '../../components/Icons'
import { createAdminAdvertiser, listAdminAdvertisers } from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader } from './adminShared'
import { TABLE_HEAD_ROW, TABLE_ROW, TABLE_TH, formatDateTime, generateTempPassword } from './adminHelpers'
import PageTitle from '../../components/PageTitle'

const LABEL = 'text-[13px] font-semibold text-[var(--color-txt-1)]'

type Advertiser = {
  id: string
  companyName?: string
  email?: string
  contactName?: string
  status?: string
  createdAt?: string
}

export default function AdminAdvertisers() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [advertisers, setAdvertisers] = useState<Advertiser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    email: '',
    companyName: '',
    contactName: '',
    password: '',
    leadId: '',
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = (await listAdminAdvertisers()) as { advertisers?: Advertiser[] }
      setAdvertisers(data.advertisers || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load advertisers.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const email = searchParams.get('email')
    const company = searchParams.get('company')
    const leadId = searchParams.get('lead')
    if (email || company || leadId) {
      setForm((prev) => ({
        ...prev,
        email: email || prev.email,
        companyName: company || prev.companyName,
        leadId: leadId || prev.leadId,
        password: prev.password || generateTempPassword(),
      }))
      setShowForm(true)
    }
  }, [searchParams])

  function openCreateForm() {
    setForm({
      email: '',
      companyName: '',
      contactName: '',
      password: generateTempPassword(),
      leadId: '',
    })
    setShowForm(true)
    setSearchParams({})
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    setSuccess('')
    try {
      const payload: {
        email: string
        companyName: string
        contactName: string
        password: string
        leadId?: string
      } = {
        email: form.email.trim(),
        companyName: form.companyName.trim(),
        contactName: form.contactName.trim(),
        password: form.password,
      }
      if (form.leadId) payload.leadId = form.leadId

      const data = (await createAdminAdvertiser(payload)) as { advertiser: { email?: string } }
      setSuccess(
        `Advertiser account ready for ${data.advertiser.email}. Share the temporary password securely - they sign in at /advertise.`,
      )
      setShowForm(false)
      setSearchParams({})
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create advertiser account.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <PageTitle>Admin advertisers</PageTitle>
      <PageHeader
        title="Advertisers"
        description="Invite-only advertiser accounts. Create credentials here, then share them with the business out of band."
        actions={
          <>
            <button type="button" onClick={load} className="btn btn-secondary btn-sm">
              <Icon name="refresh" size={14} />
              Refresh
            </button>
            <button type="button" onClick={openCreateForm} className="btn btn-primary btn-sm">
              Create account
            </button>
          </>
        }
      />

      <AlertBanner message={error} onDismiss={() => setError('')} />
      <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />

      {showForm && (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center p-4 bg-black/55">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-advertiser-title"
            className="card w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6 shadow-[var(--shadow-xl)]"
          >
            <h2 id="create-advertiser-title" className="card-title text-[20px] mb-1">
              Create advertiser account
            </h2>
            <p className="text-[13.5px] text-[var(--color-txt-2)] mb-5">
              The business uses these credentials at{' '}
              <code className="font-mono text-[12.5px] text-[var(--color-txt-0)] bg-[var(--color-stat)] px-1.5 py-0.5 rounded-sm">/advertise</code>.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="block">
                <span className={LABEL}>Business email</span>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="input mt-1.5"
                />
              </label>
              <label className="block">
                <span className={LABEL}>Company name</span>
                <input
                  required
                  value={form.companyName}
                  onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))}
                  className="input mt-1.5"
                />
              </label>
              <label className="block">
                <span className={LABEL}>Contact name (optional)</span>
                <input
                  value={form.contactName}
                  onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
                  className="input mt-1.5"
                />
              </label>
              <label className="block">
                <span className={LABEL}>Temporary password</span>
                <div className="mt-1.5 flex gap-2">
                  <input
                    required
                    minLength={8}
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    className="input flex-1 min-w-0 font-mono text-[14px]"
                  />
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, password: generateTempPassword() }))}
                    className="btn btn-secondary min-h-[44px] px-3.5"
                  >
                    Regenerate
                  </button>
                </div>
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false)
                    setSearchParams({})
                  }}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
                <button type="submit" disabled={submitting} className="btn btn-primary disabled:opacity-50">
                  {submitting ? 'Creating…' : 'Create account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-[13.5px] text-[var(--color-txt-2)]">Loading advertisers…</div>
      ) : advertisers.length === 0 ? (
        <EmptyState
          icon="briefcase"
          title="No advertiser accounts yet"
          description="Create the first account when you approve an access request."
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13.5px]">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Company</th>
                  <th className={TABLE_TH}>Contact</th>
                  <th className={TABLE_TH}>Status</th>
                  <th className={TABLE_TH}>Created</th>
                </tr>
              </thead>
              <tbody>
                {advertisers.map((row) => (
                  <tr key={row.id} className={TABLE_ROW}>
                    <td className="px-4 py-3.5">
                      <div className="font-display font-bold text-[14px] leading-snug text-[var(--color-txt-0)]">{row.companyName}</div>
                      <div className="text-[12.5px] text-[var(--color-txt-2)] mt-0.5">{row.email}</div>
                    </td>
                    <td className="px-4 py-3.5 text-[var(--color-txt-1)]">{row.contactName || '-'}</td>
                    <td className="px-4 py-3.5">
                      <span className={`badge ${row.status === 'active' ? 'badge-route r-din' : ''}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-[var(--color-txt-2)] whitespace-nowrap tnum">
                      {formatDateTime(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
