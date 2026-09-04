import { useEffect, useState } from 'react'
import { CircleMarker, Popup, Tooltip } from 'react-leaflet'
import { Link } from 'react-router-dom'
import {
  availabilityLabel,
  directionsUrl,
  fetchParkingSnapshot,
  formatUpdated,
  STATUS_LABEL,
  type Garage,
  type GarageStatus,
} from '../../lib/parking'

const REFRESH_MS = 60_000

const FILL: Record<GarageStatus, string> = {
  open: '#16a34a',
  busy: '#f59e0b',
  full: '#dc2626',
  unknown: '#9ca3af',
}

/**
 * Live garage pins for the campus map (issue #14). Self-contained: fetches the
 * snapshot when shown, refreshes once a minute, and renders nothing when the
 * layer is off so it costs nothing until a student asks for it.
 */
export default function ParkingGarageLayer({ visible }: { visible: boolean }) {
  const [garages, setGarages] = useState<Garage[]>([])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const controller = new AbortController()
    const load = () =>
      fetchParkingSnapshot(controller.signal)
        .then((snap) => {
          if (!cancelled) setGarages(snap.garages)
        })
        .catch(() => {
          // Keep whatever was last drawn; the parking page explains outages.
        })
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [visible])

  if (!visible) return null

  return (
    <>
      {garages.map((g) => {
        if (g.lat == null || g.lng == null) return null
        return (
          <CircleMarker
            key={g.id}
            center={[g.lat, g.lng]}
            radius={11}
            pathOptions={{ color: '#ffffff', weight: 2, fillColor: FILL[g.status], fillOpacity: 0.95 }}
          >
            <Tooltip permanent direction="top" offset={[0, -8]} className="parking-count-tooltip">
              {g.available != null ? g.available.toLocaleString() : '?'}
            </Tooltip>
            <Popup>
              <div style={{ minWidth: 180 }}>
                <strong>{g.name}</strong>
                {g.code ? <span style={{ opacity: 0.7 }}> ({g.code})</span> : null}
                <div style={{ marginTop: 4 }}>
                  {STATUS_LABEL[g.status]}
                  {' · '}
                  {availabilityLabel(g)}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>{formatUpdated(g.updatedAt)}</div>
                {g.stRule ? <div style={{ fontSize: 12, marginTop: 4 }}>ST permit: {g.stRule}</div> : null}
                <div style={{ marginTop: 8, display: 'flex', gap: 10, fontSize: 12 }}>
                  <a href={directionsUrl(g)} target="_blank" rel="noopener noreferrer">
                    Directions
                  </a>
                  <Link to="/parking">All garages</Link>
                </div>
              </div>
            </Popup>
          </CircleMarker>
        )
      })}
    </>
  )
}
