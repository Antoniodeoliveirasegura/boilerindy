import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth, useSignOutAndRedirect } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { authRequest, type ApiRequestError } from '../lib/authApi'
import { clearAiCaches, clearUserStores } from '../lib/aiInsightCache'
import { clearGoogleConfirm, startGoogleConfirm } from '../lib/googleConfirm'
import { signInWithGoogle, supabase } from '../lib/supabase'
import Icon from '../components/Icons'
import PushNotificationsCard from '../components/settings/PushNotificationsCard'
import BlockedUsersCard from '../components/settings/BlockedUsersCard'
import PurdueEmailVerification from '../components/PurdueEmailVerification'
import { useConfirm } from '../hooks/useConfirm'
import StatusBanner from '../components/StatusBanner'
import PageTitle from '../components/PageTitle'
import WithSupportLink from '../components/WithSupportLink'

// Field labels, body copy and the sync tiles share one look across the cards.
const FIELD_LABEL = 'mb-1.5 block text-[13px] font-semibold text-[var(--color-txt-1)]'
const BODY = 'text-[14px] leading-relaxed text-[var(--color-txt-1)]'
const STAT_LABEL =
  'font-display text-[10.5px] font-extrabold uppercase leading-[1.25] tracking-[0.12em] text-[var(--color-txt-2)]'
const STAT_VALUE = 'font-display text-[22px] font-extrabold leading-none tnum text-[var(--color-txt-0)]'
const CHECKBOX = 'mt-0.5 size-[18px] shrink-0 accent-[var(--color-txt-0)]'

// Card head for each settings section: an ink route badge (or the error fill
// for the danger zone), the title and an optional head link. A card's
// description is a body paragraph under the head, never a sub in it.
function CardHead({
  icon,
  title,
  danger = false,
  children,
}: {
  icon: string
  title: string
  danger?: boolean
  children?: ReactNode
}) {
  return (
    <header className="card-head">
      <span
        aria-hidden="true"
        className={`route-badge${danger ? ' bg-[var(--color-error)] text-[var(--color-on-route)]' : ''}`}
      >
        <Icon name={icon} />
      </span>
      <div>
        <h2 className="card-title">{title}</h2>
      </div>
      {children}
    </header>
  )
}

export default function Settings() {
  const { user, supabaseUser, onboarding, refreshSession, startPurdueLink, authConfig } = useAuth()
  const { theme, setTheme } = useTheme()
  const signOutAndRedirect = useSignOutAndRedirect()
  const { confirm, confirmDialog } = useConfirm()
  const [searchParams] = useSearchParams()
  const [name, setName] = useState(user?.name || '')
  const [email, setEmail] = useState(user?.email || '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // Confirm with Google came back as another Google account (AuthCallback).
  const wrongGoogleAccount = searchParams.get('confirm') === 'wrong-account'
  const confirmingDelete = searchParams.get('for') === 'delete'
  const WRONG_GOOGLE_ACCOUNT =
    'That was a different Google account, so nothing was confirmed. Confirm with the Google account you use for BoilerIndy.'
  // Seed the banner from the redirect URL once at mount (CAS redirect), reading
  // it in the initializer rather than a setState-in-effect.
  const [banner, setBanner] = useState(() => {
    if (wrongGoogleAccount && !confirmingDelete) return WRONG_GOOGLE_ACCOUNT
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
  // The delete form's own error. It went to the page banner, two or three
  // screens above this last card, so a wrong password looked like nothing
  // happened.
  const [deleteError, setDeleteError] = useState(() => (wrongGoogleAccount && confirmingDelete ? WRONG_GOOGLE_ACCOUNT : ''))
  const deletePasswordRef = useRef<HTMLInputElement>(null)
  const deleteConfirmRef = useRef<HTMLInputElement>(null)
  // A Google account has no password to type, so it confirms an email change,
  // a first password or deletion by signing in with Google again, which lands
  // back here with ?confirmed=google (&for=delete from the delete card). The
  // server takes that sign-in for 10 minutes.
  const isGoogleAccount = user?.authProvider === 'google'
  // The Google account to confirm with: its own address when Supabase knows it
  // (an email changed here no longer matches it), else the login email.
  const googleIdentityEmail = supabaseUser?.identities?.find((identity) => identity.provider === 'google')?.identity_data?.email
  const googleEmail = (typeof googleIdentityEmail === 'string' && googleIdentityEmail) || user?.email || undefined
  const [googleConfirmed, setGoogleConfirmed] = useState(() => searchParams.get('confirmed') === 'google')
  const [usePasswordToDelete, setUsePasswordToDelete] = useState(false)
  const [confirmingGoogle, setConfirmingGoogle] = useState(false)
  const showDeletePassword = !isGoogleAccount || usePasswordToDelete
  const newPasswordRef = useRef<HTMLInputElement>(null)
  const confirmGoogleDeleteRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // A wrong account from the delete card: its message and its Confirm with
    // Google button sit at the bottom of the page.
    if (wrongGoogleAccount && confirmingDelete) confirmGoogleDeleteRef.current?.focus()
    if (!googleConfirmed) return
    if (confirmingDelete) deleteConfirmRef.current?.focus()
    else newPasswordRef.current?.focus()
    // Only on arrival from the Google redirect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      if ((error as ApiRequestError)?.code === 'reauth-required' && isGoogleAccount && googleConfirmed) {
        setGoogleConfirmed(false)
        setBanner('That Google confirmation has expired. Confirm with Google again.')
      } else {
        setBanner(error instanceof Error ? error.message : 'Could not update settings.')
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBanner('')
    setStatus('')
    setDeleteError('')

    // Each error also puts focus on the field to fix: after the confirm dialog
    // closes it would otherwise rest on nothing.
    if (deleteConfirm !== 'DELETE') {
      setDeleteError('Type DELETE in the confirmation box to permanently delete your account.')
      deleteConfirmRef.current?.focus()
      return
    }
    const viaGoogle = isGoogleAccount && googleConfirmed && !deletePassword
    if (!deletePassword && !viaGoogle) {
      if (showDeletePassword) {
        setDeleteError('Enter your password to confirm deletion.')
        deletePasswordRef.current?.focus()
      } else {
        setDeleteError('Confirm with Google first, then delete your account.')
      }
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
          ...(deletePassword ? { password: deletePassword } : {}),
          confirmation: deleteConfirm,
        }),
      })
      // The account is gone and can never sign back in, so its board draft goes
      // with the AI caches; the SIGNED_OUT listener alone keeps drafts (issue #219).
      // Its grades, schedule edits, task priorities and assistant conversation
      // go too: they stayed in browser storage after the account was deleted.
      clearAiCaches()
      clearUserStores(user?.id as string | undefined, { accountDeleted: true })
      try {
        await supabase.auth.signOut()
      } catch {
        /* session may already be gone */
      }
      window.location.replace('/')
    } catch (error) {
      if ((error as ApiRequestError)?.code === 'reauth-required' && viaGoogle) {
        setGoogleConfirmed(false)
        setDeleteError('That Google confirmation has expired. Confirm with Google again.')
      } else {
        setDeleteError(error instanceof Error ? error.message : 'Could not delete your account.')
        deletePasswordRef.current?.focus()
      }
    } finally {
      setDeleting(false)
    }
  }

  async function handleConfirmWithGoogle(forDelete: boolean) {
    const showError = forDelete ? setDeleteError : setBanner
    showError('')
    setConfirmingGoogle(true)
    try {
      // Without this, the server does not count the Google sign-in that follows.
      await authRequest('/api/me/provider-confirm', { method: 'POST' })
      sessionStorage.setItem('postAuthNext', `/settings?confirmed=google${forDelete ? '&for=delete' : ''}`)
      // AuthCallback checks the account Google returns against this one.
      if (user?.email) startGoogleConfirm(user.email, forDelete)
      await signInWithGoogle({ loginHint: googleEmail })
    } catch {
      sessionStorage.removeItem('postAuthNext')
      clearGoogleConfirm()
      showError('Google sign-in could not be started. Please try again.')
      setConfirmingGoogle(false)
    }
  }

  return (
    <div className="page">
      <PageTitle>Settings</PageTitle>
      {confirmDialog}
      <div className="page-measure">
        <header className="page-head">
          <div>
            <h1 className="page-title">Settings</h1>
            <p className="page-sub">
              Manage your app account, Purdue connection, and the data sources you have attached.
            </p>
          </div>
        </header>

        {banner && (
          <StatusBanner tone="error" className="mb-4">
            {banner}
          </StatusBanner>
        )}

        {status && (
          <StatusBanner tone="success" className="mb-4">
            {status}
          </StatusBanner>
        )}

        {/* One explicit minmax(0, 1fr) column: the implicit auto column took
            the widest unbreakable content (a long blocked name or email), and
            every card ran off the right edge of a 320px phone. */}
        <div className="grid grid-cols-1 gap-4">
          <form onSubmit={handleSave} className="card card-pad r-ink">
            <CardHead icon="user" title="Account details" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={FIELD_LABEL} htmlFor="settings-name">
                  Display name
                </label>
                <input
                  id="settings-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input"
                  placeholder="Your name"
                />
              </div>
              <div>
                <label className={FIELD_LABEL} htmlFor="settings-email">
                  Email
                </label>
                <input
                  id="settings-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <div className="mt-6 border-t border-[var(--color-border)] pt-5">
              <div className="eyebrow bare mb-4">Change password</div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className={FIELD_LABEL} htmlFor="settings-current-password">
                    Current password
                  </label>
                  <input
                    id="settings-current-password"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="input"
                    placeholder="Current password"
                  />
                  {isGoogleAccount &&
                    (googleConfirmed ? (
                      <p className={`${BODY} mt-2`}>
                        Google confirmed it&apos;s you. For the next 10 minutes you can change your email or set a
                        password without a current one.
                      </p>
                    ) : (
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <span className="text-[13px] text-[var(--color-txt-2)]">
                          Signed in with Google and never set a password?
                        </span>
                        <button
                          type="button"
                          onClick={() => handleConfirmWithGoogle(false)}
                          disabled={confirmingGoogle}
                          className="btn btn-secondary btn-sm"
                        >
                          {confirmingGoogle ? 'Opening Google…' : 'Confirm with Google'}
                        </button>
                      </div>
                    ))}
                </div>
                <div>
                  <label className={FIELD_LABEL} htmlFor="settings-new-password">
                    New password
                  </label>
                  <input
                    ref={newPasswordRef}
                    id="settings-new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="input"
                    placeholder="At least 8 characters"
                  />
                </div>
                <div>
                  <label className={FIELD_LABEL} htmlFor="settings-confirm-password">
                    Confirm new password
                  </label>
                  <input
                    id="settings-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="input"
                    placeholder="Repeat new password"
                  />
                </div>
              </div>
            </div>
            <div className="mt-5">
              <button type="submit" disabled={saving} className="btn btn-primary">
                <Icon name="check" size={16} />
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>

          {/* Shown in every PURDUE_AUTH_MODE: an emailed code links a Purdue
              address even with CAS and the mock off (issue #181). */}
          <section className="card card-pad r-ink" data-testid="purdue-account-card">
            <CardHead icon="graduation" title="Purdue account" />
            {user?.hasPurdueLinked ? (
              <>
                <div className="flex items-center gap-2.5">
                  {/* The shared open dot, without its pulse ring: a linked
                      identity is a steady state, not a live feed. */}
                  <span aria-hidden="true" className="status-dot status-open shrink-0 after:hidden" />
                  <div className="font-display text-[15px] font-bold text-[var(--color-txt-0)]">Linked</div>
                </div>
                <div className="mt-1 pl-[18px] text-[13px] text-[var(--color-txt-2)]">{user.purdueEmail ?? ''}</div>
                <p className={`${BODY} mt-3`}>
                  Purdue is connected as a linked identity. Purdue-specific sources like timetable feeds can now be attached from setup.
                </p>
                <Link to="/setup" className="btn btn-secondary mt-4">
                  <Icon name="calendar" size={14} />
                  Manage calendar sources
                </Link>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full border-[1.5px] border-[var(--color-txt-3)]"
                  />
                  <div className="font-display text-[15px] font-bold text-[var(--color-txt-0)]">Not linked yet</div>
                </div>
                <p className={`${BODY} mt-2 mb-4`}>
                  Link your @purdue.edu email to post on the Marketplace. Your sign-in stays as it is.
                </p>
                {/* The shared form stretches its controls to full width; on
                    sm+ hold them to a form-sized column so its submit does not
                    become a 700px bar next to the page's Save changes. */}
                <div className="sm:max-w-[400px]">
                  <PurdueEmailVerification submitVariant="secondary" />
                  {authConfig?.purdueAuthMode === 'cas' ? (
                    <button
                      type="button"
                      onClick={() => startPurdueLink('/settings')}
                      className="btn btn-secondary mt-3 w-full sm:w-fit"
                    >
                      <Icon name="graduation" size={14} />
                      Sign in with Purdue instead
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </section>

          <section className="card card-pad r-ink">
            <CardHead icon="refresh" title="Sync status" />
            <dl className="grid grid-cols-3 gap-2 sm:gap-3">
              <div className="flex flex-col justify-between gap-2 rounded-[var(--radius-md)] bg-[var(--color-stat)] px-3 py-3">
                <dt className={STAT_LABEL}>Linked sources</dt>
                <dd className={STAT_VALUE}>{onboarding?.linkedSourceCount ?? 0}</dd>
              </div>
              <div className="flex flex-col justify-between gap-2 rounded-[var(--radius-md)] bg-[var(--color-stat)] px-3 py-3">
                <dt className={STAT_LABEL}>Imported classes</dt>
                <dd className={STAT_VALUE}>{onboarding?.classCount ?? 0}</dd>
              </div>
              <div className="flex flex-col justify-between gap-2 rounded-[var(--radius-md)] bg-[var(--color-stat)] px-3 py-3">
                <dt className={STAT_LABEL}>Purdue link mode</dt>
                <dd>
                  <span className="code uppercase">{authConfig?.purdueAuthMode || 'mock'}</span>
                </dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link to="/setup" className="btn btn-secondary">
                <Icon name="calendar" size={14} />
                Calendar sources
              </Link>
              <Link to="/schedule" className="btn btn-secondary">
                <Icon name="schedule" size={14} />
                View schedule
              </Link>
            </div>
          </section>

          <section className="card card-pad r-ink">
            <CardHead icon="calendar" title="Calendar feed" />
            <p className={BODY}>
              Subscribe to your classes and tasks from Google or Apple Calendar with a private link.
              Treat it like a password - anyone with the link can see your schedule.
            </p>
            {feedUrl ? (
              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={feedUrl}
                    onFocus={(e) => e.target.select()}
                    aria-label="Calendar feed URL"
                    className="input min-w-0 flex-1 font-mono text-[13px] max-sm:text-[16px]"
                  />
                  <button type="button" onClick={handleCopyFeed} className="btn btn-secondary shrink-0">
                    <Icon name={feedCopied ? 'check' : 'copy'} size={14} />
                    {feedCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleGenerateFeed}
                  disabled={feedBusy}
                  className="btn btn-ghost btn-sm -ml-3 text-[var(--color-txt-2)] hover:text-[var(--color-error)]"
                >
                  <Icon name="refresh" size={14} />
                  {feedBusy ? 'Regenerating…' : 'Regenerate link (invalidates the old one)'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGenerateFeed}
                disabled={feedBusy || !feedLoaded}
                className="btn btn-secondary mt-4"
              >
                <Icon name="calendar" size={14} />
                {feedBusy ? 'Creating…' : 'Create calendar link'}
              </button>
            )}
          </section>

          <PushNotificationsCard />

          <section className="card card-pad r-ink">
            <CardHead icon="shield" title="Privacy">
              <Link to="/privacy?from=settings" className="head-link">
                Read the privacy policy
              </Link>
            </CardHead>
            <label className="flex cursor-pointer select-none items-start gap-3">
              <input
                type="checkbox"
                checked={!user?.analyticsOptOut}
                onChange={handleAnalyticsToggle}
                disabled={analyticsSaving}
                className={CHECKBOX}
              />
              <span>
                <span className="block font-display text-[14px] font-bold text-[var(--color-txt-0)]">Share usage analytics</span>
                <span className="mt-1 block text-[13px] leading-relaxed text-[var(--color-txt-2)]">
                  Help prioritize features by sharing which pages and features you use. Stored only in
                  BoilerIndy&apos;s own database - no third-party trackers, deleted with your account.
                </span>
              </span>
            </label>
          </section>

          <BlockedUsersCard />

          <section className="card card-pad r-ink">
            <CardHead icon={theme === 'dark' ? 'moon' : 'sun'} title="Appearance" />
            <p className={`${BODY} mb-4`}>
              Choose how BoilerIndy looks on this device. Your preference is saved between sessions.
            </p>
            <div className="flex flex-wrap gap-2">
              {['light', 'dark'].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTheme(mode as 'light' | 'dark')}
                  aria-pressed={theme === mode}
                  className={`pill capitalize ${theme === mode ? 'pill-active' : ''}`}
                >
                  <Icon name={mode === 'light' ? 'sun' : 'moon'} size={14} />
                  {mode}
                </button>
              ))}
            </div>
          </section>

          <section className="card card-pad r-ink">
            <CardHead icon="lock" title="Session" />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className={`${BODY} min-w-0 break-words`}>
                Signed in as <span className="font-semibold text-[var(--color-txt-0)]">{user?.email}</span>.
              </p>
              <button type="button" onClick={signOutAndRedirect} className="btn btn-secondary">
                <Icon name="close" size={14} />
                Sign out
              </button>
            </div>
          </section>

          <section className="card card-pad border-[var(--color-error)]/40">
            <CardHead icon="trash" title="Delete account" danger />
            <p className={BODY}>
              Permanently remove your BoilerIndy account, calendar data, board posts, and analytics.
              Your Purdue link and calendar feed URL will stop working immediately.
            </p>
            <form onSubmit={handleDeleteAccount} className="mt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {showDeletePassword ? (
                  <div>
                    <label className={FIELD_LABEL} htmlFor="delete-password">
                      Password
                    </label>
                    <input
                      ref={deletePasswordRef}
                      id="delete-password"
                      type="password"
                      value={deletePassword}
                      onChange={(e) => setDeletePassword(e.target.value)}
                      className="input"
                      placeholder="Your current password"
                      autoComplete="current-password"
                    />
                    {isGoogleAccount && (
                      <button
                        type="button"
                        onClick={() => {
                          setUsePasswordToDelete(false)
                          setDeletePassword('')
                        }}
                        className="mt-2 text-[13px] font-semibold text-[var(--color-txt-2)] underline"
                      >
                        Confirm with Google instead
                      </button>
                    )}
                  </div>
                ) : (
                  <div>
                    <span className={FIELD_LABEL}>Confirm it&apos;s you</span>
                    {googleConfirmed ? (
                      <p className={`${BODY} mt-1`}>
                        Google confirmed it&apos;s you. Type DELETE and delete within 10 minutes.
                      </p>
                    ) : (
                      <button
                        ref={confirmGoogleDeleteRef}
                        type="button"
                        onClick={() => handleConfirmWithGoogle(true)}
                        disabled={confirmingGoogle}
                        className="btn btn-secondary"
                      >
                        {confirmingGoogle ? 'Opening Google…' : 'Confirm with Google'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setUsePasswordToDelete(true)}
                      className="mt-2 block text-[13px] font-semibold text-[var(--color-txt-2)] underline"
                    >
                      I have a password
                    </button>
                  </div>
                )}
                <div>
                  <label className={FIELD_LABEL} htmlFor="delete-confirm">
                    Type DELETE to confirm
                  </label>
                  <input
                    ref={deleteConfirmRef}
                    id="delete-confirm"
                    type="text"
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    className="input"
                    placeholder="DELETE"
                    autoComplete="off"
                  />
                </div>
              </div>
              {deleteError && (
                <StatusBanner tone="error" className="mt-4">
                  <WithSupportLink text={deleteError} />
                </StatusBanner>
              )}
              <button
                type="submit"
                disabled={deleting}
                className="btn btn-danger mt-4"
              >
                <Icon name="trash" size={14} />
                {deleting ? 'Deleting…' : 'Delete my account'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
