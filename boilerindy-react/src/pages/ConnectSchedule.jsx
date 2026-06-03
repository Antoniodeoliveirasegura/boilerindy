import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import Icon from '../components/Icons'

const sourceConfigs = {
  brightspace: {
    label: 'Brightspace Calendar',
    description: 'Import assignments, exams, labs, and due dates from Brightspace',
    placeholder: 'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=...',
    helpText: 'Brightspace → Calendar → Subscribe → Copy the iCal feed URL',
    icon: 'document',
  },
  purdue: {
    label: 'Class Schedule',
    description: 'Import your actual class meeting times from Purdue Timetabling',
    placeholder: 'https://timetable.mypurdue.purdue.edu/Timetabling/export?x=...',
    helpText: 'Purdue Timetabling → Export → Personal Schedule → iCalendar',
    icon: 'schedule',
  },
}

export default function ConnectSchedule() {
  const navigate = useNavigate()
  const { onboarding, refreshSession, user } = useAuth()

  const [purdueEmail, setPurdueEmail] = useState('')
  const [linking, setLinking] = useState(false)

  const [icsUrl, setIcsUrl] = useState('')
  const [sourceType, setSourceType] = useState('brightspace')
  const [sources, setSources] = useState([])
  const [saving, setSaving] = useState(false)

  const [banner, setBanner] = useState('')
  const [bannerType, setBannerType] = useState('info')

  const needsPurdueConnection = onboarding?.needsPurdueConnection
  const config = sourceConfigs[sourceType]

  const loadData = useCallback(async () => {
    try {
      const sourceRes = await authRequest('/api/me/sources')
      setSources(sourceRes.sources || [])
    } catch (error) {
      setBannerType('error')
      setBanner(error.message || 'Could not load linked sources.')
    }
  }, [])

  useEffect(() => {
    if (!needsPurdueConnection) loadData()
  }, [loadData, needsPurdueConnection])

  // ── Step 1: Link Purdue ──

  async function handleLinkPurdue(e) {
    e.preventDefault()
    if (!purdueEmail.trim() || !purdueEmail.includes('@')) {
      setBannerType('error')
      setBanner('Please enter a valid Purdue email address.')
      return
    }
    setLinking(true)
    setBanner('')
    try {
      await authRequest('/api/purdue/mock-link', {
        method: 'POST',
        body: JSON.stringify({ email: purdueEmail.trim() }),
      })
      await refreshSession()
      setPurdueEmail('')
      setBannerType('success')
      setBanner('Purdue account linked! You can now connect your calendars.')
    } catch (error) {
      setBannerType('error')
      setBanner(error.message || 'Could not link Purdue account.')
    } finally {
      setLinking(false)
    }
  }

  // ── Step 2: Connect source ──

  const connectSource = useCallback(async (nextUrl = icsUrl) => {
    setBanner('')
    setBannerType('info')
    setSaving(true)
    try {
      const endpoint = sourceType === 'brightspace'
        ? '/api/sources/brightspace/schedule'
        : '/api/sources/purdue/schedule'
      const response = await authRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify({ icsUrl: nextUrl, label: config.label }),
      })
      setIcsUrl('')
      await refreshSession()
      await loadData()
      
      // Build success message with details
      const itemCount = response?.sync?.itemCount ?? 0
      const skippedCount = response?.sync?.skippedCount ?? 0
      const baseName = sourceType === 'brightspace' ? 'Brightspace calendar' : 'Class schedule'
      
      if (itemCount === 0) {
        setBannerType('info')
        setBanner(`${baseName} connected but no events were found. This may be normal if your calendar is empty.`)
      } else if (skippedCount > 0) {
        setBannerType('success')
        setBanner(`${baseName} connected! Imported ${itemCount} items. (${skippedCount} items had invalid dates and were skipped.)`)
      } else {
        setBannerType('success')
        setBanner(`${baseName} connected! Imported ${itemCount} items.`)
      }
    } catch (error) {
      setBannerType('error')
      setBanner(error.message || 'Could not connect this source.')
    } finally {
      setSaving(false)
    }
  }, [config.label, icsUrl, loadData, refreshSession, sourceType])

  async function handleConnect(e) {
    e.preventDefault()
    await connectSource()
  }

  async function handleSync(sourceId) {
    setBanner('')
    setBannerType('info')
    setBanner('Syncing...')
    try {
      const response = await authRequest(`/api/sync/${sourceId}`, { method: 'POST' })
      await refreshSession()
      await loadData()
      
      const itemCount = response?.sync?.itemCount ?? 0
      const skippedCount = response?.sync?.skippedCount ?? 0
      const warning = response?.warning
      
      if (warning) {
        setBannerType('info')
        setBanner(`Synced ${itemCount} items. ${warning}`)
      } else if (itemCount === 0) {
        setBannerType('info')
        setBanner('Sync complete. No events found in the calendar.')
      } else {
        setBannerType('success')
        setBanner(`Synced successfully! ${itemCount} items imported.`)
      }
    } catch (error) {
      setBannerType('error')
      setBanner(error.message || 'Could not sync source.')
    }
  }

  async function handleDelete(sourceId) {
    if (!confirm('Delete this source and all its imported items?')) return
    setBanner('')
    try {
      await authRequest(`/api/me/sources/${encodeURIComponent(sourceId)}/remove`, { method: 'POST' })
      await refreshSession()
      await loadData()
      setBannerType('success')
      setBanner('Source deleted.')
    } catch (error) {
      setBannerType('error')
      setBanner(error.message || 'Could not delete source.')
    }
  }


  // ── Helpers ──

  function getSourceTypeLabel(st) {
    if (st === 'brightspace_ical') return 'Brightspace'
    if (st === 'purdue_schedule_ical') return 'Class Schedule'
    return st
  }

  function getSourceIcon(st) {
    if (st === 'brightspace_ical') return 'document'
    return 'schedule'
  }

  // ── Render ──

  const bannerEl = banner && (
    <div className={`mb-6 card p-4 text-[13px] flex items-start gap-3 ${
      bannerType === 'success' ? 'bg-[var(--color-success)]/10 text-[var(--color-success)] border-[var(--color-success)]/20' :
      bannerType === 'error' ? 'bg-[var(--color-error)]/10 text-[var(--color-error)] border-[var(--color-error)]/20' :
      'text-[var(--color-txt-1)]'
    }`}>
      <Icon name={bannerType === 'success' ? 'check' : bannerType === 'error' ? 'close' : 'info'} size={16} className="shrink-0 mt-0.5" />
      {banner}
    </div>
  )

  // ────────────────────────────────────────
  // STEP 1 — Link Purdue email
  // ────────────────────────────────────────
  if (needsPurdueConnection) {
    return (
      <div className="max-w-[520px] mx-auto px-4 sm:px-6 py-8 sm:py-12 pb-24">
        <div className="text-center mb-6 sm:mb-8">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-[var(--color-gold)]/15 text-[var(--color-gold)] flex items-center justify-center mx-auto mb-3 sm:mb-4">
            <Icon name="graduation" size={24} className="sm:hidden" />
            <Icon name="graduation" size={28} className="hidden sm:block" />
          </div>
          <h1 className="text-xl sm:text-2xl font-semibold text-[var(--color-txt-0)]">Connect your Purdue email</h1>
          <p className="text-[13px] sm:text-[14px] text-[var(--color-txt-2)] mt-2 max-w-[400px] mx-auto px-4 sm:px-0">
            Link your Purdue identity so you can import your class schedule and assignments.
          </p>
        </div>

        {bannerEl}

        <div className="card p-4 sm:p-6">
          <form onSubmit={handleLinkPurdue}>
            <label htmlFor="purdue-email" className="block text-[13px] font-medium text-[var(--color-txt-1)] mb-2">
              Purdue email address
            </label>
            <input
              id="purdue-email"
              type="email"
              value={purdueEmail}
              onChange={(e) => setPurdueEmail(e.target.value)}
              placeholder="you@purdue.edu"
              className="input w-full px-4 py-3 text-[16px] sm:text-[14px] mb-4 rounded-xl"
              autoFocus
            />
            <button
              type="submit"
              disabled={linking || !purdueEmail.trim()}
              className="btn btn-primary w-full text-[14px] px-5 py-3.5 sm:py-3 justify-center disabled:opacity-50 rounded-xl"
            >
              <Icon name="graduation" size={16} />
              {linking ? 'Linking…' : 'Link Purdue Account'}
            </button>
          </form>
        </div>

        <p className="text-center text-[12px] text-[var(--color-txt-3)] mt-4 px-4">
          Signed in as <span className="font-medium text-[var(--color-txt-2)]">{user?.email}</span>
        </p>
      </div>
    )
  }

  // ────────────────────────────────────────
  // STEP 2 — Connect calendar sources
  // ────────────────────────────────────────
  return (
    <div className="max-w-[800px] mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24">
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-semibold text-[var(--color-txt-0)]">Connect Your Calendars</h1>
        <p className="text-[13px] sm:text-[14px] text-[var(--color-txt-2)] mt-1">
          Import your assignments and class schedule from Purdue systems.
        </p>
      </div>

      {bannerEl}

      {/* Connected Sources */}
      {sources.length > 0 && (
        <div className="mb-6 sm:mb-8">
          <h2 className="text-[11px] sm:text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">
            Connected Sources
          </h2>
          <div className="space-y-3">
            {sources.map((source) => (
              <div key={source.id} className="card p-3 sm:p-4">
                <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      source.sourceType === 'brightspace_ical'
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'bg-[var(--color-gold)]/15 text-[var(--color-gold)]'
                    }`}>
                      <Icon name={getSourceIcon(source.sourceType)} size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[var(--color-txt-0)] text-[14px]">{source.label}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                          source.status === 'ready'
                            ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                            : source.status === 'error'
                            ? 'bg-[var(--color-error)]/15 text-[var(--color-error)]'
                            : 'bg-[var(--color-txt-3)]/15 text-[var(--color-txt-2)]'
                        }`}>
                          {source.status}
                        </span>
                      </div>
                      <div className="text-[11px] sm:text-[12px] text-[var(--color-txt-2)] mt-0.5">
                        {getSourceTypeLabel(source.sourceType)}
                        {source.lastSyncedAt && (
                          <span className="hidden sm:inline"> · Synced {new Date(source.lastSyncedAt).toLocaleDateString()}</span>
                        )}
                      </div>
                      {source.lastError && (
                        <div className="text-[11px] sm:text-[12px] text-[var(--color-error)] mt-1">{source.lastError}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0 ml-[52px] sm:ml-0">
                    <button type="button" onClick={() => handleSync(source.id)} className="btn btn-secondary text-[12px] px-3 py-2 sm:py-1.5 flex-1 sm:flex-none justify-center">
                      Sync
                    </button>
                    <button type="button" onClick={() => handleDelete(source.id)} className="btn text-[12px] px-3 py-2 sm:py-1.5 text-[var(--color-error)] hover:bg-[var(--color-error)]/10 active:bg-[var(--color-error)]/15">
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add New Source */}
      <div className="card p-4 sm:p-6">
        <h2 className="text-[15px] sm:text-[16px] font-semibold text-[var(--color-txt-0)] mb-4">
          Add Calendar Source
        </h2>

        {/* Source Type Toggle */}
        <div className="mb-5">
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setSourceType('brightspace')}
              className={`p-3 sm:p-4 rounded-xl border-2 text-left transition-all active:scale-[0.98] ${
                sourceType === 'brightspace'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-2)]'
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5 sm:mb-2">
                <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  sourceType === 'brightspace'
                    ? 'bg-blue-500 text-white'
                    : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                }`}>
                  <Icon name="document" size={14} className="sm:hidden" />
                  <Icon name="document" size={16} className="hidden sm:block" />
                </div>
                <span className="font-medium text-[var(--color-txt-0)] text-[13px] sm:text-[14px]">Brightspace</span>
              </div>
              <p className="text-[11px] sm:text-[12px] text-[var(--color-txt-2)]">
                Assignments, exams, labs
              </p>
            </button>

            <button
              type="button"
              onClick={() => setSourceType('purdue')}
              className={`p-3 sm:p-4 rounded-xl border-2 text-left transition-all active:scale-[0.98] ${
                sourceType === 'purdue'
                  ? 'border-[var(--color-gold)] bg-[var(--color-gold)]/10'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-2)]'
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5 sm:mb-2">
                <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  sourceType === 'purdue'
                    ? 'bg-[var(--color-gold)] text-[var(--color-gold-dark)]'
                    : 'bg-[var(--color-gold)]/15 text-[var(--color-gold)]'
                }`}>
                  <Icon name="schedule" size={14} className="sm:hidden" />
                  <Icon name="schedule" size={16} className="hidden sm:block" />
                </div>
                <span className="font-medium text-[var(--color-txt-0)] text-[13px] sm:text-[14px]">Schedule</span>
              </div>
              <p className="text-[11px] sm:text-[12px] text-[var(--color-txt-2)]">
                Class meeting times
              </p>
            </button>
          </div>
        </div>

        {/* URL Input Form */}
        <form onSubmit={handleConnect}>
          <div className="mb-4">
            <label className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">
              iCalendar Feed URL
            </label>
            <textarea
              value={icsUrl}
              onChange={(e) => setIcsUrl(e.target.value)}
              className="input w-full px-3 sm:px-4 py-3 text-[14px] sm:text-[13px] min-h-[90px] sm:min-h-[100px] resize-y font-mono rounded-xl"
              placeholder={config.placeholder}
              required
            />
            <p className="text-[10px] sm:text-[11px] text-[var(--color-txt-3)] mt-1.5">
              {config.helpText}
            </p>
          </div>
          <button
            type="submit"
            disabled={!icsUrl.trim() || saving}
            className="btn btn-primary text-[13px] px-5 py-3 sm:py-2.5 disabled:opacity-50 w-full sm:w-auto justify-center rounded-xl"
          >
            <Icon name={config.icon} size={15} />
            {saving ? 'Connecting…' : `Connect ${sourceType === 'brightspace' ? 'Brightspace' : 'Schedule'}`}
          </button>
        </form>
      </div>

      {/* Footer links */}
      <div className="mt-5 sm:mt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-[13px]">
        <div className="flex gap-4 justify-center sm:justify-start">
          <Link to="/assignments" className="text-[var(--color-accent)] hover:underline flex items-center gap-1 py-2">
            <Icon name="document" size={14} />
            View Tasks
          </Link>
          <Link to="/schedule" className="text-[var(--color-accent)] hover:underline flex items-center gap-1 py-2">
            <Icon name="schedule" size={14} />
            View Schedule
          </Link>
        </div>
        <button type="button" onClick={() => navigate('/dashboard')} className="btn btn-secondary text-[13px] px-4 py-2.5 sm:py-2 w-full sm:w-auto justify-center">
          Go to Dashboard
        </button>
      </div>
    </div>
  )
}
