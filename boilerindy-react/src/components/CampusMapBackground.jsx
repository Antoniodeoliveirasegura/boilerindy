import { useEffect, useRef } from 'react'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Purdue Indianapolis (downtown) campus footprint. The map is framed to these
// bounds and locked to them — it is a decorative, non-interactive backdrop.
const CAMPUS_BOUNDS = [
  [39.7665, -86.1815], // south-west
  [39.7825, -86.1635], // north-east
]

/**
 * Ambient, non-interactive Leaflet map of the Purdue Indianapolis campus, used
 * as the gold-tinted backdrop on the login panel. All pointer interaction is
 * disabled and the view is locked to the campus bounds, so it never steals
 * focus or scroll from the sign-in form. Decorative only (aria-hidden).
 */
export default function CampusMapBackground() {
  const containerRef = useRef(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const map = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
      tap: false,
      inertia: false,
      maxBounds: CAMPUS_BOUNDS,
      maxBoundsViscosity: 1,
      zoomSnap: 0,
    })
    map.fitBounds(CAMPUS_BOUNDS)

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map)

    // Keep the map sized to its (responsive) container without any user input.
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false })
      map.fitBounds(CAMPUS_BOUNDS)
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      map.remove()
    }
  }, [])

  return (
    <div className="campus-map-bg absolute inset-0 overflow-hidden pointer-events-none select-none" aria-hidden="true">
      <div ref={containerRef} className="absolute inset-0" />
      {/* Legibility scrim — a gentle dark wash (deeper at the bottom) so the gold
          branding text stays readable over the dark map without hiding it. A faint
          warm tint at the bottom keeps a hint of brand without graying the map. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(8,10,15,0.15) 0%, rgba(8,10,15,0.28) 55%, rgba(20,13,0,0.72) 100%)',
        }}
      />
      <style>{`
        .campus-map-bg .leaflet-container { background: #0b0e14; }
        .campus-map-bg .leaflet-control-container { display: none; }
      `}</style>
    </div>
  )
}
