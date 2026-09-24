import { CircleMarker, Popup, Tooltip } from 'react-leaflet'
import { Link } from 'react-router-dom'
import {
  availabilityLabel,
  directionsUrl,
  formatUpdated,
  STATUS_LABEL,
  type Garage,
  type GarageStatus,
} from '../../lib/parking'
import { useParking } from '../../lib/queries/publicData'

const FILL: Record<GarageStatus, string> = {
  open: '#16a34a',
  busy: '#f59e0b',
  full: '#dc2626',
  unknown: '#9ca3af',
}

/**
 * Live garage pins for the campus map (issue #14). Reads the parking query the
 * /parking page uses (issue #251): fetched only while the layer is shown,
 * refreshed once a minute while the tab is visible, and a failed refresh keeps
 * whatever was last drawn. Renders nothing when the layer is off, so it costs
 * nothing until a student asks for it.
 */
export default function ParkingGarageLayer({ visible }: { visible: boolean }) {
  const parkingQuery = useParking({ enabled: visible })
  const garages: Garage[] = parkingQuery.data?.garages ?? []

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
