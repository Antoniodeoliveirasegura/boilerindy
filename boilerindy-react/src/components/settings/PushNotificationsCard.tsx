import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../Icons'
import {
  DEFAULT_PUSH_SETTINGS,
  LEAD_MINUTE_OPTIONS,
  describePushSupport,
  describeTestResult,
  fetchPushConfig,
  fetchPushSettings,
  formatLeadMinutes,
  getCurrentPushSubscription,
  readPushSupportEnv,
  registerPushSubscription,
  savePushSettings,
  sendTestPush,
  subscribeThisDevice,
  unsubscribeThisDevice,
  type PushSettings,
  type PushSupport,
} from '../../lib/push'

// Push notifications card on Settings (issue #9). Self-contained: on mount it
// loads the public config, the user's settings and this browser's
// subscription, then talks to /api/push/* directly. Errors stay inside the
// card; nothing here uses alert().

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'disabled'; message: string }
  | { kind: 'ready'; publicKey: string }

type Busy = 'subscribe' | 'unsubscribe' | 'test' | null

const SERVER_OFF_MESSAGE = 'Push notifications are not switched on for this server yet.'
const BLOCKED_MESSAGE =
  'Notifications are blocked for BoilerIndy in this browser. Open the site settings (the lock icon next to the address bar), allow notifications, then reload this page.'

const LABEL_CLASS = 'text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4'
const STATUS_CLASS = 'text-[13px] text-[var(--color-txt-2)] mt-3'

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function currentPermission(): NotificationPermission | null {
  return typeof Notification === 'undefined' ? null : Notification.permission
}

export default function PushNotificationsCard() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [support] = useState<PushSupport>(() => describePushSupport(readPushSupportEnv()))
  const [permission, setPermission] = useState<NotificationPermission | null>(currentPermission)
  const [settings, setSettings] = useState<PushSettings>(DEFAULT_PUSH_SETTINGS)
  const [deviceCount, setDeviceCount] = useState(0)
  const [thisDeviceOn, setThisDeviceOn] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Genuine external reads on mount (config, settings, local subscription).
  useEffect(() => {
    let active = true
    async function load() {
      const config = await fetchPushConfig()
      if (!config.enabled || !config.publicKey) {
        if (active) setPhase({ kind: 'disabled', message: SERVER_OFF_MESSAGE })
        return
      }
      const [server, subscription] = await Promise.all([fetchPushSettings(), getCurrentPushSubscription()])
      if (!active) return
      if (server.notConfiguredMessage || !server.enabled) {
        setPhase({ kind: 'disabled', message: server.notConfiguredMessage || SERVER_OFF_MESSAGE })
        return
      }
      let count = server.subscriptions.length
      if (subscription) {
        // Re-registering is an upsert by endpoint, so this quietly heals a
        // wiped table on every visit and keeps the stored user agent fresh.
        try {
          await registerPushSubscription(subscription)
          if (count === 0) count = (await fetchPushSettings()).subscriptions.length
        } catch {
          /* best-effort: the device still works if the server already knows it */
        }
        if (!active) return
      }
      setSettings(server.settings)
      setDeviceCount(count)
      setThisDeviceOn(subscription !== null)
      setPhase({ kind: 'ready', publicKey: config.publicKey })
    }
    load().catch((err: unknown) => {
      if (active) setPhase({ kind: 'error', message: errorText(err, 'Could not load your push notification settings.') })
    })
    return () => {
      active = false
    }
  }, [])

  async function refreshDeviceCount() {
    try {
      const server = await fetchPushSettings()
      setDeviceCount(server.subscriptions.length)
    } catch {
      /* the count is decorative */
    }
  }

  async function handleEnable() {
    if (phase.kind !== 'ready' || busy) return
    setBusy('subscribe')
    setError('')
    setNotice('')
    try {
      const result = await subscribeThisDevice(phase.publicKey)
      setPermission(currentPermission())
      if (result.ok) {
        setThisDeviceOn(true)
        setNotice('Notifications are on for this device.')
        await refreshDeviceCount()
      } else {
        setError(result.message)
      }
    } catch (err) {
      setError(errorText(err, 'Could not turn on notifications on this device.'))
    } finally {
      setBusy(null)
    }
  }

  async function handleDisable() {
    if (busy) return
    setBusy('unsubscribe')
    setError('')
    setNotice('')
    try {
      const result = await unsubscribeThisDevice()
      if (result.ok) {
        setThisDeviceOn(false)
        setNotice(result.message || 'Notifications are off for this device.')
        await refreshDeviceCount()
      } else {
        setError(result.message || 'Could not turn off notifications on this device.')
      }
    } catch (err) {
      setError(errorText(err, 'Could not turn off notifications on this device.'))
    } finally {
      setBusy(null)
    }
  }

  async function handleTest() {
    if (busy) return
    setBusy('test')
    setError('')
    setNotice('')
    try {
      const result = await sendTestPush()
      setNotice(describeTestResult(result))
      if (result.removed > 0) await refreshDeviceCount()
    } catch (err) {
      setError(errorText(err, 'Could not send a test notification.'))
    } finally {
      setBusy(null)
    }
  }

  // Optimistic: the control flips at once and only the touched keys roll
  // back if the save fails, so a quick second change is never clobbered.
  async function updateSettings(patch: Partial<PushSettings>) {
    const previous = settings
    setSettings((current) => ({ ...current, ...patch }))
    setError('')
    try {
      const saved = await savePushSettings(patch)
      setSettings((current) => ({
        ...current,
        ...(patch.deadlineReminders !== undefined ? { deadlineReminders: saved.deadlineReminders } : {}),
        ...(patch.leadMinutes !== undefined ? { leadMinutes: saved.leadMinutes } : {}),
      }))
    } catch (err) {
      setSettings((current) => ({
        ...current,
        ...(patch.deadlineReminders !== undefined ? { deadlineReminders: previous.deadlineReminders } : {}),
        ...(patch.leadMinutes !== undefined ? { leadMinutes: previous.leadMinutes } : {}),
      }))
      setError(errorText(err, 'Could not save your reminder settings.'))
    }
  }

  let body: ReactNode
  if (phase.kind === 'loading') {
    body = (
      <p data-testid="push-status" className={STATUS_CLASS}>
        Checking this device…
      </p>
    )
  } else if (phase.kind === 'error') {
    body = (
      <p data-testid="push-status" className="text-[13px] text-[var(--color-error)] mt-3">
        {phase.message}
      </p>
    )
  } else if (phase.kind === 'disabled') {
    body = (
      <p data-testid="push-status" className={STATUS_CLASS}>
        {phase.message}
      </p>
    )
  } else {
    // The server accepts any 5..10080, so a value saved elsewhere still shows.
    const leadOptions: readonly number[] = LEAD_MINUTE_OPTIONS.includes(settings.leadMinutes)
      ? LEAD_MINUTE_OPTIONS
      : [...LEAD_MINUTE_OPTIONS, settings.leadMinutes].sort((a, b) => a - b)
    const blocked = support.supported && permission === 'denied' && !thisDeviceOn

    body = (
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {support.supported && thisDeviceOn && (
            <button
              type="button"
              data-testid="push-disable"
              onClick={handleDisable}
              disabled={busy !== null}
              className="btn btn-secondary text-[13px] px-4 py-2 disabled:opacity-50"
            >
              <Icon name="close" size={14} />
              {busy === 'unsubscribe' ? 'Turning off…' : 'Turn off on this device'}
            </button>
          )}
          {support.supported && !thisDeviceOn && !blocked && (
            <button
              type="button"
              data-testid="push-enable"
              onClick={handleEnable}
              disabled={busy !== null}
              className="btn btn-primary text-[13px] px-4 py-2 disabled:opacity-50"
            >
              <Icon name="bell" size={14} />
              {busy === 'subscribe' ? 'Turning on…' : 'Turn on for this device'}
            </button>
          )}
          <span data-testid="push-status" className="text-[12px] text-[var(--color-txt-2)]">
            On for {deviceCount} {deviceCount === 1 ? 'device' : 'devices'}
            {thisDeviceOn ? ', including this one' : ''}
          </span>
        </div>

        {!support.supported && (
          <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">
            {support.message}
            {support.reason === 'ios-not-installed' && (
              <>
                {' '}
                <Link to="/install" className="text-[var(--color-accent)] hover:underline">
                  See the step-by-step guide
                </Link>
                .
              </>
            )}
          </p>
        )}
        {blocked && <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">{BLOCKED_MESSAGE}</p>}

        <div className="pt-4 border-t border-[var(--color-border)] space-y-3">
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="push-deadline-toggle"
              checked={settings.deadlineReminders}
              onChange={(e) => updateSettings({ deadlineReminders: e.target.checked })}
              className="w-4 h-4 mt-0.5 rounded border-[var(--color-border-2)] accent-[var(--color-gold)]"
            />
            <span>
              <span className="block text-[13px] font-medium text-[var(--color-txt-0)]">Deadline reminders</span>
              <span className="block text-[12px] text-[var(--color-txt-2)] mt-0.5 leading-relaxed">
                One notification per assignment ahead of its due time, on every device you turn on.
              </span>
            </span>
          </label>
          <div>
            <label htmlFor="push-lead-minutes" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">
              Remind me
            </label>
            <select
              id="push-lead-minutes"
              data-testid="push-lead-select"
              value={settings.leadMinutes}
              disabled={!settings.deadlineReminders}
              onChange={(e) => {
                const next = Number(e.target.value)
                if (Number.isInteger(next)) updateSettings({ leadMinutes: next })
              }}
              className="input w-full text-[13px] px-3 py-2 disabled:opacity-50"
            >
              {leadOptions.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {formatLeadMinutes(minutes)} before
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="button"
          data-testid="push-test"
          onClick={handleTest}
          disabled={!thisDeviceOn || busy !== null}
          className="btn btn-secondary text-[13px] px-4 py-2 disabled:opacity-50"
        >
          <Icon name="send" size={14} />
          {busy === 'test' ? 'Sending…' : 'Send a test notification'}
        </button>

        {notice && <p className="text-[13px] text-[var(--color-success)]">{notice}</p>}
        {error && <p className="text-[13px] text-[var(--color-error)]">{error}</p>}
      </div>
    )
  }

  return (
    <div className="card p-5" data-testid="push-card">
      <div className={LABEL_CLASS}>Push notifications</div>
      <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">
        Get a heads-up before assignments are due, even when BoilerIndy is closed.
      </p>
      {body}
    </div>
  )
}
