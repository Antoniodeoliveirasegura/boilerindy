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

// Leaflet writes these into SVG fill attributes, which cannot read CSS
// variables, so they mirror the status tokens in index.css: success, the
// signal amber, error and txt-3, light then dark.
const FILL: Record<'light' | 'dark', Record<GarageStatus, string>> = {
  light: { open: '#12763A', busy: '#F4A51C', full: '#C1261A', unknown: '#5F6673' },
  dark: { open: '#5FD38A', busy: '#FFB938', full: '#FF7468', unknown: '#8B929D' },
}

/**
 * Live garage pins for the campus map (issue #14). Reads the parking query the
 * /parking page uses (issue #251): fetched only while the layer is shown,
 * refreshed once a minute while the tab is visible, and a failed refresh keeps
 * whatever was last drawn. Renders nothing when the layer is off, so it costs
 * nothing until a student asks for it.
 */
export default function ParkingGarageLayer({ visible, dark = false }: { visible: boolean; dark?: boolean }) {
  const parkingQuery = useParking({ enabled: visible })
  const garages: Garage[] = parkingQuery.data?.garages ?? []

  if (!visible) return null

  const fill = FILL[dark ? 'dark' : 'light']

  return (
    <>
      {garages.map((g) => {
        if (g.lat == null || g.lng == null) return null
        return (
          <CircleMarker
            key={g.id}
            center={[g.lat, g.lng]}
            radius={10}
            pathOptions={{ color: '#ffffff', weight: 2.5, fillColor: fill[g.status], fillOpacity: 1 }}
          >
            <Tooltip permanent direction="top" offset={[0, -8]} className="parking-count-tooltip">
              {g.available != null ? g.available.toLocaleString() : '?'}
            </Tooltip>
            <Popup>
              <div className="min-w-[180px] font-sans text-[13px] leading-[1.45]">
                <strong className="font-display font-extrabold text-[14px]">{g.name}</strong>
                {g.code ? <span className="text-[var(--color-txt-2)]"> ({g.code})</span> : null}
                <div className="mt-1 tnum">
                  {STATUS_LABEL[g.status]}
                  {' · '}
                  {availabilityLabel(g)}
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--color-txt-2)]">{formatUpdated(g.updatedAt)}</div>
                {g.stRule ? <div className="mt-1 text-[12px]">ST permit: {g.stRule}</div> : null}
                <div className="mt-2 flex gap-3 font-display font-bold text-[12.5px]">
                  <a href={directionsUrl(g)} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)]!">
                    Directions
                  </a>
                  <Link to="/parking" className="text-[var(--color-accent)]!">
                    All garages
                  </Link>
                </div>
              </div>
            </Popup>
          </CircleMarker>
        )
      })}
    </>
  )
}
