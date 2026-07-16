import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth, useSignOutAndRedirect } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { authRequest } from '../lib/authApi'
import { supabase } from '../lib/supabase'
import Icon from '../components/Icons'
import { useConfirm } from '../hooks/useConfirm'

export default function Settings() {
  const { user, onboarding, refreshSession, startPurdueLink, authConfig } = useAuth()
  const { theme, setTheme } = useTheme()
  const signOutAndRedirect = useSignOutAndRedirect()
  const { confirm, confirmDialog } = useConfirm()
  const [searchParams] = useSearchParams()
  const [name, setName] = useState(user?.name || '')
  const [email, setEmail] = useState(user?.email || '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // Seed the banner from the redirect URL once at mount (CAS redirect), reading
  // it in the initializer rather than a setState-in-effect.
  const [banner, setBanner] = useState(() => {
    const error = searchParams.get('error')
    if (!error) return ''
    const messages: Record<string, string> = {
      'cas-config': 'Purdue CAS is not configured yet on the backend.',
      'missing-ticket': 'Purdue CAS did not return a ticket. Try linking again.',
      'cas-validation': 'Purdue CAS could not validate your identity. Try again.',
    }
    return messages[error] || 'Could not complete Purdue linking.'
  })
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [analyticsSaving, setAnalyticsSaving] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleting, setDeleting] = useState(false)

  // Calendar feed (issue #48): a subscribable .ics URL gated by a secret token.
  const [feedUrl, setFeedUrl] = useState<string | null>(null)
  const [feedLoaded, setFeedLoaded] = useState(false)
  const [feedBusy, setFeedBusy] = useState(false)
  const [feedCopied, setFeedCopied] = useState(false)

  // Load the current feed URL once on mount - a genuine external read, so an
  // effect is the right tool here (unlike the derived state handled in render).
  useEffect(() => {
    let active = true
    authRequest('/api/me/calendar-feed')
      .then((data) => {
        const d = data as { feedUrl?: string }
        if (active) setFeedUrl(d?.feedUrl || null)
      })
      .catch(() => {
        /* feed link is optional UI; ignore load failures */
      })
      .finally(() => {
        if (active) setFeedLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  async function handleGenerateFeed() {
    if (
      feedUrl &&
      !(await confirm({
        title: 'Regenerate the calendar link?',
        message: 'The old URL will stop working immediately.',
        confirmLabel: 'Regenerate',
        tone: 'danger',
      }))
    ) {
      return
    }
    setFeedBusy(true)
    setBanner('')
    setStatus('')
    try {
      const data = (await authRequest('/api/me/calendar-feed/token', { method: 'POST' })) as { feedUrl?: string }
      setFeedUrl(data.feedUrl || null)
      setFeedCopied(false)
      setStatus(feedUrl ? 'Calendar link regenerated. Update your calendar subscription.' : 'Calendar link created.')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Could not generate a calendar link.')
    } finally {
      setFeedBusy(false)
    }
  }

  // Analytics opt-out (issue #51): saved immediately on toggle; UsageListener
  // reacts to the refreshed session, so opting out stops sending right away.
  async function handleAnalyticsToggle(e: React.ChangeEvent<HTMLInputElement>) {
    const nextEnabled = e.target.checked
    setAnalyticsSaving(true)
    setBanner('')
    setStatus('')
    try {
      await authRequest('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ analyticsOptOut: !nextEnabled }),
      })
      await refreshSession()
      setStatus(nextEnabled ? 'Usage analytics turned on.' : 'Usage analytics turned off.')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Could not update your analytics preference.')
    } finally {
      setAnalyticsSaving(false)
    }
  }

  async function handleCopyFeed() {
    if (!feedUrl) return
    try {
      await navigator.clipboard.writeText(feedUrl)
      setFeedCopied(true)
      window.setTimeout(() => setFeedCopied(false), 2000)
    } catch {
      setBanner('Could not copy automatically - select and copy the URL manually.')
    }
  }

  // Keep the editable name/email fields in sync when the authenticated user
  // changes (e.g. after refreshSession). Adjusting during render instead of in
  // an effect avoids the cascading-render lint warning.
  const [prevUser, setPrevUser] = useState(user)
  if (user !== prevUser) {
    setPrevUser(user)
    setName(user?.name || '')
    setEmail(user?.email || '')
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBanner('')
    setStatus('')

    if (newPassword && newPassword !== confirmPassword) {
      setBanner('New passwords do not match.')
      return
    }

    setSaving(true)
    try {
      await authRequest('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          email,
          currentPassword,
          newPassword,
        }),
      })
      await refreshSession()
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setStatus('Settings updated.')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Could not update settings.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBanner('')
    setStatus('')

    if (deleteConfirm !== 'DELETE') {
      setBanner('Type DELETE in the confirmation box to permanently delete your account.')
      return
    }
    if (!deletePassword) {
      setBanner('Enter your password to confirm deletion.')
      return
    }
    if (
      !(await confirm({
        title: 'Delete your account?',
        message: 'This permanently deletes your BoilerIndy account, schedule data, and posts. This cannot be undone.',
        confirmLabel: 'Delete account',
        tone: 'danger',
      }))
    ) {
      return
    }

    setDeleting(true)
    try {
      await authRequest('/api/me/delete-account', {
        method: 'POST',
        body: JSON.stringify({
          password: deletePassword,
          confirmation: deleteConfirm,
        }),
      })
      try {
        await supabase.auth.signOut()
      } catch {
        /* session may already be gone */
      }
      window.location.replace('/')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Could not delete your account.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="max-w-[960px] mx-auto px-6 py-8 pb-24">
      {confirmDialog}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Settings</h1>
        <p className="text-[14px] text-[var(--color-txt-2)] mt-1 max-w-[720px]">
          Manage your app account, Purdue connection, and the data sources you have attached.
        </p>
      </div>

      {banner && (
        <div className="mb-4 card p-4 text-[13px] text-[var(--color-error)]">
          {banner}
        </div>
      )}

      {status && (
        <div className="mb-4 card p-4 text-[13px] text-[var(--color-success)]">
          {status}
        </div>
      )}

      <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-4 mb-6">
        <form onSubmit={handleSave} className="card p-5">
          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
            Account details
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">Display name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input w-full px-4 py-3 text-[14px]"
                placeholder="Antonio Segura"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input w-full px-4 py-3 text-[14px]"
                placeholder="you@example.com"
              />
            </div>
          </div>

          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mt-6 mb-4">
            Change password
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">Current password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="input w-full px-4 py-3 text-[14px]"
                placeholder="Current password"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input w-full px-4 py-3 text-[14px]"
                placeholder="At least 8 characters"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">Confirm new password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input w-full px-4 py-3 text-[14px]"
                placeholder="Repeat new password"
              />
            </div>
            <button type="submit" disabled={saving} className="btn btn-primary text-[13px] px-5 py-2.5 disabled:opacity-50">
              <Icon name="check" size={15} />
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>

        <div className="space-y-4">
          {(authConfig as { supportsPurdueLink?: boolean })?.supportsPurdueLink !== false && (
          <div className="card p-5">
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
              Purdue account
            </div>
            {user?.hasPurdueLinked ? (
              <>
                <div className="text-[15px] font-semibold text-[var(--color-txt-0)]">Linked</div>
                <div className="text-[13px] text-[var(--color-txt-2)] mt-1">{String(user.purdueEmail ?? '')}</div>
                <p className="text-[13px] text-[var(--color-txt-1)] mt-3 leading-relaxed">
                  Purdue is connected as a linked identity. Purdue-specific sources like timetable feeds can now be attached from setup.
                </p>
                <Link to="/setup" className="btn btn-secondary text-[13px] px-4 py-2 mt-4 inline-flex">
                  <Icon name="calendar" size={14} />
                  Manage calendar sources
                </Link>
              </>
            ) : (
              <>
                <div className="text-[15px] font-semibold text-[var(--color-txt-0)]">Not linked yet</div>
                <p className="text-[13px] text-[var(--color-txt-1)] mt-2 leading-relaxed">
                  Sign in with your normal app account first, then link Purdue here or in setup. This keeps authentication separate from Purdue data access.
                </p>
                <button
                  type="button"
                  onClick={() => startPurdueLink('/settings')}
                  className="btn btn-primary text-[13px] px-4 py-2 mt-4"
                >
                  <Icon name="graduation" size={14} />
                  Link Purdue account
                </button>
              </>
            )}
          </div>
          )}

          <div className="card p-5">
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
              Sync status
            </div>
            <div className="space-y-2 text-[13px] text-[var(--color-txt-1)]">
              <div className="flex items-center justify-between gap-3">
                <span>Linked sources</span>
                <span className="badge">{onboarding?.linkedSourceCount ?? 0}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Imported classes</span>
                <span className="badge">{onboarding?.classCount ?? 0}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Purdue link mode</span>
                <span className="badge">{authConfig?.purdueAuthMode || 'mock'}</span>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-[var(--color-border)] flex flex-wrap gap-2">
              <Link to="/setup" className="btn btn-secondary text-[13px] px-4 py-2">
                <Icon name="calendar" size={14} />
                Calendar sources
              </Link>
              <Link to="/schedule" className="btn btn-secondary text-[13px] px-4 py-2">
                <Icon name="schedule" size={14} />
                View schedule
              </Link>
            </div>
          </div>

          <div className="card p-5">
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
              Calendar feed
            </div>
            <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">
              Subscribe to your classes and tasks from Google or Apple Calendar with a private link.
              Treat it like a password - anyone with the link can see your schedule.
            </p>
            {feedUrl ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={feedUrl}
                    onFocus={(e) => e.target.select()}
                    aria-label="Calendar feed URL"
                    className="input flex-1 px-3 py-2 text-[12px] font-mono"
                  />
                  <button
                    type="button"
                    onClick={handleCopyFeed}
                    className="btn btn-secondary text-[13px] px-3 py-2 shrink-0"
                  >
                    <Icon name={feedCopied ? 'check' : 'copy'} size={14} />
                    {feedCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleGenerateFeed}
                  disabled={feedBusy}
                  className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-error)] underline disabled:opacity-50"
                >
                  {feedBusy ? 'Regenerating…' : 'Regenerate link (invalidates the old one)'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGenerateFeed}
                disabled={feedBusy || !feedLoaded}
                className="btn btn-primary text-[13px] px-4 py-2 mt-4 disabled:opacity-50"
              >
                <Icon name="calendar" size={14} />
                {feedBusy ? 'Creating…' : 'Create calendar link'}
              </button>
            )}
          </div>

          <div className="card p-5">
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
              Privacy
            </div>
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!user?.analyticsOptOut}
                onChange={handleAnalyticsToggle}
                disabled={analyticsSaving}
                className="w-4 h-4 mt-0.5 rounded border-[var(--color-border-2)] accent-[var(--color-gold)]"
              />
              <span>
                <span className="block text-[13px] font-medium text-[var(--color-txt-0)]">Share usage analytics</span>
                <span className="block text-[12px] text-[var(--color-txt-2)] mt-0.5 leading-relaxed">
                  Help prioritize features by sharing which pages and features you use. Stored only in
                  BoilerIndy&apos;s own database - no third-party trackers, deleted with your account.
                </span>
              </span>
            </label>
            <Link to="/privacy?from=settings" className="inline-block text-[12px] text-[var(--color-accent)] hover:underline mt-3">
              Read the privacy policy
            </Link>
          </div>

          <div className="card p-5">
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
              Appearance
            </div>
            <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed mb-3">
              Choose how BoilerIndy looks on this device. Your preference is saved between sessions.
            </p>
            <div className="inline-flex p-1 rounded-xl bg-[var(--color-stat)] border border-[var(--color-border)]">
              {['light', 'dark'].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTheme(mode as 'light' | 'dark')}
                  aria-pressed={theme === mode}
                  className={`px-4 py-2 rounded-lg text-[12px] font-semibold capitalize transition-all inline-flex items-center gap-1.5 ${
                    theme === mode
                      ? 'bg-[var(--color-surface)] text-[var(--color-txt-0)] shadow-[var(--shadow-sm)]'
                      : 'text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]'
                  }`}
                >
                  <Icon name={mode === 'light' ? 'sun' : 'moon'} size={13} />
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="card p-5 border border-[var(--color-error)]/25">
            <div className="text-[11px] font-semibold text-[var(--color-error)] uppercase tracking-wider mb-4">
              Delete account
            </div>
            <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">
              Permanently remove your BoilerIndy account, calendar data, board posts, and analytics.
              Your Purdue link and calendar feed URL will stop working immediately.
            </p>
            <form onSubmit={handleDeleteAccount} className="mt-4 space-y-3">
              <div>
                <label className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5" htmlFor="delete-password">
                  Password
                </label>
                <input
                  id="delete-password"
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  className="input w-full px-4 py-3 text-[14px]"
                  placeholder="Your current password"
                  autoComplete="current-password"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5" htmlFor="delete-confirm">
                  Type DELETE to confirm
                </label>
                <input
                  id="delete-confirm"
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  className="input w-full px-4 py-3 text-[14px]"
                  placeholder="DELETE"
                  autoComplete="off"
                />
              </div>
              <button
                type="submit"
                disabled={deleting}
                className="inline-flex items-center gap-2 text-[13px] font-semibold px-4 py-2.5 rounded-lg border border-[var(--color-error)]/40 text-[var(--color-error)] bg-[var(--color-error)]/8 hover:bg-[var(--color-error)]/12 disabled:opacity-50 cursor-pointer transition-colors"
              >
                <Icon name="close" size={14} />
                {deleting ? 'Deleting…' : 'Delete my account'}
              </button>
            </form>
          </div>

          <div className="card p-5">
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
              Session
            </div>
            <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">
              Signed in as <span className="font-medium text-[var(--color-txt-0)]">{user?.email}</span>.
            </p>
            <button
              type="button"
              onClick={signOutAndRedirect}
              className="btn btn-secondary text-[13px] px-4 py-2 mt-4"
            >
              <Icon name="close" size={14} />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
