import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Icon from '../../components/Icons'
import { usePresence } from '../../hooks/usePresence'
import { createAdminAdvertiser, listAdminAdvertisers } from '../../lib/adminApi'
import { AlertBanner, EmptyState, PageHeader } from './adminShared'
import { TABLE_HEAD_ROW, TABLE_ROW, TABLE_TH, formatDateTime, generateTempPassword } from './adminHelpers'
import PageTitle from '../../components/PageTitle'

const LABEL = 'text-[13px] font-semibold text-[var(--color-txt-1)]'

/** The enabled controls Tab stops on inside `root`, in order. */
function tabStops(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href]')).filter(
    (el) => el.tabIndex >= 0 && !el.matches(':disabled'),
  )
}

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
  const dialogRef = useRef<HTMLDivElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  // Closing plays the exit before the dialog leaves the page (docs/motion.md).
  const createDialog = usePresence(showForm)

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

  // The prefill parameters are replaced, not pushed over. A pushed entry
  // left /admin/advertisers?lead=... in the history, so Back after creating
  // the account reopened the dialog with the same email and temporary
  // password, and creating again reset that advertiser's password.
  const clearPrefill = useCallback(() => setSearchParams({}, { replace: true }), [setSearchParams])

  const closeForm = useCallback(() => {
    setShowForm(false)
    clearPrefill()
  }, [clearPrefill])

  // The dialog behaves like ConfirmDialog: focus moves into it, Tab stays
  // inside, Escape closes it, and focus goes back to what opened it. Before,
  // focus stayed on the page's Create account button behind the scrim, Tab
  // walked out to the footer links under it, and Escape did nothing.
  // Keyed on showForm alone, so a re-render while the dialog is up does not
  // send focus back out and in again. A layout effect, so focus comes back in
  // the commit that closes the dialog. As a passive effect the hand-back ran a
  // task after the dialog was gone whenever the close was the create's answer
  // rather than a click or a key, and focus sat on <body> until then.
  useLayoutEffect(() => {
    if (!showForm) return undefined
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    emailRef.current?.focus()
    return () => {
      opener?.focus()
    }
  }, [showForm])

  useEffect(() => {
    if (!showForm) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeForm()
        return
      }
      if (e.key !== 'Tab') return
      const stops = tabStops(dialogRef.current)
      if (stops.length === 0) return
      const index = stops.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && index <= 0) {
        e.preventDefault()
        stops[stops.length - 1].focus()
      } else if (!e.shiftKey && (index === -1 || index === stops.length - 1)) {
        e.preventDefault()
        stops[0].focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showForm, closeForm])

  function openCreateForm() {
    setForm({
      email: '',
      companyName: '',
      contactName: '',
      password: generateTempPassword(),
      leadId: '',
    })
    setError('')
    setShowForm(true)
    clearPrefill()
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
      clearPrefill()
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

      {/* While the dialog is open its errors show inside it: here, behind the
          scrim and under the dialog card, a refused create could be neither
          read nor dismissed, and the dialog seemed to do nothing. */}
      {!showForm && <AlertBanner message={error} onDismiss={() => setError('')} />}
      <AlertBanner type="success" message={success} onDismiss={() => setSuccess('')} />

      {createDialog.mounted && (
        <div
          ref={createDialog.ref}
          data-motion={createDialog.motion}
          inert={!showForm}
          className="fixed inset-0 z-[3000] flex items-center justify-center p-4"
        >
          <div className="motion-scrim absolute inset-0 bg-black/55" aria-hidden="true" />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-advertiser-title"
            className="motion-sheet relative card w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6 shadow-[var(--shadow-xl)]"
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
                  ref={emailRef}
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

              <AlertBanner message={error} onDismiss={() => setError('')} />

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeForm}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
                <button type="submit" disabled={submitting} className="btn btn-primary">
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
          {/* A table from md up. On phones each row stacks as one item:
              company and email, the contact, then the status beside the
              created date. The header cells stay in the DOM for screen readers. */}
          <div className="md:overflow-x-auto">
            <table className="w-full text-left text-[13.5px] max-md:block md:min-w-[640px]">
              <thead className="max-md:sr-only">
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Company</th>
                  <th className={TABLE_TH}>Contact</th>
                  <th className={TABLE_TH}>Status</th>
                  <th className={TABLE_TH}>Created</th>
                </tr>
              </thead>
              <tbody className="max-md:block">
                {advertisers.map((row) => (
                  <tr
                    key={row.id}
                    className={`${TABLE_ROW} max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2.5 max-md:px-4 max-md:py-4`}
                  >
                    <td className="px-4 py-3.5 max-md:block max-md:basis-full max-md:p-0">
                      <div className="font-display font-bold text-[14px] leading-snug text-[var(--color-txt-0)]">{row.companyName}</div>
                      <div className="text-[12.5px] text-[var(--color-txt-2)] mt-0.5">{row.email}</div>
                    </td>
                    <td className="px-4 py-3.5 text-[var(--color-txt-1)] max-md:block max-md:basis-full max-md:p-0 max-md:mt-1.5">{row.contactName || '-'}</td>
                    <td className="px-4 py-3.5 max-md:block max-md:p-0 max-md:mt-2">
                      <span className={`badge ${row.status === 'active' ? 'badge-route r-din' : ''}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-[var(--color-txt-2)] whitespace-nowrap tnum max-md:block max-md:p-0 max-md:mt-2 max-md:text-[12.5px]">
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
