import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../context/AuthContext'
import { authRequest, setSkipSetup, startPurdueLink } from '../lib/authApi'
import { PROVIDER_LINKS, checkScheduleSourceUrl, type ScheduleSourceKind } from '../lib/scheduleSourceUrl'
import { track } from '../lib/usageStats'
import Icon from '../components/Icons'
import PurdueEmailVerification from '../components/PurdueEmailVerification'
import StatusBanner from '../components/StatusBanner'
import { invalidateUserQueries } from '../lib/queries/userData'
import PageTitle from '../components/PageTitle'

type SourceConfig = {
  label: string
  description: string
  placeholder: string
  helpText: string
  icon: string
  steps: string[]
}

type Source = {
  id: string
  label?: string
  sourceType?: string
  status?: string
  lastSyncedAt?: string
  lastError?: string
}

type SyncResponse = {
  sync?: { itemCount?: number; skippedCount?: number }
  warning?: string
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

const sourceConfigs: Record<string, SourceConfig> = {
  brightspace: {
    label: 'Brightspace Calendar',
    description: 'Import assignments, exams, labs, and due dates from Brightspace',
    placeholder: 'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=...',
    helpText: 'Brightspace → Calendar → Subscribe → Copy the iCal feed URL',
    icon: 'document',
    steps: [
      'Open Brightspace and sign in.',
      'Open the Calendar tool and choose Subscribe.',
      'Copy the calendar subscription link (it ends in feed.ics?token=...) and paste it below.',
    ],
  },
  purdue: {
    label: 'Class Schedule',
    description: 'Import your actual class meeting times from Purdue Timetabling',
    placeholder: 'https://timetable.mypurdue.purdue.edu/Timetabling/export?x=...',
    helpText: 'Purdue Timetabling → Export → Personal Schedule → iCalendar',
    icon: 'schedule',
    steps: [
      'Open Purdue Timetabling and sign in with your Purdue account (BoilerKey and Duo happen there, never here).',
      'On your Personal Schedule page choose Export, then iCalendar.',
      'Copy the link it gives you (it starts with timetable.mypurdue.purdue.edu/Timetabling/export) and paste it below.',
    ],
  },
}

export default function ConnectSchedule() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { onboarding, refreshSession, user, authConfig, startPurdueLink: startPurdueFromAuth } = useAuth()
  // Linking, syncing and deleting a source change the classes and calendar the
  // other pages hold in the query cache (issue #327); each success marks them stale.
  const queryClient = useQueryClient()
  const usesCasPurdue = authConfig?.purdueAuthMode === 'cas'
  const usesMockPurdue = authConfig?.purdueAuthMode === 'mock'

  const [icsUrl, setIcsUrl] = useState('')
  const [urlError, setUrlError] = useState('')
  const [sourceType, setSourceType] = useState('brightspace')
  const [sources, setSources] = useState<Source[]>([])
  const [saving, setSaving] = useState(false)

  const [banner, setBanner] = useState(() => {
    if (searchParams.get('error') === 'purdue-link') {
      return searchParams.get('message') || 'Could not link your Purdue account.'
    }
    return ''
  })
  const [bannerType, setBannerType] = useState<'error' | 'info' | 'success'>(() => (
    searchParams.get('error') === 'purdue-link' ? 'error' : 'info'
  ))
  const [syncingAll, setSyncingAll] = useState(false)

  const needsPurdueConnection = onboarding?.needsPurdueConnection
  const config = sourceConfigs[sourceType]

  useEffect(() => {
    if (searchParams.get('error') === 'purdue-link') {
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const loadData = useCallback(async () => {
    try {
      const sourceRes = (await authRequest('/api/me/sources')) as { sources?: Source[] }
      setSources(sourceRes.sources || [])
    } catch (error) {
      setBannerType('error')
      setBanner(errorText(error, 'Could not load linked sources.'))
    }
  }, [])

  useEffect(() => {
    if (needsPurdueConnection) return
    // loadData performs its setState after an await; calling it inside an IIFE
    // keeps the effect body free of a synchronous setState call.
    void (async () => {
      await loadData()
    })()
  }, [loadData, needsPurdueConnection])

  // ── Step 1: Link Purdue ──
  // An emailed code links a @purdue.edu address in every PURDUE_AUTH_MODE
  // (issue #181); the card refreshes the session itself.

  function handlePurdueLinked(message: string) {
    setBannerType('success')
    setBanner(message)
  }

  // ── Step 2: Connect source ──

  const connectSource = useCallback(async (nextUrl: string = icsUrl) => {
    setBanner('')
    setBannerType('info')
    setSaving(true)
    try {
      const endpoint = sourceType === 'brightspace'
        ? '/api/sources/brightspace/schedule'
        : '/api/sources/purdue/schedule'
      const response = (await authRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify({ icsUrl: nextUrl, label: config.label }),
      })) as SyncResponse
      void invalidateUserQueries(queryClient)
      setIcsUrl('')
      track('source_synced', { kind: 'connect', sourceType })
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
      setBanner(errorText(error, 'Could not connect this source.'))
    } finally {
      setSaving(false)
    }
  }, [config.label, icsUrl, loadData, queryClient, refreshSession, sourceType])

  async function handleConnect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // Same host allowlist as the server, checked here so a wrong paste gets a
    // specific hint next to the box instead of a generic API error (issue #120).
    const check = checkScheduleSourceUrl(sourceType as ScheduleSourceKind, icsUrl)
    if (!check.ok) {
      setUrlError(check.reason)
      return
    }
    setUrlError('')
    await connectSource(check.url)
  }

  async function handleSync(sourceId: string) {
    setBanner('')
    setBannerType('info')
    setBanner('Syncing...')
    try {
      const response = (await authRequest(`/api/sync/${sourceId}`, { method: 'POST' })) as SyncResponse
      void invalidateUserQueries(queryClient)
      track('source_synced', { kind: 'manual' })
      await refreshSession()
      await loadData()
      
      const itemCount = response?.sync?.itemCount ?? 0
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
      setBanner(errorText(error, 'Could not sync source.'))
    }
  }

  // Sync every connected source from one action (issue #8)
  async function handleSyncAll() {
    if (syncingAll || sources.length === 0) return
    setSyncingAll(true)
    setBannerType('info')

    let totalItems = 0
    const failures: string[] = []
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]
      setBanner(`Syncing ${i + 1} of ${sources.length}: ${source.label}…`)
      try {
        const response = (await authRequest(`/api/sync/${source.id}`, { method: 'POST' })) as SyncResponse
        void invalidateUserQueries(queryClient)
        totalItems += response?.sync?.itemCount ?? 0
      } catch (error) {
        failures.push(`${source.label}: ${errorText(error, 'sync failed')}`)
      }
    }

    if (failures.length < sources.length) {
      track('source_synced', { kind: 'sync_all', sourceCount: sources.length - failures.length })
    }
    await refreshSession()
    await loadData()

    if (failures.length === 0) {
      setBannerType('success')
      setBanner(`All ${sources.length} sources synced. ${totalItems} items imported.`)
    } else if (failures.length < sources.length) {
      setBannerType('info')
      setBanner(
        `Synced ${sources.length - failures.length} of ${sources.length} sources (${totalItems} items). Failed - ${failures.join('; ')}`,
      )
    } else {
      setBannerType('error')
      setBanner(`Could not sync any sources. ${failures.join('; ')}`)
    }
    setSyncingAll(false)
  }

  async function handleDelete(sourceId: string) {
    if (!confirm('Delete this source and all its imported items?')) return
    setBanner('')
    try {
      await authRequest(`/api/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' })
      void invalidateUserQueries(queryClient)
      await refreshSession()
      await loadData()
      setBannerType('success')
      setBanner('Source deleted.')
    } catch (error) {
      setBannerType('error')
      setBanner(errorText(error, 'Could not delete source.'))
    }
  }


  function handleSkipSetup() {
    setSkipSetup(true)
    navigate('/dashboard')
  }

  // ── Helpers ──

  function getSourceTypeLabel(st: string | undefined) {
    if (st === 'brightspace_ical') return 'Brightspace'
    if (st === 'purdue_schedule_ical') return 'Class Schedule'
    return st
  }

  function getSourceIcon(st: string | undefined) {
    if (st === 'brightspace_ical') return 'document'
    return 'schedule'
  }

  // ── Render ──

  const bannerEl = banner && (
    <StatusBanner tone={bannerType === 'success' || bannerType === 'error' ? bannerType : 'info'} className="mb-6">
      {banner}
    </StatusBanner>
  )

  // ────────────────────────────────────────
  // STEP 1 - Link Purdue email
  // ────────────────────────────────────────
  if (needsPurdueConnection) {
    return (
      <div className="page">
        <PageTitle>Setup</PageTitle>
        <div className="mx-auto w-full max-w-[520px] pt-2 sm:pt-6">
          <header className="mb-6 text-center">
            <span className="route-badge lg r-cls mb-4">
              <Icon name="graduation" size={22} />
            </span>
            <h1 className="page-title compact">Connect your Purdue email</h1>
            <p className="page-sub mx-auto max-w-[400px]">
              Link your Purdue identity so you can import your class schedule and assignments.
            </p>
          </header>

          {bannerEl}

          <div className="card card-pad">
            <PurdueEmailVerification
              allowDevLink={usesMockPurdue}
              onLinked={() => handlePurdueLinked('Purdue account linked! You can now connect your calendars.')}
            />
            {usesCasPurdue ? (
              <div className="mt-5 space-y-3 border-t border-[var(--color-border)] pt-5">
                <p className="text-[13.5px] leading-relaxed text-[var(--color-txt-2)]">
                  Or sign in with official Purdue CAS - we never ask you to type your Purdue password into this app.
                </p>
                <button
                  type="button"
                  onClick={() => (startPurdueFromAuth || startPurdueLink)('/setup')}
                  className="btn btn-secondary w-full"
                >
                  <Icon name="graduation" size={16} />
                  Sign in with Purdue
                </button>
              </div>
            ) : null}
          </div>

          <p className="mt-4 px-4 text-center text-[12.5px] text-[var(--color-txt-2)]">
            Signed in as <span className="font-semibold text-[var(--color-txt-1)]">{user?.email}</span>
          </p>
          <div className="mt-2 text-center">
            <button
              type="button"
              onClick={handleSkipSetup}
              className="inline-flex min-h-[44px] items-center px-2 text-[13px] text-[var(--color-txt-2)] underline underline-offset-2 hover:text-[var(--color-txt-0)]"
            >
              Skip for now - don&rsquo;t ask me again
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ────────────────────────────────────────
  // STEP 2 - Connect calendar sources
  // ────────────────────────────────────────
  const sourceOptions = [
    { id: 'brightspace', icon: 'document', name: 'Brightspace', blurb: 'Assignments, exams, labs' },
    { id: 'purdue', icon: 'schedule', name: 'Schedule', blurb: 'Class meeting times' },
  ]

  return (
    <div className="page">
      <PageTitle>Setup</PageTitle>
      <div className="page-measure">
        <header className="page-head">
          <div>
            <h1 className="page-title">
              {sources.length > 0 ? 'Manage Calendar Sources' : 'Connect Your Calendars'}
            </h1>
            <p className="page-sub">
              Import your assignments and class schedule from Brightspace and your Purdue timetable.
            </p>
          </div>
        </header>

        {bannerEl}

        {/* Linking is not required here (PURDUE_AUTH_MODE=off, as in production),
            so the Purdue step is offered, not enforced: calendars work without
            it, and a verified address opens Marketplace posting (issue #181). */}
        {!user?.hasPurdueLinked ? (
          <section className="card card-pad r-cls mb-5" data-testid="setup-purdue-email">
            <header className="card-head items-start">
              <span className="route-badge">
                <Icon name="graduation" size={18} />
              </span>
              <div>
                <h2 className="card-title">Link your Purdue email</h2>
                <p className="card-sub">
                  Optional. Verify your @purdue.edu address to post on the Marketplace; your calendars work without it.
                </p>
              </div>
            </header>
            <PurdueEmailVerification
              allowDevLink={usesMockPurdue}
              onLinked={() => handlePurdueLinked('Purdue email linked. You can post on the Marketplace now.')}
              submitVariant="secondary"
            />
          </section>
        ) : null}

        {/* Connected Sources */}
        {sources.length > 0 && (
          <section className="card card-pad r-cls mb-5">
            <div className="card-head mb-2">
              <span className="route-badge">
                <Icon name="refresh" size={18} />
              </span>
              <div>
                <h2 className="card-title lowercase first-letter:uppercase">
                  Connected Sources
                </h2>
              </div>
              <button
                type="button"
                onClick={handleSyncAll}
                disabled={syncingAll}
                className="btn btn-secondary btn-sm ml-auto shrink-0"
              >
                {syncingAll ? (
                  <span className="inline-flex items-center gap-2">
                    <Icon name="refresh" size={14} className="animate-spin" />
                    Syncing all…
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="refresh" size={14} />
                    Sync all
                  </span>
                )}
              </button>
            </div>
            <div className="divide-y divide-[var(--color-border)]">
              {sources.map((source) => (
                <div key={source.id} className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="ico h-9 w-9">
                      <Icon name={getSourceIcon(source.sourceType)} size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-display text-[15px] font-bold text-[var(--color-txt-0)]">{source.label}</span>
                        <span className={`badge ${
                          source.status === 'ready'
                            ? 'bg-[var(--color-success)]/12 text-[var(--color-success)]'
                            : source.status === 'error'
                            ? 'bg-[var(--color-error)]/12 text-[var(--color-error)]'
                            : ''
                        }`}>
                          {source.status}
                        </span>
                      </div>
                      <div className="tnum mt-0.5 text-[12.5px] text-[var(--color-txt-2)]">
                        {getSourceTypeLabel(source.sourceType)}
                        {source.lastSyncedAt && (
                          <span className="hidden sm:inline"> · Synced {new Date(source.lastSyncedAt).toLocaleDateString()}</span>
                        )}
                      </div>
                      {source.lastError && (
                        <div className="mt-1 text-[12.5px] text-[var(--color-error)]">{source.lastError}</div>
                      )}
                    </div>
                  </div>
                  <div className="ml-12 flex shrink-0 gap-1.5 sm:ml-0">
                    <button type="button" onClick={() => handleSync(source.id)} disabled={syncingAll} className="btn btn-secondary btn-sm flex-1 sm:flex-none">
                      Sync
                    </button>
                    <button type="button" onClick={() => handleDelete(source.id)} className="icon-btn hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] md:h-[34px] md:w-[34px]">
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Add New Source */}
        <section className="card card-pad r-cls">
          <header className="card-head">
            <span className="route-badge">
              <Icon name="calendar" size={18} />
            </span>
            <div>
              <h2 className="card-title lowercase first-letter:uppercase">
                Add Calendar Source
              </h2>
            </div>
          </header>

          {/* Source Type Toggle: two option cards, one choice. The chosen one
              takes an ink edge and a filled ink dot, never amber; the round
              marker reads as a single choice, not a checklist. */}
          <div className="mb-5 grid grid-cols-2 gap-2 sm:gap-3">
            {sourceOptions.map((option) => {
              const isSelected = sourceType === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => { setSourceType(option.id); setUrlError('') }}
                  className={`card flex flex-col items-stretch gap-1 p-3 text-left sm:p-4 ${
                    isSelected
                      ? 'border-[var(--color-txt-0)] bg-[var(--color-surface)] shadow-[inset_0_0_0_1px_var(--color-txt-0)]'
                      : ''
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="route-badge">
                      <Icon name={option.icon} size={18} />
                    </span>
                    <span
                      aria-hidden="true"
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-[1.5px] ${
                        isSelected ? 'border-[var(--color-txt-0)]' : 'border-[var(--color-border-3)]'
                      }`}
                    >
                      {isSelected ? <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-txt-0)]" /> : null}
                    </span>
                  </span>
                  <span className="mt-1 font-display text-[15px] font-bold leading-tight text-[var(--color-txt-0)]">{option.name}</span>
                  <span className="block text-[12.5px] leading-snug text-[var(--color-txt-2)] sm:text-[13px]">
                    {option.blurb}
                  </span>
                </button>
              )
            })}
          </div>

          {/* How to get the link (issue #120): the provider's steps drawn as a
              three-stop line, a link that opens it in a new tab, and the
              privacy note. */}
          <div className="mb-5 border-t border-[var(--color-border)] pt-4" data-testid="source-steps">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <h3 className="eyebrow">How to get the link</h3>
              <a
                href={PROVIDER_LINKS[sourceType as ScheduleSourceKind].href}
                target="_blank"
                rel="noreferrer"
                className="head-link"
              >
                Open {PROVIDER_LINKS[sourceType as ScheduleSourceKind].label}
                <Icon name="external" size={14} />
              </a>
            </div>
            <ol>
              {config.steps.map((step, index) => {
                const last = index === config.steps.length - 1
                return (
                  <li key={step} className="flex gap-3">
                    <span aria-hidden="true" className="relative flex w-6 shrink-0 justify-center">
                      {last ? null : <span className="absolute bottom-0 top-6 w-[3px] bg-[var(--route)]" />}
                      <span
                        className={`relative grid h-6 w-6 place-items-center rounded-full font-display text-[11px] font-extrabold tnum ${
                          last
                            ? 'bg-[var(--route)] text-[var(--route-on)]'
                            : 'border-[3px] border-[var(--route)] bg-[var(--color-surface)] text-[var(--route-text)]'
                        }`}
                      >
                        {index + 1}
                      </span>
                    </span>
                    {/* The bottom padding sits on the text, not the li, so the
                        stop column stretches far enough to draw the track. */}
                    <span className={`min-w-0 pt-0.5 text-[14px] leading-snug text-[var(--color-txt-1)] ${last ? '' : 'pb-4'}`}>{step}</span>
                  </li>
                )
              })}
            </ol>
            <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--color-txt-2)]">
              The link is read-only and personal to you, so keep it private. BoilerIndy never asks for your Purdue password.
            </p>
          </div>

          {/* URL Input Form */}
          <form onSubmit={handleConnect} noValidate className="border-t border-[var(--color-border)] pt-4">
            <div className="mb-4">
              <label htmlFor="source-ics-url" className="mb-1.5 block text-[13px] font-semibold text-[var(--color-txt-1)]">
                iCalendar Feed URL
              </label>
              <textarea
                id="source-ics-url"
                value={icsUrl}
                onChange={(e) => { setIcsUrl(e.target.value); if (urlError) setUrlError('') }}
                className={`input min-h-[96px] resize-y font-mono text-[13px] ${urlError ? 'border-[var(--color-error)]' : ''}`}
                placeholder={config.placeholder}
                aria-invalid={urlError ? true : undefined}
                aria-describedby="source-ics-url-hint"
                required
              />
              {urlError ? (
                <p id="source-ics-url-hint" role="alert" className="mt-1.5 text-[13px] font-medium text-[var(--color-error)]">
                  {urlError}
                </p>
              ) : (
                <p id="source-ics-url-hint" className="mt-1.5 text-[12px] text-[var(--color-txt-2)]">
                  {config.helpText}
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={!icsUrl.trim() || saving}
              className="btn btn-primary w-full sm:w-auto"
            >
              <Icon name={config.icon} size={16} />
              {saving ? 'Connecting…' : `Connect ${sourceType === 'brightspace' ? 'Brightspace' : 'Schedule'}`}
            </button>
          </form>
        </section>

        {/* Footer links */}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex justify-center gap-2 sm:justify-start">
            <Link to="/assignments" className="head-link mx-0 min-h-[44px] gap-1.5 sm:-ml-2">
              <Icon name="document" size={15} />
              View Tasks
            </Link>
            <Link to="/schedule" className="head-link mx-0 min-h-[44px] gap-1.5">
              <Icon name="schedule" size={15} />
              View Schedule
            </Link>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <button
              type="button"
              onClick={handleSkipSetup}
              className="btn btn-ghost w-full sm:w-auto"
              title="Go to the dashboard and stop showing this setup screen at login"
            >
              Don&rsquo;t ask again
            </button>
            <button type="button" onClick={() => navigate('/dashboard')} className="btn btn-secondary w-full sm:w-auto">
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
