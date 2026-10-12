import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icons'
import {
  availabilityLabel,
  directionsUrl,
  formatUpdated,
  STATUS_LABEL,
  statusTone,
  type Garage,
  type StatusTone,
} from '../lib/parking'
import { errorMessage, useParking } from '../lib/queries/publicData'
import PageTitle from '../components/PageTitle'

// Live garage availability for the six ST-permit garages (issue #14). Data is
// IU Parking's public lot-count page, parsed and cached by /api/parking/garages.

// Status tones: semantic fills, not route colours. Amber only for "Filling up",
// the one that is urgent.
const TONE: Record<StatusTone, { badge: string; bar: string }> = {
  ok: {
    badge: 'bg-[var(--color-success)]/14 text-[var(--color-success)]',
    bar: 'bg-[var(--color-success)]',
  },
  warn: {
    badge: 'bg-[var(--color-gold)]/24 text-[var(--color-warning)]',
    bar: 'bg-[var(--color-gold)]',
  },
  bad: {
    badge: 'bg-[var(--color-error)]/14 text-[var(--color-error)]',
    bar: 'bg-[var(--color-error)]',
  },
  muted: {
    badge: 'bg-[var(--color-stat)] text-[var(--color-txt-2)]',
    bar: 'bg-[var(--color-txt-3)]',
  },
}

// One garage as a departures row: who and where, the occupancy line, then
// the status and the ways to get there. Phones: the status sits beside the
// name, the occupancy line runs full width under them, the links close it.
// From md: name | occupancy | status over links. The row leads with the name
// and its code plate, solid in the Shuttles line: the code tells the garages
// apart, so no repeated icon badge.
const ROW_GRID =
  "grid gap-x-4 gap-y-3 py-4 grid-cols-[minmax(0,1fr)_auto] [grid-template-areas:'id_st'_'occ_occ'_'lnk_lnk'] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] md:gap-x-8 md:gap-y-2 md:[grid-template-areas:'id_occ_st'_'id_occ_lnk']"

function GarageRow({ garage, now }: { garage: Garage; now: Date }) {
  const tone = TONE[statusTone(garage.status)]
  const percent = garage.percentFull ?? 0
  const permitLine = garage.stRule ? `ST permit: ${garage.stRule}` : garage.type || ''
  return (
    <article className={ROW_GRID} data-garage-id={garage.id} data-garage-status={garage.status}>
      <div className="[grid-area:id] md:self-center min-w-0">
        <h2 className="text-[16px] leading-tight text-[var(--color-txt-0)]">
          {garage.name}
          {garage.code ? <span className="code solid ml-2 align-[2px]">{garage.code}</span> : null}
        </h2>
        {garage.address ? (
          <p className="text-[12.5px] text-[var(--color-txt-2)] mt-1 flex items-center gap-1">
            <Icon name="mapPin" size={12} />
            {garage.address}
          </p>
        ) : null}
        {permitLine ? <p className="text-[12.5px] text-[var(--color-txt-2)] mt-0.5">{permitLine}</p> : null}
      </div>

      <span className={`[grid-area:st] self-start md:self-end justify-self-end badge ${tone.badge}`}>{STATUS_LABEL[garage.status]}</span>

      <div className="[grid-area:occ] md:self-center min-w-0">
        <div
          className="h-2 rounded-[2px] bg-[var(--color-bg-2)] dark:bg-[var(--color-bg-3)] overflow-hidden"
          role="progressbar"
          aria-label={`${garage.name} occupancy`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={garage.percentFull ?? undefined}
        >
          <div className={`h-full ${tone.bar}`} style={{ width: `${garage.status === 'unknown' ? 0 : percent}%` }} />
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mt-2">
          <span className="font-display font-bold text-[14px] text-[var(--color-txt-0)] tnum">{availabilityLabel(garage)}</span>
          <span className={`text-[12px] tnum ${garage.stale ? 'text-[var(--color-warning)]' : 'text-[var(--color-txt-3)]'}`}>
            {garage.status === 'unknown' && !garage.updatedAt ? 'Sensors offline' : formatUpdated(garage.updatedAt, now)}
          </span>
        </div>
      </div>

      {/* Phones: each link is a 44px target; the row closes on them. */}
      <span className="[grid-area:lnk] -my-2.5 md:my-0 md:self-start md:justify-self-end flex items-center gap-5 md:gap-3 font-display font-bold text-[13px] md:text-[12.5px]">
        <Link
          to="/map?layer=parking"
          className="inline-flex items-center gap-1 min-h-11 md:min-h-0 text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]"
        >
          <Icon name="mapPin" size={12} /> Map
        </Link>
        <a
          href={directionsUrl(garage)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 min-h-11 md:min-h-0 text-[var(--color-accent)] hover:underline underline-offset-2"
        >
          Directions <Icon name="arrowUpRight" size={12} />
        </a>
      </span>
    </article>
  )
}

export default function Parking() {
  // Through the shared query cache (issue #251): the last snapshot paints at
  // once, the minute refresh pauses while the tab is hidden, and the campus
  // map's garage layer reads the same entry. A failed refresh keeps the last
  // snapshot on screen and shows the message beside it.
  const parkingQuery = useParking()
  const snapshot = parkingQuery.data ?? null
  const loading = parkingQuery.isPending
  const requestError = parkingQuery.isError ? errorMessage(parkingQuery.error, 'Could not load parking status.') : null
  // The clock the "Updated n min ago" labels are measured against. It ticks
  // while the page is open, so a snapshot restored from storage the next
  // morning reads "Updated 14 h ago" rather than "just now".
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const garages = snapshot?.garages ?? []
  const permits = snapshot?.permits
  const openSpaces = garages.reduce((sum, g) => sum + (g.available ?? 0), 0)
  const knownCount = garages.filter((g) => g.status !== 'unknown').length

  return (
    <div className="page">
      <PageTitle>Campus Parking</PageTitle>
      <header className="page-head">
        <div>
          <p className="eyebrow">Purdue Indianapolis</p>
          <h1 className="page-title">Campus Parking</h1>
          <p className="page-sub">
            Live availability in the six garages an ST student permit is valid in.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {snapshot ? (
            <span className="inline-flex items-center gap-2 font-display font-bold text-[13px] text-[var(--color-txt-1)] tnum">
              {knownCount > 0 ? <span className="live-dot" aria-hidden="true" /> : null}
              {knownCount > 0 ? `${openSpaces.toLocaleString()} spaces open across ${knownCount} garage${knownCount === 1 ? '' : 's'}` : 'No live counts right now'}
            </span>
          ) : null}
          <button type="button" onClick={() => void parkingQuery.refetch()} className="btn btn-secondary btn-sm">
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </div>
      </header>

      {requestError ? (
        <div className="card p-4 mb-5 text-[13px] text-[var(--color-error)] border-[var(--color-error)]/30">
          {requestError}
        </div>
      ) : null}

      {snapshot && !snapshot.ok ? (
        <div className="card p-4 mb-5 text-[13.5px] text-[var(--color-txt-1)] flex items-start gap-3" data-parking-degraded>
          <Icon name="info" size={16} className="shrink-0 mt-0.5 text-[var(--color-txt-2)]" />
          <p className="m-0">
            Live counts are unavailable right now, so this is the garage list without occupancy. IU Parking&apos;s feed usually
            comes back within a few minutes.
          </p>
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className="card card-pad mb-8 divide-y divide-[var(--color-border)]" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 py-4 first:pt-0 last:pb-0">
              <div className="skeleton w-8 h-8 shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-40" />
                <div className="skeleton h-3 w-28" />
              </div>
              <div className="skeleton h-2 w-1/3 hidden md:block" />
            </div>
          ))}
        </div>
      ) : garages.length > 0 ? (
        <section className="card px-4 sm:px-5 py-1 mb-8 r-bus divide-y divide-[var(--color-border)]">
          {garages.map((g) => (
            <GarageRow key={g.id} garage={g} now={now} />
          ))}
        </section>
      ) : null}

      {permits ? (
        <section className="mb-8" aria-labelledby="parking-permits-heading">
          <h2 id="parking-permits-heading" className="eyebrow mb-4">
            Student permits
          </h2>
          <div className="grid md:grid-cols-2 gap-4 items-start">
            {permits.permits.map((permit) => (
              <div key={permit.code} className="card card-pad r-bus">
                <div className="card-head mb-3">
                  <span className="code solid text-[12px] px-2 py-[5px]">{permit.code}</span>
                  <h3 className="card-title m-0">{permit.name}</h3>
                </div>
                <dl className="m-0 divide-y divide-[var(--color-border)]">
                  <div className="py-2.5 first:pt-0">
                    <dt className="eyebrow bare flex mb-1.5">Who</dt>
                    <dd className="m-0 text-[14px] text-[var(--color-txt-1)]">{permit.eligibility}</dd>
                  </div>
                  <div className="py-2.5">
                    <dt className="eyebrow bare flex mb-1.5">Where it is valid</dt>
                    <dd className="m-0 text-[14px] text-[var(--color-txt-1)]">{permit.valid}</dd>
                  </div>
                  <div className="py-2.5 last:pb-0">
                    <dt className="eyebrow bare flex mb-1.5">Evenings and weekends</dt>
                    <dd className="m-0 text-[14px] text-[var(--color-txt-1)]">{permit.afterHours}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
          <div className="card card-pad mt-4">
            <ul className="list-none -my-2.5 md:my-0 p-0 grid sm:grid-cols-2 gap-x-6 md:gap-y-2.5 font-display font-bold text-[13.5px]">
              {permits.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline underline-offset-2 inline-flex items-center gap-1 min-h-11 md:min-h-0">
                    {link.label} <Icon name="arrowUpRight" size={12} />
                  </a>
                </li>
              ))}
            </ul>
            <ul className="list-disc pl-5 mt-3.5 mb-0 text-[12.5px] text-[var(--color-txt-2)] space-y-1">
              {permits.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {snapshot ? (
        <p className="text-[12px] text-[var(--color-txt-3)]">
          Counts from{' '}
          <a href={snapshot.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-[var(--color-txt-1)]">
            IU Parking&apos;s live garage page
          </a>
          , refreshed about once a minute. Status is unofficial: a garage reads as full at 10 or fewer spaces left.
        </p>
      ) : null}
    </div>
  )
}
