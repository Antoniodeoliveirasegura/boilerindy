import { useEffect, useState } from 'react'
import Icon from './Icons'
import {
  PURDUE_ALERT_SIGNUP_URL,
  alertKey,
  alertSentLine,
  lastCheckedLine,
  readHiddenAlert,
  rememberHiddenAlert,
  visibleAlert,
  type CampusAlert,
  type CampusAlertLevel,
} from '../lib/campusAlert'
import { useCampusAlert } from '../lib/queries/publicData'

// IU's emergency alert for the Indianapolis campus (issue #34), at the top of
// every page AppLayout renders (the signed-in app and the four public preview
// pages) while it is active. The landing page stays data-free and has none.
// IU's words, unchanged, with the source and the time sent:
// IU keeps an alert up until its "Campus Status Normal", which can come
// hours later, so the age matters. BoilerIndy only repeats the alert, so the
// banner always points to PurdueALERT, the official channel. Renders nothing
// while CAMPUS_ALERTS is off or nothing is active. docs/campus-alerts.md.

const CARD_TONES: Record<CampusAlertLevel, string> = {
  danger: 'bg-[var(--color-error)]/10 border-[var(--color-error)]/35 border-l-[var(--color-error)]',
  warning: 'bg-[var(--color-warning)]/10 border-[var(--color-warning)]/35 border-l-[var(--color-warning)]',
  test: 'bg-[var(--color-stat)] border-[var(--color-border-2)] border-l-[var(--color-txt-2)]',
}

const ICON_TONES: Record<CampusAlertLevel, string> = {
  danger: 'text-[var(--color-error)]',
  warning: 'text-[var(--color-warning)]',
  test: 'text-[var(--color-txt-2)]',
}

/** The time now, ticking each minute, so "12 min ago" keeps up while the alert stays on screen. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** One alert as the banner shows it; the /safety page shows it too, without `onHide`, so with no button to hide it. */
export function AlertCard({ alert, checkedLine, onHide }: { alert: CampusAlert; checkedLine: string | null; onHide?: () => void }) {
  const now = useMinuteClock()
  const level = alert.level in CARD_TONES ? alert.level : 'danger'
  return (
    <div className={`flex items-start gap-3 rounded-[var(--radius-lg)] border border-l-4 px-3.5 py-3 md:px-4 ${CARD_TONES[level]}`}>
      <Icon name="alert" size={18} className={`mt-0.5 shrink-0 ${ICON_TONES[level]}`} />
      <div className="min-w-0 flex-1">
        {/* An emergency is announced at once; a test waits for the reader to be idle. */}
        <div role={level === 'test' ? 'status' : 'alert'}>
          <p className="font-display text-[15px] font-extrabold leading-snug text-[var(--color-txt-0)]">
            {alert.test && (
              <span className="mr-2 inline-block rounded-[var(--radius-sm)] border border-[var(--color-border-2)] px-1.5 align-[1px] text-[11px] font-bold uppercase tracking-wide text-[var(--color-txt-2)]">
                Test
              </span>
            )}
            {alert.headline}
          </p>
          {alert.message && <p className="mt-1 text-[14px] leading-[1.5] text-[var(--color-txt-1)]">{alert.message}</p>}
          {alert.instruction && <p className="mt-1 text-[14px] leading-[1.5] text-[var(--color-txt-1)]">{alert.instruction}</p>}
        </div>
        <p className="mt-2 text-[12.5px] leading-snug text-[var(--color-txt-2)]">
          {alertSentLine(alert, now)}
          {checkedLine && ` · ${checkedLine}`}
          {' · '}
          <a
            href={PURDUE_ALERT_SIGNUP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[var(--color-txt-1)] underline underline-offset-2 hover:text-[var(--color-txt-0)]"
          >
            Get PurdueALERT texts
          </a>
        </p>
      </div>
      {onHide && (
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide this alert"
          className="-m-1 shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--color-txt-2)] hover:bg-[var(--color-txt-0)]/5 hover:text-[var(--color-txt-0)]"
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  )
}

export default function CampusAlertBanner({ className = '' }: { className?: string }) {
  const { data } = useCampusAlert()
  const [hidden, setHidden] = useState(() => readHiddenAlert())
  const alert = visibleAlert(data)
  if (!alert) return null
  const key = alertKey(alert)
  if (hidden === key) return null
  const hide = () => {
    rememberHiddenAlert(key)
    setHidden(key)
  }
  return (
    <section aria-label="Campus alert" data-testid="campus-alert" className={`mx-auto w-full max-w-[1200px] px-4 pt-4 md:px-6 ${className}`}>
      <AlertCard alert={alert} checkedLine={data?.stale ? lastCheckedLine(data.checkedAt) : null} onHide={hide} />
    </section>
  )
}
