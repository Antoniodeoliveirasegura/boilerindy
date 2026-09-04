import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icons'
import {
  availabilityLabel,
  directionsUrl,
  fetchParkingSnapshot,
  formatUpdated,
  STATUS_LABEL,
  statusTone,
  type Garage,
  type ParkingSnapshot,
  type StatusTone,
} from '../lib/parking'

// Live garage availability for the six ST-permit garages (issue #14). Data is
// IU Parking's public lot-count page, parsed and cached by /api/parking/garages.

const REFRESH_MS = 60_000

const TONE: Record<StatusTone, { pill: string; bar: string; dot: string }> = {
  ok: {
    pill: 'bg-[var(--color-success)]/15 text-[var(--color-success)]',
    bar: 'bg-[var(--color-success)]',
    dot: 'bg-[var(--color-success)]',
  },
  warn: {
    pill: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    bar: 'bg-amber-500',
    dot: 'bg-amber-500',
  },
  bad: {
    pill: 'bg-[var(--color-error)]/15 text-[var(--color-error)]',
    bar: 'bg-[var(--color-error)]',
    dot: 'bg-[var(--color-error)]',
  },
  muted: {
    pill: 'bg-[var(--color-txt-3)]/15 text-[var(--color-txt-2)]',
    bar: 'bg-[var(--color-txt-3)]',
    dot: 'bg-[var(--color-txt-3)]',
  },
}

function GarageCard({ garage, now }: { garage: Garage; now: Date }) {
  const tone = TONE[statusTone(garage.status)]
  const percent = garage.percentFull ?? 0
  return (
    <article className="card p-4 sm:p-5 flex flex-col gap-3" data-garage-id={garage.id} data-garage-status={garage.status}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-[var(--color-txt-0)] leading-tight">
            {garage.name}
            {garage.code ? (
              <span className="ml-2 align-middle text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-gold)]/20 text-[var(--color-gold)]">
                {garage.code}
              </span>
            ) : null}
          </h2>
          {garage.address ? (
            <p className="text-[12px] text-[var(--color-txt-2)] mt-0.5 flex items-center gap-1">
              <Icon name="mapPin" size={12} />
              {garage.address}
            </p>
          ) : null}
        </div>
        <span className={`shrink-0 text-[11px] font-semibold px-2 py-1 rounded-full ${tone.pill}`}>{STATUS_LABEL[garage.status]}</span>
      </div>

      <div>
        <div
          className="h-2 rounded-full bg-[var(--color-bg-2)] overflow-hidden"
          role="progressbar"
          aria-label={`${garage.name} occupancy`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={garage.percentFull ?? undefined}
        >
          <div className={`h-full rounded-full transition-all ${tone.bar}`} style={{ width: `${garage.status === 'unknown' ? 0 : percent}%` }} />
        </div>
        <div className="flex items-center justify-between gap-3 mt-2 text-[12px]">
          <span className="font-medium text-[var(--color-txt-1)]">{availabilityLabel(garage)}</span>
          <span className={garage.stale ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--color-txt-3)]'}>
            {garage.status === 'unknown' && !garage.updatedAt ? 'Sensors offline' : formatUpdated(garage.updatedAt, now)}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <span className="text-[var(--color-txt-2)]">
          {garage.stRule ? `ST permit: ${garage.stRule}` : garage.type || ''}
        </span>
        <span className="flex items-center gap-3">
          <Link to="/map?layer=parking" className="text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)] inline-flex items-center gap-1">
            <Icon name="mapPin" size={12} /> Map
          </Link>
          <a
            href={directionsUrl(garage)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-gold)] hover:underline inline-flex items-center gap-1"
          >
            Directions <Icon name="arrowUpRight" size={12} />
          </a>
        </span>
      </div>
    </article>
  )
}

export default function Parking() {
  const [snapshot, setSnapshot] = useState<ParkingSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const snap = await fetchParkingSnapshot(signal)
      setSnapshot(snap)
      setRequestError(null)
      setNow(new Date())
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return
      setRequestError((error as Error)?.message || 'Could not load parking status.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load])

  const garages = snapshot?.garages ?? []
  const permits = snapshot?.permits
  const openSpaces = garages.reduce((sum, g) => sum + (g.available ?? 0), 0)
  const knownCount = garages.filter((g) => g.status !== 'unknown').length

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-txt-3)] mb-1">Purdue Indianapolis</p>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Campus Parking</h1>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
            Live availability in the six garages an ST student permit is valid in.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-[var(--color-txt-2)]">
          {snapshot ? (
            <span>
              {knownCount > 0 ? `${openSpaces.toLocaleString()} spaces open across ${knownCount} garage${knownCount === 1 ? '' : 's'}` : 'No live counts right now'}
            </span>
          ) : null}
          <button type="button" onClick={() => void load()} className="btn btn-secondary text-[12px] px-3 py-1.5 inline-flex items-center gap-1.5">
            <Icon name="refresh" size={12} /> Refresh
          </button>
        </div>
      </div>

      {requestError ? (
        <div className="card p-4 mb-6 text-[13px] text-[var(--color-error)] border-[var(--color-error)]/30">
          {requestError}
        </div>
      ) : null}

      {snapshot && !snapshot.ok ? (
        <div className="card p-4 mb-6 text-[13px] text-[var(--color-txt-1)] flex items-start gap-3" data-parking-degraded>
          <Icon name="info" size={16} className="shrink-0 mt-0.5 text-[var(--color-txt-2)]" />
          <p className="m-0">
            Live counts are unavailable right now, so this is the garage list without occupancy. IU Parking&apos;s feed usually
            comes back within a few minutes.
          </p>
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className="grid sm:grid-cols-2 gap-4 mb-8" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="card p-5 space-y-3">
              <div className="h-4 w-40 rounded bg-[var(--color-stat)]" />
              <div className="h-2 w-full rounded bg-[var(--color-stat)]" />
              <div className="h-3 w-28 rounded bg-[var(--color-stat)]" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4 mb-8">
          {garages.map((g) => (
            <GarageCard key={g.id} garage={g} now={now} />
          ))}
        </div>
      )}

      {permits ? (
        <section className="mb-8" aria-labelledby="parking-permits-heading">
          <h2 id="parking-permits-heading" className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-txt-3)] mb-3">
            Student permits
          </h2>
          <div className="grid md:grid-cols-2 gap-4">
            {permits.permits.map((permit) => (
              <div key={permit.code} className="card p-4 sm:p-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-gold)]/20 text-[var(--color-gold)]">{permit.code}</span>
                  <h3 className="text-[15px] font-semibold text-[var(--color-txt-0)] m-0">{permit.name}</h3>
                </div>
                <dl className="text-[13px] text-[var(--color-txt-1)] space-y-2 m-0">
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-[var(--color-txt-3)]">Who</dt>
                    <dd className="m-0">{permit.eligibility}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-[var(--color-txt-3)]">Where it is valid</dt>
                    <dd className="m-0">{permit.valid}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-[var(--color-txt-3)]">Evenings and weekends</dt>
                    <dd className="m-0">{permit.afterHours}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
          <div className="card p-4 sm:p-5 mt-4">
            <ul className="list-none m-0 p-0 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
              {permits.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-[var(--color-gold)] hover:underline inline-flex items-center gap-1">
                    {link.label} <Icon name="arrowUpRight" size={12} />
                  </a>
                </li>
              ))}
            </ul>
            <ul className="list-disc pl-5 mt-3 mb-0 text-[12px] text-[var(--color-txt-2)] space-y-1">
              {permits.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {snapshot ? (
        <p className="text-[11px] text-[var(--color-txt-3)]">
          Counts from{' '}
          <a href={snapshot.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">
            IU Parking&apos;s live garage page
          </a>
          , refreshed about once a minute. Status is unofficial: a garage reads as full at 10 or fewer spaces left.
        </p>
      ) : null}
    </div>
  )
}
