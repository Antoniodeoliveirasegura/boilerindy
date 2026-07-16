import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Icon from '../../components/Icons'
import { createAdminAdvertiser, listAdminAdvertisers } from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader } from './adminShared'
import { formatDateTime, generateTempPassword } from './adminHelpers'

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
      <PageHeader
        title="Advertisers"
        description="Invite-only advertiser accounts. Create credentials here, then share them with the business out of band."
        actions={
          <>
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] cursor-pointer"
            >
              <Icon name="refresh" size={14} />
              Refresh
            </button>
            <button
              type="button"
              onClick={openCreateForm}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--color-gold)] text-[var(--color-gold-dark)] px-3.5 py-2 text-[13px] font-semibold hover:opacity-90 cursor-pointer border-0"
            >
              Create account
            </button>
          </>
        }
      />

      <AlertBanner message={error} onDismiss={() => setError('')} />
      <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />

      {showForm && (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-advertiser-title"
            className="w-full max-w-lg rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-6"
          >
            <h2 id="create-advertiser-title" className="text-lg font-semibold text-[var(--color-txt-0)] mb-1">
              Create advertiser account
            </h2>
            <p className="text-[13px] text-[var(--color-txt-2)] mb-5">
              The business uses these credentials at{' '}
              <code className="text-[12px] bg-[var(--color-bg-2)] px-1 rounded">/advertise</code>.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="block">
                <span className="text-[12px] font-medium text-[var(--color-txt-2)]">Business email</span>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-0)] px-3 py-2.5 text-[13px] text-[var(--color-txt-0)]"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-[var(--color-txt-2)]">Company name</span>
                <input
                  required
                  value={form.companyName}
                  onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-0)] px-3 py-2.5 text-[13px] text-[var(--color-txt-0)]"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-[var(--color-txt-2)]">Contact name (optional)</span>
                <input
                  value={form.contactName}
                  onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-0)] px-3 py-2.5 text-[13px] text-[var(--color-txt-0)]"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-[var(--color-txt-2)]">Temporary password</span>
                <div className="mt-1 flex gap-2">
                  <input
                    required
                    minLength={8}
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    className="flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-0)] px-3 py-2.5 text-[13px] font-mono text-[var(--color-txt-0)]"
                  />
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, password: generateTempPassword() }))}
                    className="rounded-xl border border-[var(--color-border)] px-3 text-[12px] hover:bg-[var(--color-bg-2)] cursor-pointer"
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
                  className="rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-[13px] hover:bg-[var(--color-bg-2)] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-xl bg-[var(--color-gold)] text-[var(--color-gold-dark)] px-4 py-2.5 text-[13px] font-semibold hover:opacity-90 cursor-pointer disabled:opacity-50 border-0"
                >
                  {submitting ? 'Creating…' : 'Create account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-[13px] text-[var(--color-txt-2)]">Loading advertisers…</div>
      ) : advertisers.length === 0 ? (
        <EmptyState
          title="No advertiser accounts yet"
          description="Create the first account when you approve an access request."
        />
      ) : (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-2)]/60">
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)]">Company</th>
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)]">Contact</th>
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)]">Status</th>
                  <th className="px-4 py-3 font-medium text-[var(--color-txt-2)]">Created</th>
                </tr>
              </thead>
              <tbody>
                {advertisers.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-4">
                      <div className="font-medium text-[var(--color-txt-0)]">{row.companyName}</div>
                      <div className="text-[12px] text-[var(--color-txt-2)]">{row.email}</div>
                    </td>
                    <td className="px-4 py-4 text-[var(--color-txt-1)]">{row.contactName || '-'}</td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                        row.status === 'active'
                          ? 'text-emerald-700 bg-emerald-500/15 border-emerald-500/30 dark:text-emerald-300'
                          : 'text-[var(--color-txt-2)] bg-[var(--color-bg-2)] border-[var(--color-border)]'
                      }`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-[var(--color-txt-2)] whitespace-nowrap">
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
