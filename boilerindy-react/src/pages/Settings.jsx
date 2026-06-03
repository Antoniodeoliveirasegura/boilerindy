import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth, useSignOutAndRedirect } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import Icon from '../components/Icons'

export default function Settings() {
  const { user, onboarding, refreshSession, startPurdueLink, authConfig } = useAuth()
  const signOutAndRedirect = useSignOutAndRedirect()
  const [searchParams] = useSearchParams()
  const [name, setName] = useState(user?.name || '')
  const [email, setEmail] = useState(user?.email || '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [banner, setBanner] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(user?.name || '')
    setEmail(user?.email || '')
  }, [user?.name, user?.email])

  useEffect(() => {
    const error = searchParams.get('error')
    if (!error) return
    const messages = {
      'cas-config': 'Purdue CAS is not configured yet on the backend.',
      'missing-ticket': 'Purdue CAS did not return a ticket. Try linking again.',
      'cas-validation': 'Purdue CAS could not validate your identity. Try again.',
    }
    setBanner(messages[error] || 'Could not complete Purdue linking.')
  }, [searchParams])

  async function handleSave(e) {
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
      setBanner(error.message || 'Could not update settings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-[960px] mx-auto px-6 py-8 pb-24">
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
          <div className="card p-5">
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
              Purdue account
            </div>
            {user?.hasPurdueLinked ? (
              <>
                <div className="text-[15px] font-semibold text-[var(--color-txt-0)]">Linked</div>
                <div className="text-[13px] text-[var(--color-txt-2)] mt-1">{user.purdueEmail}</div>
                <p className="text-[13px] text-[var(--color-txt-1)] mt-3 leading-relaxed">
                  Purdue is connected as a linked identity. Purdue-specific sources like timetable feeds can now be attached from setup.
                </p>
                <Link to="/setup" className="btn btn-secondary text-[13px] px-4 py-2 mt-4 inline-flex">
                  <Icon name="calendar" size={14} />
                  Manage schedule sources
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
                Open setup
              </Link>
              <Link to="/schedule" className="btn btn-secondary text-[13px] px-4 py-2">
                <Icon name="schedule" size={14} />
                View schedule
              </Link>
            </div>
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
