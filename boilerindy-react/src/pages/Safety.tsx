import Icon from '../components/Icons'
import PageTitle from '../components/PageTitle'
import { AlertCard } from '../components/CampusAlertBanner'
import { PURDUE_ALERT_SIGNUP_URL, lastCheckedLine, visibleAlert } from '../lib/campusAlert'
import { useCampusAlert } from '../lib/queries/publicData'

// Where a campus alert push opens (issue #550, item 9; issue #34):
// /safety?incident=<id>. IU's alert for the Indianapolis campus as the banner
// shows it, without the button that hides it, or a line saying there is none.
// The incident in the link is not read: IU's feed holds only its latest
// message, so the page shows what is true now, which after an all clear is no
// alert at all. Public, like the preview pages, so a tap opens it signed in or
// not; AppLayout leaves the banner off this page. docs/campus-alerts.md.

function StatusCard({ children }: { children: string }) {
  return (
    <div className="card card-pad flex items-start gap-3 text-[14px] text-[var(--color-txt-1)]" role="status">
      <Icon name="info" size={16} className="shrink-0 mt-0.5 text-[var(--color-txt-2)]" />
      <p className="m-0">{children}</p>
    </div>
  )
}

export default function Safety() {
  const { data, isPending, isError } = useCampusAlert()
  const alert = visibleAlert(data)
  const checked = lastCheckedLine(data?.checkedAt)
  let status: string | null = null
  if (!alert && !isPending) {
    if (isError) status = "BoilerIndy can't reach IU's alerts right now. PurdueALERT texts still reach you."
    else if (!data?.enabled) status = 'Campus alerts are not available on BoilerIndy right now.'
    else status = `No active alert. IU Indianapolis has not reported an emergency on campus.${checked ? ` ${checked}.` : ''}`
  }

  return (
    <div className="page">
      <div className="page-measure">
        <PageTitle>Campus Alerts</PageTitle>
        <header className="page-head">
          <div>
            <p className="eyebrow">Purdue Indianapolis</p>
            <h1 className="page-title">Campus Alerts</h1>
            <p className="page-sub">IU Indianapolis&apos;s emergency alerts for the campus, in IU&apos;s words.</p>
          </div>
        </header>

        {alert ? (
          <section aria-label="Campus alert" data-testid="safety-alert">
            <AlertCard alert={alert} checkedLine={data?.stale ? checked : null} />
          </section>
        ) : status ? (
          <StatusCard>{status}</StatusCard>
        ) : (
          <div className="card card-pad" aria-busy="true">
            <div className="skeleton h-4 w-2/3" />
          </div>
        )}

        <p className="mt-5 text-[13.5px] leading-[1.55] text-[var(--color-txt-2)]">
          BoilerIndy repeats IU&apos;s alerts; it is not an alert service. PurdueALERT texts are the official channel for
          Purdue students in Indianapolis:{' '}
          <a
            href={PURDUE_ALERT_SIGNUP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[var(--color-txt-1)] underline underline-offset-2 hover:text-[var(--color-txt-0)]"
          >
            get PurdueALERT texts
          </a>
          .
        </p>
      </div>
    </div>
  )
}
