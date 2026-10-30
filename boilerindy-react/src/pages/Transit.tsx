import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import Icon from '../components/Icons'
import ShareButton from '../components/ShareButton'
import ShareQrButton from '../components/ShareQrButton'
import { useTheme } from '../context/ThemeContext'
import { useAuth } from '../context/AuthContext'
import { useEntrance } from '../hooks/useEntrance'
import { track } from '../lib/usageStats'
import { shareUrl } from '../lib/shareLinks'
import { PAGE_PREVIEWS } from '../lib/pagePreviews'
import { previewSignInHref } from '../lib/publicPreview'
import {
  routes,
  TRANLOC_ROUTE_ALIASES,
  UNKNOWN_ROUTE,
  SCHEDULE_PEERS,
  canonicalFromMap,
  buildTranslocRouteIdMap,
  haversineMeters,
  getOrderedStopsForRoute,
  isRouteActiveNow,
  isRouteRunningForDisplay,
  type TransitRoute,
} from '../lib/transitShared'
import { errorMessage, useTransitRoutes, useTransitStops, useTransitVehicles } from '../lib/queries/publicData'
import { compassPoint, pathArrows, travelHeading } from '../lib/transitDirection'
import PageTitle from '../components/PageTitle'
import { ESRI_TILE_ATTRIBUTION as TILE_ATTRIBUTION, INK_BUTTON } from '../components/map/mapChrome'

// Leaflet is bundled (imported above) instead of injected from a CDN at runtime;
// expose it on window.L to match the existing usage across this component.
if (typeof window !== 'undefined') {
  window.L = L
}

// Escape untrusted TransLoc feed strings before they go into Leaflet popup HTML
// (bindPopup sets innerHTML), so a hostile feed value can't inject markup.
function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

// JAGLINE colours are the lines' own (data, not theme), so anything drawn on
// or around them is worked out per colour.
function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Ink on the light lines (Yellow, Orange), white on the dark ones: whichever
// contrasts more with the fill.
function onRouteColor(hex: string): string {
  const rgb = hexRgb(hex)
  if (!rgb) return '#FFFFFF'
  return contrast(rgb, [10, 11, 14]) > contrast(rgb, [255, 255, 255]) ? '#0A0B0E' : '#FFFFFF'
}

// The line as drawn on a card: the JAGLINE colour, nudged toward white (dark
// theme) or ink (light theme) only as far as it takes to reach 3:1 against
// the surface, so the stop line and its filled and hollow stops read in both
// themes. Crimson, Blue and Purple lift a little in dark; Yellow and Orange
// deepen a little in light; the rest pass as they are.
function legibleLine(hex: string, dark: boolean): string {
  const rgb = hexRgb(hex)
  if (!rgb) return hex
  const surface: [number, number, number] = dark ? [20, 23, 28] : [255, 255, 255]
  const toward: [number, number, number] = dark ? [255, 255, 255] : [15, 18, 23]
  for (let t = 0; t <= 1; t += 0.02) {
    const mixed = rgb.map((c, i) => Math.round(c + (toward[i] - c) * t)) as [number, number, number]
    if (contrast(mixed, surface) >= 3) {
      return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`
    }
  }
  return hex
}

// The route's own colour on a square: the chips and the legend. Only the
// data colours are inline. In dark a hairline keeps the dark lines (Crimson,
// Blue, Purple) from sinking into the surface.
//
// Muted (an off-duty chip), only the fill fades and the number takes the
// chip's own text colour at full strength. The whole square used to fade, so
// on phones, where the number is the chip's only visible text, it read at 1.7
// to 3.0:1. The chip's text colour on a 35% fill is 5:1 or more for every line
// in both themes, idle or selected (at 40% dark Yellow fell to 4.4:1).
function RouteNum({ route, small = false, muted = false }: { route: TransitRoute; small?: boolean; muted?: boolean }) {
  return (
    <span
      className={`relative inline-grid place-items-center shrink-0 rounded-[3px] font-display font-extrabold leading-none tnum ${
        muted ? '' : 'dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]'
      } ${small ? 'size-[18px] text-[10px]' : 'size-5 text-[11px]'}`}
      style={muted ? undefined : { backgroundColor: route.color, color: onRouteColor(route.color) }}
    >
      {muted ? (
        <>
          <span className="absolute inset-0 rounded-[inherit] opacity-35" style={{ backgroundColor: route.color }} />
          <span className="relative">{route.num}</span>
        </>
      ) : (
        route.num
      )}
    </span>
  )
}

// Basemap: Esri's keyless World Street Map (issue #160; CARTO's free tiles
// carry an "API KEY REQUIRED" watermark). Streets and landmarks are what a
// rider reads a shuttle's position against, so the shuttle map keeps them.
const TILE_STREET = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'

// Dark theme: the same street map turned to night. Inverted with the hues
// turned back, then drained of most colour so the ground is a neutral near
// black like the page, the labels go light, and the JAGLINE colours are the
// only strong colour on it. Only the tile pane is filtered; lines and
// markers keep their true colours.
const DARK_TILES =
  '[&_.leaflet-tile-pane]:[filter:invert(1)_hue-rotate(180deg)_saturate(0.28)_brightness(0.92)_contrast(0.9)]'

// Light theme: the same street map drained to a quiet grey, so the yellow and
// orange arterials, tan blocks and blue river stop competing with the Yellow,
// Orange and Crimson lines. Street names stay readable; the JAGLINE colours are
// the only strong colour on the map, as in dark.
const LIGHT_TILES = '[&_.leaflet-tile-pane]:[filter:saturate(0.18)_contrast(0.95)_brightness(1.03)]'

// Phones: the tile credit at 10px, so it fits on one line over the map
// instead of wrapping onto the southern stops (it still wraps, never clips,
// on a very narrow screen).
const ATTRIBUTION_PHONE = 'max-sm:[&_.leaflet-control-attribution]:text-[10px]'

// From md the assistant button floats 24px in from the bottom right corner of
// the screen. On a laptop of about 1280x800 that is where the map's bottom
// right corner lands, and the button covered the end of the tile credit
// ("OpenStreetMap contributo"). Keep the credit and the zoom buttons clear of
// it, as the campus map does.
const CONTROLS_CLEAR_FAB =
  'md:[&_.leaflet-control-attribution]:mr-[72px]! md:[&_.leaflet-control-zoom]:mr-[72px]!'

// A bus plate reaches 15px out from its point, 19px up and right with its
// moving dot.
const BUS_REACH_PX = 20
const FIT_PADDING_PX = 50

// The live legend covers the map's top left corner, and on phones it is
// larger (about 120x83px) than the 50px fitBounds used to leave, so the
// north-west bus landed under it. Keep the buses out of the strip beside the
// legend or the one below it, whichever costs the map less of its width or
// height: below on a tall phone map, beside on a wide one.
function fitBusesOptions(map: L.Map, legend: HTMLElement | null): L.FitBoundsOptions {
  const size = map.getSize()
  if (!legend || !size.x || !size.y) return { padding: [FIT_PADDING_PX, FIT_PADDING_PX], maxZoom: 16 }
  const beside = legend.offsetLeft + legend.offsetWidth + BUS_REACH_PX
  const below = legend.offsetTop + legend.offsetHeight + BUS_REACH_PX
  const paddingTopLeft: [number, number] =
    beside / size.x < below / size.y
      ? [Math.max(FIT_PADDING_PX, beside), FIT_PADDING_PX]
      : [FIT_PADDING_PX, Math.max(FIT_PADDING_PX, below)]
  return { paddingTopLeft, paddingBottomRight: [FIT_PADDING_PX, FIT_PADDING_PX], maxZoom: 16 }
}

// The edge every line, stop and bus wears so it holds on both the light
// street map and the dark one: near white (--color-ink-txt), and outside it a
// thin ink hairline that only shows on the light map. Literal, because the
// casing is an SVG stroke, which cannot read CSS variables.
const EDGE = '#F3F4F6'
const HAIRLINE = 'rgba(15,18,23,0.32)'

const CAMPUS_CENTER = { lat: 39.7745, lng: -86.1756 }
const HERE_METERS = 72
const VISITED_METERS = 95
/** After chime, allow again once bus is this far from the “before” stop */
const CHIME_RESET_METERS = 380

type Vehicle = {
  RouteID?: number | string
  VehicleID?: number | string
  Latitude?: number
  Longitude?: number
  GroundSpeed?: number
  /** Degrees clockwise from north; 0 while the bus is stopped. */
  Heading?: number
  Name?: string
}
type Stop = {
  RouteID?: number | string
  RouteStopID?: number | string
  Latitude?: number
  Longitude?: number
  Description?: string
  MapPoints?: { Latitude: number; Longitude: number }[]
}
type OrderedStop = { id: string; name?: string; lat?: number; lon?: number }
type CanonicalFn = (routeId: number | string | undefined) => number | null

function playAlertChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const beep = (freq: number, t0: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.connect(g)
      g.connect(ctx.destination)
      o.frequency.value = freq
      o.type = 'sine'
      g.gain.setValueAtTime(0.001, t0)
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22)
      o.start(t0)
      o.stop(t0 + 0.25)
    }
    const t0 = ctx.currentTime
    beep(880, t0)
    beep(1100, t0 + 0.28)
    setTimeout(() => ctx.close(), 800)
  } catch {
    /* ignore */
  }
}

function LiveMap({
  vehicles,
  routes,
  stops,
  selectedRoute,
  onSelectBus,
  selectedBus,
  stopHighlights,
  canonicalRouteId,
  feedError,
  retrying,
  onRetry,
}: {
  vehicles: Vehicle[]
  routes: TransitRoute[]
  stops: Stop[]
  selectedRoute: TransitRoute | null
  onSelectBus: (vehicle: Vehicle) => void
  selectedBus: Vehicle | null
  stopHighlights: Record<string, string>
  canonicalRouteId: CanonicalFn
  feedError: string | null
  retrying?: boolean
  onRetry: () => void
}) {
  const { dark } = useTheme()
  const mapRef = useRef<HTMLDivElement | null>(null)
  const legendRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<import('leaflet').Map | null>(null)
  const markersRef = useRef<Record<string, import('leaflet').Marker>>({})
  const routeLinesRef = useRef<import('leaflet').Layer[]>([])
  const stopMarkersRef = useRef<import('leaflet').Marker[]>([])
  const userMarkerRef = useRef<import('leaflet').Marker | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [locationLoading, setLocationLoading] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  const locateUser = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported')
      return
    }
    setLocationLoading(true)
    setLocationError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setLocationLoading(false)
      },
      (err) => {
        setLocationError(err.code === 1 ? 'Location access denied' : 'Could not get location')
        setLocationLoading(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    )
  }, [])

  // Update user location marker on map
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !window.L || !mapReady || !userLocation) return

    const L = window.L

    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng([userLocation.lat, userLocation.lng])
    } else {
      // "You are here": the amber stop with a txt-0 ring (ink on the light
      // basemap, white on the dark one), as on the day's route line.
      const userIcon = L.divIcon({
        html: `
          <div style="position:relative;width:40px;height:40px;">
            <div style="
              position:absolute;
              top:50%;left:50%;
              transform:translate(-50%,-50%);
              width:40px;height:40px;
              background:color-mix(in srgb, var(--color-gold) 20%, transparent);
              border:1.5px solid color-mix(in srgb, var(--color-gold) 65%, transparent);
              border-radius:50%;
              animation:user-pulse 2s ease-out infinite;
            "></div>
            <div style="
              position:absolute;
              top:50%;left:50%;
              transform:translate(-50%,-50%);
              width:18px;height:18px;
              box-sizing:border-box;
              background:var(--color-gold);
              border:3px solid var(--color-txt-0);
              border-radius:50%;
            "></div>
          </div>`,
        className: 'user-location-marker',
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      })
      userMarkerRef.current = L.marker([userLocation.lat, userLocation.lng], { icon: userIcon, zIndexOffset: 1000 })
        .addTo(map)
        .bindPopup('<div style="font-family:var(--font-display);font-size:13px;font-weight:700;">You are here</div>')
    }

    map.setView([userLocation.lat, userLocation.lng], 16)
  }, [userLocation, mapReady])

  useEffect(() => {
    if (!mapRef.current) return

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove()
      mapInstanceRef.current = null
    }

    // Leaflet + its CSS are bundled and imported at the top of this file, so there
    // is no third-party CDN script/style to inject at runtime (no SRI gap).
    const loadLeaflet = (): Promise<typeof import('leaflet')> =>
      Promise.resolve(window.L as typeof import('leaflet'))

    let mounted = true

    loadLeaflet().then((L) => {
      if (!mounted || !mapRef.current) return
      if ((mapRef.current as { _leaflet_id?: number })._leaflet_id) return

      const map = L.map(mapRef.current, {
        zoomControl: false,
      }).setView([CAMPUS_CENTER.lat, CAMPUS_CENTER.lng], 14)

      L.control.zoom({ position: 'bottomright' }).addTo(map)

      // One street layer for both themes; the dark theme only filters it.
      L.tileLayer(TILE_STREET, {
        attribution: TILE_ATTRIBUTION,
        maxZoom: 19,
      }).addTo(map)

      mapInstanceRef.current = map
      setMapReady(true)
    })

    return () => {
      mounted = false
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove()
        mapInstanceRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !window.L || !mapReady) return
    if (!stops.length) return

    const L = window.L

    routeLinesRef.current.forEach((line) => line.remove())
    routeLinesRef.current = []

    if (!selectedRoute) return

    const points: [number, number][] = []
    stops.forEach((stop) => {
      if (canonicalRouteId(stop.RouteID) !== selectedRoute.id) return
      if (stop.MapPoints && stop.MapPoints.length > 0) {
        stop.MapPoints.forEach((point) => {
          points.push([point.Latitude, point.Longitude])
        })
      }
    })

    if (points.length < 2) return

    // The line is cased like a transit map: a thin ink hairline (it shows on
    // the light map), a near white edge (it carries Crimson, Blue and Purple
    // on the dark one), then the line in its own colour.
    const hairline = L.polyline(points, {
      color: '#0F1217',
      weight: 10,
      opacity: 0.28,
      smoothFactor: 1,
      interactive: false,
    }).addTo(map)
    const casing = L.polyline(points, {
      color: EDGE,
      weight: 8.5,
      opacity: 0.95,
      smoothFactor: 1,
      interactive: false,
    }).addTo(map)
    const polyline = L.polyline(points, {
      color: selectedRoute.color,
      weight: 5,
      opacity: 1,
      smoothFactor: 1,
    }).addTo(map)

    routeLinesRef.current.push(hairline, casing, polyline)

    // Arrowheads along the line, the way its buses run (2026-10-30), as
    // narrow as the line and in the ink that reads on its colour. Drawing
    // only: no focus, no click, under the stops and buses.
    for (const arrow of pathArrows(points)) {
      const head = L.marker([arrow.lat, arrow.lon], {
        icon: L.divIcon({
          html: `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style="display:block;transform:rotate(${arrow.bearing}deg)"><path d="M6 2.5 L9.5 8.5 L2.5 8.5 Z" fill="${onRouteColor(selectedRoute.color)}"/></svg>`,
          className: 'transit-line-arrow',
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: -1000,
      }).addTo(map)
      routeLinesRef.current.push(head)
    }
    map.fitBounds(polyline.getBounds(), { padding: [30, 30] })
  }, [stops, selectedRoute, mapReady, canonicalRouteId])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !window.L || !stops.length || !mapReady) return

    const L = window.L

    stopMarkersRef.current.forEach((marker) => marker.remove())
    stopMarkersRef.current = []

    if (!selectedRoute) return

    const visibleStops = stops.filter((s) => canonicalRouteId(s.RouteID) === selectedRoute.id)
    const uniqueStops: (Stop & { _sid: string })[] = []
    const seen = new Set<string>()
    visibleStops.forEach((stop) => {
      const id = stop.RouteStopID != null ? String(stop.RouteStopID) : `${stop.Latitude},${stop.Longitude}`
      const key = `${(stop.Latitude ?? 0).toFixed(4)},${(stop.Longitude ?? 0).toFixed(4)}`
      if (seen.has(key)) return
      seen.add(key)
      uniqueStops.push({ ...stop, _sid: id })
    })

    uniqueStops.forEach((stop) => {
      const route = selectedRoute
      const sid = stop._sid
      const mode = stopHighlights?.[sid] || 'normal'

      // Stops are line stops: a white dot ringed in the route colour, filled
      // once the bus has passed, green and pulsing while it is at the stop.
      // Each wears the line's edge (near white, then an ink hairline), so a
      // dark line's stop still stands off the dark map.
      const bg = mode === 'visited' ? route.color : EDGE
      let ring = `box-shadow:0 0 0 1.5px ${EDGE},0 0 0 2.5px ${HAIRLINE};`
      if (mode === 'here') {
        ring =
          `box-shadow:0 0 0 2px ${EDGE},0 0 0 6px color-mix(in srgb, var(--color-success) 45%, transparent);animation:transit-pulse 1.15s ease-in-out infinite;`
      }

      const icon = L.divIcon({
        html: `<div style="
          width:16px;height:16px;box-sizing:border-box;background:${mode === 'here' ? 'var(--color-success)' : bg};
          border:3.5px solid ${mode === 'here' ? 'var(--color-success)' : route.color};border-radius:50%;
          ${ring}
        "></div>`,
        className: 'transit-stop-marker',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      })

      // Leaflet makes each marker a focusable button; the title is its name,
      // which a divIcon otherwise lacks (issue #529).
      const marker = L.marker([stop.Latitude ?? 0, stop.Longitude ?? 0], { icon, title: `${stop.Description ?? 'Stop'}, ${route.name}` })
        .addTo(map)
        .bindPopup(
          `<div style="font-family:var(--font-sans);min-width:120px;">
            <div style="font-family:var(--font-display);font-weight:800;font-size:13px;line-height:1.25;margin-bottom:5px;">${escapeHtml(stop.Description)}</div>
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--color-txt-2);"><span style="width:10px;height:10px;border-radius:2px;flex:none;background:${route.color};"></span>${route.name}</div>
          </div>`,
        )

      stopMarkersRef.current.push(marker)
    })
  }, [stops, routes, selectedRoute, mapReady, stopHighlights, canonicalRouteId])

  // Waits for mapReady like the line and stop effects. The map is created a
  // microtask after mount, when the vehicles are usually already loaded, and a
  // poll that returns the same feed keeps the same array, so without mapReady
  // here the buses were never drawn until one of them moved.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !window.L || !mapReady) return

    const L = window.L

    Object.values(markersRef.current).forEach((marker) => marker.remove())
    markersRef.current = {}

    const displayVehicles = selectedRoute
      ? vehicles.filter((v) => canonicalRouteId(v.RouteID) === selectedRoute.id)
      : vehicles

    displayVehicles.forEach((vehicle) => {
      const canon = canonicalRouteId(vehicle.RouteID)
      const route = routes.find((r) => r.id === canon) || UNKNOWN_ROUTE
      const isSelected = selectedBus?.VehicleID === vehicle.VehicleID
      const isMoving = (vehicle.GroundSpeed ?? 0) > 0
      const heading = travelHeading(vehicle)

      // A bus is a square route badge in its line's colour with the line's
      // edge (near white, then an ink hairline), its fleet number on a small
      // ink plate underneath, and a green dot while it moves. While it moves
      // the badge holds an arrow turned to its heading, so the way it is
      // going shows on the map; stopped, it holds the bus glyph. Selection is
      // not amber (amber is for now): the selected bus adds a ring in its own
      // line colour, framed by the edge again so it holds on the dark map.
      const glyph =
        heading == null
          ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 6v6M16 6v6M2 12h2M20 12h2M5 18v2M19 18v2M5 6a3 3 0 013-3h8a3 3 0 013 3v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6z"/>
          </svg>`
          : `<svg class="transit-bus-heading" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${heading}deg)">
            <path d="M12 2.5 L19.5 20 L12 15.5 L4.5 20 Z" fill="currentColor"/>
          </svg>`
      const edge = isSelected
        ? `0 0 0 2.5px ${EDGE}, 0 0 0 5.5px ${route.color}, 0 0 0 7.5px ${EDGE}, 0 0 0 8.5px ${HAIRLINE}`
        : `0 0 0 2.5px ${EDGE}, 0 0 0 3.5px ${HAIRLINE}`
      const iconHtml = `
        <div style="
          width: 30px;
          height: 30px;
          box-sizing: border-box;
          background: ${route.color};
          color: ${onRouteColor(route.color)};
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: ${edge};
        ">
          ${glyph}
        </div>
        <div style="
          position: absolute;
          top: ${isSelected ? 41 : 36}px;
          left: 50%;
          transform: translateX(-50%);
          padding: 2px 4px;
          border-radius: 2px;
          background: var(--color-ink-lift);
          color: var(--color-ink-txt);
          box-shadow: 0 0 0 1px rgba(243,244,246,0.35);
          font: 800 9px/1 var(--font-display);
          letter-spacing: 0.04em;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        ">${escapeHtml(vehicle.Name)}</div>
        ${
          isMoving
            ? `
          <div style="
            position: absolute;
            top: -4px;
            right: -4px;
            width: 10px;
            height: 10px;
            box-sizing: border-box;
            background: var(--color-success);
            border-radius: 50%;
            box-shadow: 0 0 0 2px var(--color-surface);
          "></div>
        `
            : ''
        }
      `

      const icon = L.divIcon({
        html: iconHtml,
        className: 'custom-bus-marker',
        iconSize: [30, 52],
        iconAnchor: [15, 15],
      })

      const way = heading == null ? '' : `, heading ${compassPoint(heading)}`
      const marker = L.marker([vehicle.Latitude ?? 0, vehicle.Longitude ?? 0], { icon, title: `Bus ${vehicle.Name}, ${route.name}${way}` })
        .addTo(map)
        .on('click', () => onSelectBus(vehicle))

      marker.bindPopup(
        `<div style="font-family: var(--font-sans); min-width: 140px;">
          <div style="font-family: var(--font-display); font-weight: 800; font-size: 14px; margin-bottom: 3px;">Bus ${escapeHtml(vehicle.Name)}</div>
          <div style="font-size: 12px; color: var(--color-txt-2); margin-bottom: 8px;">${route.name}</div>
          <div style="font-size: 12px; display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${isMoving ? 'var(--color-success)' : 'var(--color-txt-3)'}"></span>
            ${isMoving ? `${Math.round(vehicle.GroundSpeed ?? 0)} mph` : 'Stopped'}
          </div>
        </div>`,
      )

      markersRef.current[String(vehicle.VehicleID)] = marker
    })

    if (displayVehicles.length > 0) {
      const bounds = L.latLngBounds(
        displayVehicles.map((v) => [v.Latitude ?? 0, v.Longitude ?? 0] as [number, number]),
      )
      map.fitBounds(bounds, fitBusesOptions(map, legendRef.current))
    }
  }, [vehicles, selectedBus, selectedRoute, onSelectBus, canonicalRouteId, routes, mapReady])

  return (
    <div
      className={`purdue-map relative isolate w-full h-[340px] sm:h-[380px] lg:h-[460px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border-2)] ${ATTRIBUTION_PHONE} ${CONTROLS_CLEAR_FAB} ${
        dark ? DARK_TILES : LIGHT_TILES
      }`}
    >
      <style>{`
        @keyframes transit-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.35); opacity: 0.92; }
        }
        .transit-stop-marker div { transform-origin: center center; }
        @keyframes user-pulse {
          0% { transform: translate(-50%,-50%) scale(1); opacity: 1; }
          100% { transform: translate(-50%,-50%) scale(2); opacity: 0; }
        }
      `}</style>
      <div ref={mapRef} className="w-full h-full bg-[var(--color-bg-2)]!" />

      {/* Live legend: an ink plate listing each running line and its buses.
          It is always mounted. With nothing running it holds only its title
          and sits under the scrim below (same layer, later in the DOM), so it
          reads as a faded corner tag behind the centred "Not in service"
          plate rather than a second plate competing with it. */}
      <div ref={legendRef} className="ink-panel absolute top-3 left-3 z-[1000] p-2 sm:p-3 max-w-[150px] sm:max-w-none shadow-[var(--shadow-md)]">
        <div className={`eyebrow bare max-sm:text-[10.5px] ${vehicles.length > 0 ? 'mb-1.5 sm:mb-2' : ''}`}>
          Active Routes
        </div>
        <div className="space-y-1 sm:space-y-1.5">
          {routes.map((route) => {
            const count = vehicles.filter((v) => canonicalRouteId(v.RouteID) === route.id).length
            if (count === 0) return null
            return (
              <div key={route.id} className="flex items-center gap-2">
                <RouteNum route={route} small />
                <span className="font-display font-bold text-[11px] sm:text-[12.5px] text-[var(--color-ink-txt)] truncate">{route.shortName}</span>
                <span className="text-[11px] sm:text-[12px] text-[var(--color-ink-dim)] tnum">({count})</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Locate Me Button. Top right, clear of Leaflet's zoom control in the
          bottom right corner. With no buses the scrim covers it, as before. */}
      <button
        type="button"
        onClick={locateUser}
        disabled={locationLoading}
        className={`absolute top-3 right-3 z-[1000] ${INK_BUTTON} ${
          userLocation ? 'text-[var(--color-ink-signal)]' : ''
        } ${locationLoading ? 'animate-pulse' : ''}`}
        title={locationError || 'Show my location'}
        aria-label="Show my location"
      >
        <Icon name="locateMe" size={22} />
      </button>

      {/* A feed that failed or was rate limited is not an empty one: saying
          "Not in service" then told visitors the shuttles were not running. */}
      {vehicles.length === 0 && (
        <div className="absolute inset-0 z-[1000] grid place-items-center p-4 bg-[var(--color-bg-1)]/65">
          {feedError ? (
            <div role="alert" className="empty items-center text-center bg-[var(--color-surface)] px-6 py-5">
              <span className="plate">Live positions unavailable</span>
              <p>{feedError}</p>
              {/* While a retry is already running, a press only waits for it, so
                  the button says so instead of looking dead. aria-disabled, not
                  disabled, so keyboard focus stays on it. */}
              <button
                type="button"
                onClick={retrying ? undefined : onRetry}
                aria-disabled={retrying || undefined}
                className="btn btn-secondary btn-sm aria-disabled:opacity-60"
              >
                {retrying ? 'Retrying...' : 'Try again'}
              </button>
            </div>
          ) : (
            <div className="empty items-center text-center bg-[var(--color-surface)] px-6 py-5">
              <span className="plate" aria-hidden="true">Not in service</span>
              <p>No buses currently active</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function myStopStorageKey(routeId: number | string) {
  return `transit-my-stop-${routeId}`
}

/** Load the saved "my stop" id for a route from localStorage, or null. */
function loadMyStopForRoute(routeId: number | null | undefined): string | null {
  if (!routeId) return null
  try {
    const raw = localStorage.getItem(myStopStorageKey(routeId))
    if (raw) {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : null
    }
  } catch {
    return null
  }
  return null
}

export default function Transit() {
  const { dark } = useTheme()

  // Signed-out visitors can open this page (the public preview, issue #366).
  // The "my stop" bell is for signed-in students only: its saved stop is kept
  // per device, not per user, so signed out it is never read or written and
  // no chime plays.
  const { user, loading: authLoading } = useAuth()
  const signedIn = !authLoading && Boolean(user)

  // Once auth settles, so a signed-in cold load records the view after
  // UsageListener has switched tracking on (signed out it records nothing).
  useEffect(() => {
    if (authLoading) return
    track('transit_viewed')
  }, [authLoading])

  // Vehicles, stops and the route map come through the shared query cache
  // (issue #251): the dashboard's transit card reads the same entries, the
  // 5 s vehicle poll pauses while the tab is hidden, and a return visit
  // paints the last positions before the network answers.
  const vehiclesQuery = useTransitVehicles()
  const stopsQuery = useTransitStops()
  const routesQuery = useTransitRoutes()
  const rawVehicles = useMemo<Vehicle[]>(
    () => (Array.isArray(vehiclesQuery.data) ? (vehiclesQuery.data as Vehicle[]) : []),
    [vehiclesQuery.data],
  )
  const stops = useMemo<Stop[]>(() => (Array.isArray(stopsQuery.data) ? (stopsQuery.data as Stop[]) : []), [stopsQuery.data])
  // Only the isPending of these reads was used, so a vehicles read that failed
  // (the feed down, 502) or was rate limited (429) with nothing cached left
  // an empty list, and the page said "All Routes (0)" and "Not in service".
  // Positions still cached from an earlier answer keep showing.
  // A read with no data goes back to pending, and drops its error, at the
  // start of every retry, so the failure is also read from errorUpdatedAt and
  // the last error is kept: otherwise each 5 s poll during an outage swapped
  // the notice for the loading screen and back, re-announcing the alert and
  // dropping focus from Try again.
  const [lastVehiclesError, setLastVehiclesError] = useState<unknown>(null)
  if (vehiclesQuery.error && vehiclesQuery.error !== lastVehiclesError) setLastVehiclesError(vehiclesQuery.error)
  const vehiclesFailing =
    rawVehicles.length === 0 &&
    (vehiclesQuery.isError || (vehiclesQuery.errorUpdatedAt ?? 0) > (vehiclesQuery.dataUpdatedAt ?? 0))
  const feedError = vehiclesFailing
    ? errorMessage(vehiclesQuery.error ?? lastVehiclesError, 'Could not load live bus positions.')
    : null
  // The selected route lives in the URL (?route=31), not in component state:
  // leaving the page and coming Back remounted it on All Routes, which also
  // left the saved "my stop" alert unarmed until the route was picked again.
  // Replace, not push, so each pill is not a Back step of its own. The
  // preview bar's Sign in link carries the search, so the route also
  // survives signing in from the signed-out preview.
  const [searchParams, setSearchParams] = useSearchParams()
  const { pathname, search } = useLocation()
  const routeParam = searchParams.get('route')
  const selectedRoute = useMemo<TransitRoute | null>(
    () => routes.find((r) => String(r.id) === routeParam) ?? null,
    [routeParam],
  )
  const setSelectedRoute = useCallback(
    (route: TransitRoute | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (route) next.set('route', String(route.id))
          else next.delete('route')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const [selectedBus, setSelectedBus] = useState<Vehicle | null>(null)
  // Only a first load shows the skeleton: a read that has failed before is
  // retrying, and the map with its notice stays up meanwhile (see feedError).
  const firstLoad = (q: { isPending: boolean; errorUpdateCount?: number }) => q.isPending && !q.errorUpdateCount
  const loading = firstLoad(vehiclesQuery) || firstLoad(stopsQuery) || firstLoad(routesQuery)
  const lastUpdate = useMemo(
    () => (vehiclesQuery.dataUpdatedAt ? new Date(vehiclesQuery.dataUpdatedAt) : null),
    [vehiclesQuery.dataUpdatedAt],
  )
  const [visitedStopIds, setVisitedStopIds] = useState<Set<string>>(() => new Set())
  // Last bus position folded into visitedStopIds - see the accumulation block below.
  const [lastBusPos, setLastBusPos] = useState<string | null>(null)
  // The route whose saved stop is loaded: none signed out.
  const myStopRouteId = signedIn ? (selectedRoute?.id ?? null) : null
  /**
   * One “my stop” per route - chime fires when bus reaches the stop before this one.
   * Read on mount too: a page opened (or come Back to) on ?route= starts with
   * its route already selected, so the load-on-change block below sees no change.
   */
  const [myStopId, setMyStopId] = useState<string | null>(() => loadMyStopForRoute(myStopRouteId))
  const [loadedMyStopRouteId, setLoadedMyStopRouteId] = useState(myStopRouteId)
  const chimePlayedRef = useRef(false)
  const routeIdToCanonical = useMemo<Record<number, number>>(
    () => (Array.isArray(routesQuery.data) ? buildTranslocRouteIdMap(routesQuery.data) : { ...TRANLOC_ROUTE_ALIASES }),
    [routesQuery.data],
  )

  // Reset per-route tracking state when the selected route changes. Done during
  // render (React's "adjust state on prop change" pattern) rather than in an
  // effect, so it never calls setState synchronously inside an effect body.
  const currentRouteId = selectedRoute?.id ?? null
  const [trackedRouteId, setTrackedRouteId] = useState(currentRouteId)
  if (trackedRouteId !== currentRouteId) {
    setTrackedRouteId(currentRouteId)
    setVisitedStopIds(new Set())
    setLastBusPos(null)
  }
  // Load the saved stop when the route changes or the visitor signs in or out,
  // the same way.
  if (loadedMyStopRouteId !== myStopRouteId) {
    setLoadedMyStopRouteId(myStopRouteId)
    setMyStopId(loadMyStopForRoute(myStopRouteId))
  }

  const canonicalRouteId = useCallback<CanonicalFn>(
    (routeId) => canonicalFromMap(routeIdToCanonical, routeId ?? ''),
    [routeIdToCanonical],
  )

  /**
   * Remap vehicles whose canonical route isn't running today to their active
   * schedule peer (e.g. Gray ↔ Orange share the same corridor but run on
   * opposite day sets). The RouteID on the returned object is replaced with the
   * peer's canonical id so all downstream filtering and coloring work correctly.
   */
  const vehicles = useMemo<Vehicle[]>(() => {
    return rawVehicles.map((v) => {
      const canon = canonicalFromMap(routeIdToCanonical, v.RouteID ?? '')
      const route = routes.find((r) => r.id === canon)
      if (route && canon != null && !isRouteActiveNow(route)) {
        const peerId = SCHEDULE_PEERS[canon]
        if (peerId != null) {
          const peerRoute = routes.find((r) => r.id === peerId)
          if (peerRoute && isRouteActiveNow(peerRoute)) {
            return { ...v, RouteID: peerId }
          }
        }
      }
      return v
    })
  }, [rawVehicles, routeIdToCanonical])

  const orderedStops = useMemo(() => {
    if (!selectedRoute) return []
    return getOrderedStopsForRoute(stops, selectedRoute.id, routeIdToCanonical)
  }, [stops, selectedRoute, routeIdToCanonical])

  // The stops rise in when the transit data lands and when another route is
  // picked (hooks/useEntrance); the 5 s bus poll only moves their dots.
  const stopsRef = useEntrance<HTMLDivElement>(!loading, currentRouteId)

  const trackingBus = useMemo(() => {
    if (!selectedRoute) return null
    const onRoute = vehicles.filter((v) => canonicalRouteId(v.RouteID) === selectedRoute.id)
    if (!onRoute.length) return null
    if (selectedBus && onRoute.some((v) => v.VehicleID === selectedBus.VehicleID)) return selectedBus
    return onRoute[0]
  }, [vehicles, selectedRoute, selectedBus, canonicalRouteId])

  // A fresh chime can fire for the newly selected route. Ref-only write (no
  // setState) keeps this safe to run inside an effect.
  useEffect(() => {
    chimePlayedRef.current = false
  }, [currentRouteId])

  const toggleMyStop = useCallback(
    (stopId: string) => {
      if (!signedIn) return
      chimePlayedRef.current = false
      setMyStopId((prev) => {
        const next = prev === stopId ? null : stopId
        if (selectedRoute?.id) {
          try {
            if (next) localStorage.setItem(myStopStorageKey(selectedRoute.id), JSON.stringify(next))
            else localStorage.removeItem(myStopStorageKey(selectedRoute.id))
          } catch {
            /* ignore */
          }
        }
        return next
      })
    },
    [selectedRoute, signedIn],
  )

  const stopBeforeMyStop = useMemo(() => {
    if (!myStopId || !orderedStops.length) return null
    const idx = orderedStops.findIndex((s) => s.id === myStopId)
    if (idx <= 0) return null
    return orderedStops[idx - 1]
  }, [myStopId, orderedStops])

  // The stop the bus is currently "at" is pure-derived from the bus position,
  // so compute it during render instead of mirroring it into effect-set state.
  const hereStopId = useMemo(() => {
    if (!trackingBus || !orderedStops.length) return null

    let nearest: OrderedStop | null = null
    let nearestD = Infinity
    const lat = trackingBus.Latitude ?? 0
    const lon = trackingBus.Longitude ?? 0

    orderedStops.forEach((s) => {
      const d = haversineMeters(lat, lon, s.lat ?? 0, s.lon ?? 0)
      if (d < nearestD) {
        nearestD = d
        nearest = s
      }
    })

    return nearest && nearestD <= HERE_METERS ? (nearest as OrderedStop).id : null
  }, [trackingBus, orderedStops])

  // Visited stops accumulate as the bus moves. We fold each new bus position in
  // during render (adjusting state from the previously-processed position)
  // rather than in an effect, so no setState runs synchronously in an effect.
  const busPosKey = trackingBus ? `${trackingBus.Latitude},${trackingBus.Longitude}` : null
  if (busPosKey && busPosKey !== lastBusPos && orderedStops.length && trackingBus) {
    setLastBusPos(busPosKey)
    const lat = trackingBus.Latitude ?? 0
    const lon = trackingBus.Longitude ?? 0
    const newlyVisited = orderedStops.filter(
      (s) => !visitedStopIds.has(s.id) && haversineMeters(lat, lon, s.lat ?? 0, s.lon ?? 0) <= VISITED_METERS,
    )
    if (newlyVisited.length) {
      setVisitedStopIds((prev) => {
        const next = new Set(prev)
        newlyVisited.forEach((s) => next.add(s.id))
        return next
      })
    }
  }

  useEffect(() => {
    if (!trackingBus || !stopBeforeMyStop) return

    const lat = trackingBus.Latitude ?? 0
    const lon = trackingBus.Longitude ?? 0
    const dist = haversineMeters(lat, lon, stopBeforeMyStop.lat ?? 0, stopBeforeMyStop.lon ?? 0)

    if (dist <= HERE_METERS && !chimePlayedRef.current) {
      chimePlayedRef.current = true
      playAlertChime()
    }
    if (dist > CHIME_RESET_METERS) {
      chimePlayedRef.current = false
    }
  }, [trackingBus, stopBeforeMyStop])

  const stopHighlights = useMemo(() => {
    const h: Record<string, string> = {}
    orderedStops.forEach((s) => {
      if (hereStopId === s.id) h[s.id] = 'here'
      else if (visitedStopIds.has(s.id)) h[s.id] = 'visited'
      else h[s.id] = 'normal'
    })
    return h
  }, [orderedStops, hereStopId, visitedStopIds])

  // The selected line's own colour drives the card's one route colour: its
  // badge, eyebrow square and the stop line, nudged just enough to hold 3:1
  // on the card's surface in this theme (see legibleLine).
  const cardLine = selectedRoute ? legibleLine(selectedRoute.color, dark) : null
  const routeStyle = cardLine
    ? ({ '--route': cardLine, '--route-on': onRouteColor(cardLine) } as CSSProperties)
    : undefined
  const shareLink = () => shareUrl('transit', window.location.href, { route: selectedRoute ? String(selectedRoute.id) : null })
  const shareText = selectedRoute ? `The ${selectedRoute.shortName} route, live on BoilerIndy` : 'Every JAGLINE bus, live on BoilerIndy'

  return (
    <div className="page">
      <PageTitle>Campus Transit</PageTitle>
      <header className="page-head">
        <div>
          <h1 className="page-title">Campus Transit</h1>
          <p className="page-sub">
            JAGLINE shuttle live tracking
            {lastUpdate && (
              <span className="text-[var(--color-txt-3)] hidden sm:inline tnum"> · Updated {lastUpdate.toLocaleTimeString()}</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The view on screen, for a friend signed in or not: the route
              picked, or All Routes (docs/share-links.md). Share sends it as
              a link, the QR button shows it as a code to scan. */}
          <ShareButton page="transit" getUrl={shareLink} title={PAGE_PREVIEWS.transit.title} text={shareText} />
          <ShareQrButton page="transit" getUrl={shareLink} text={shareText} />
          <button onClick={() => void vehiclesQuery.refetch()} className="btn btn-secondary">
            <Icon name="refresh" size={15} />
            Refresh
          </button>
        </div>
      </header>

      {/* Route filter pills - horizontal scroll on mobile. A scroller clips
          on both axes, and with no room above the pills it cut the top off the
          focus ring (3px plus a 2px offset); the top padding gives it 6px and
          the negative margin keeps the pills where they were. */}
      <div className="mb-5">
        <div className="flex gap-2 overflow-x-auto pt-1.5 -mt-1.5 pb-2 -mx-4 px-4 sm:mt-0 sm:pt-0 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible scrollbar-hide">
          <button
            onClick={() => setSelectedRoute(null)}
            className={`pill whitespace-nowrap shrink-0 tnum ${!selectedRoute ? 'pill-active' : ''}`}
          >
            All Routes{!feedError && ` (${vehicles.length})`}
          </button>
          {routes.map((route) => {
            const count = vehicles.filter((v) => canonicalRouteId(v.RouteID) === route.id).length
            const running = isRouteRunningForDisplay(route, count)
            const active = selectedRoute?.id === route.id
            // Off duty is information, not a disabled control: only the route
            // square's fill fades (transit.spec pins its opacity-35); its
            // number, the name and the note stay readable (txt-2 and txt-3 on
            // the idle pill). Phones hide the note but still announce it.
            return (
              <button
                key={route.id}
                onClick={() => setSelectedRoute(active ? null : route)}
                className={`pill relative whitespace-nowrap flex items-center gap-2 pl-1.5 pr-2.5 sm:pr-3 shrink-0
                  ${active ? 'pill-active' : ''}`}
                title={route.schedule?.label ?? ''}
              >
                <RouteNum route={route} muted={!running} />
                <span className={`hidden sm:inline ${!running && !active ? 'text-[var(--color-txt-2)]' : ''}`}>{route.shortName}</span>
                <span className="sr-only sm:hidden">{route.num}</span>
                {count > 0 && <span className="tnum opacity-75">({count})</span>}
                {!running && (
                  <span className={`text-[11px] font-semibold sr-only sm:not-sr-only ${active ? '' : 'text-[var(--color-txt-3)]'}`}>not running now</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Schedule reference - hidden on mobile for cleaner UI */}
        <div className="mt-2.5 hidden sm:flex flex-wrap gap-x-6 gap-y-1.5">
          {[...new Map(routes.map(r => [r.schedule?.label, r])).values()].map(r => {
            if (!r.schedule) return null
            const scheduleLabel = r.schedule.label
            const groupRoutes = routes.filter(x => x.schedule?.label === scheduleLabel)
            return (
              <div key={r.schedule.label} className="flex items-center gap-2 text-[12px] text-[var(--color-txt-2)] tnum">
                <div className="flex gap-[3px]">
                  {groupRoutes.map(gr => (
                    <span key={gr.id} className="w-2.5 h-2.5 rounded-[2px] inline-block" style={{ backgroundColor: gr.color }} />
                  ))}
                </div>
                <span>{r.schedule.label}</span>
              </div>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="skeleton h-[340px] sm:h-[380px] lg:h-[460px] grid place-items-center">
          <p className="text-[13px] text-[var(--color-txt-2)]">Loading transit data...</p>
        </div>
      ) : (
        <div>
          <LiveMap
            vehicles={vehicles}
            routes={routes}
            stops={stops}
            selectedRoute={selectedRoute}
            selectedBus={selectedBus}
            onSelectBus={setSelectedBus}
            stopHighlights={stopHighlights}
            canonicalRouteId={canonicalRouteId}
            feedError={feedError}
            retrying={vehiclesQuery.isFetching}
            onRetry={() => void vehiclesQuery.refetch()}
          />
        </div>
      )}

      {/* The route's stops rise in (stopsRef below); the card itself holds
          still, so the two never stack. */}
      {selectedRoute && (
        <section className="card card-pad mt-5" style={routeStyle}>
          <header className="card-head">
            <span className="route-badge lg">
              <Icon name="bus" size={20} />
            </span>
            <div className="min-w-0">
              <h3 className="card-title">{selectedRoute.name}</h3>
              <p className="card-sub truncate tnum">
                {(() => {
                  const n = vehicles.filter((v) => canonicalRouteId(v.RouteID) === selectedRoute.id).length
                  return `${n} bus${n !== 1 ? 'es' : ''} active`
                })()}
                {trackingBus && (
                  <span className="text-[var(--color-txt-3)]">
                    {' '}
                    · Tracking bus {trackingBus.Name}
                    {selectedBus && selectedBus.VehicleID !== trackingBus.VehicleID ? ' (tap a bus on the map to switch)' : ''}
                  </span>
                )}
              </p>
            </div>
          </header>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-x-6 mb-3">
            <div className="eyebrow shrink-0 whitespace-nowrap">
              Stops on this route
            </div>
            <p className="text-[11.5px] leading-snug text-[var(--color-txt-3)] sm:text-right">
              Green pulse = at stop · Filled = reached
              {signedIn && (
                <>
                  {' '}
                  · Bell = your stop - chimes when the bus reaches the{' '}
                  <span className="font-semibold text-[var(--color-txt-2)]">stop before</span> yours
                </>
              )}
            </p>
          </div>

          {/* Signed out there are no bells: the chime and the stop it is for
              are kept for students with an account. Say what signing in gets,
              above the stops where the bells would be, and come back to this
              route after. */}
          {!authLoading && !user && (
            <p className="flex items-start gap-2 mb-3 text-[12.5px] leading-snug text-[var(--color-txt-2)]" data-transit-chime-invite>
              <Icon name="bell" size={14} className="shrink-0 mt-[2px] text-[var(--color-txt-3)]" />
              <span>
                Get a chime when the bus reaches the stop before yours.{' '}
                <Link to={previewSignInHref(pathname, search)} className="prose-link">
                  Sign in to set your stop
                </Link>
              </span>
            </p>
          )}

          {myStopId && stopBeforeMyStop && (
            <p className="text-[12.5px] text-[var(--color-txt-2)] mb-2">
              Alert when bus reaches: <span className="font-display font-bold text-[var(--color-txt-0)]">{stopBeforeMyStop.name}</span>
            </p>
          )}
          {myStopId && !stopBeforeMyStop && (
            <p className="text-[12.5px] text-[var(--color-warning)] mb-2">
              Pick a stop after the first in the list - there is no previous stop to trigger the chime.
            </p>
          )}

          {/* The route drawn as a line: one stop per row, the line in the
              route's colour running through every dot. */}
          <div ref={stopsRef} className="flex flex-col">
            {orderedStops.map((s, idx) => {
              const mode = stopHighlights[s.id]
              const isHere = mode === 'here'
              const isVisited = mode === 'visited'
              const isMyStop = myStopId === s.id
              const canPickMyStop = idx > 0
              const isLast = idx === orderedStops.length - 1
              return (
                <div key={s.id} className="relative flex items-stretch gap-3">
                  <div className="relative w-7 shrink-0" aria-hidden="true">
                    <span
                      className={`absolute left-1/2 -translate-x-1/2 w-1 bg-[var(--route)] ${idx === 0 ? 'top-1/2' : 'top-0'} ${isLast ? 'bottom-1/2' : 'bottom-0'}`}
                    />
                    <span
                      className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full box-border ${
                        isHere
                          ? 'w-[18px] h-[18px] bg-[var(--color-success)] border-[3px] border-[var(--color-surface)] shadow-[0_0_0_3px_var(--color-success)] animate-pulse'
                          : isVisited
                            ? 'w-4 h-4 bg-[var(--route)] border-[3.5px] border-[var(--route)] shadow-[0_0_0_2px_var(--color-surface)]'
                            : 'w-4 h-4 bg-[var(--color-surface)] border-[3.5px] border-[var(--route)]'
                      }`}
                    />
                  </div>
                  <div
                    className={`flex-1 min-w-0 flex items-center gap-2.5 min-h-[52px] py-1.5 ${isLast ? '' : 'border-b border-[var(--color-border)]'}`}
                  >
                    <span
                      className={`flex-1 min-w-0 text-[14px] leading-snug ${
                        isHere ? 'font-display font-bold text-[var(--color-txt-0)]' : 'text-[var(--color-txt-1)]'
                      }`}
                    >
                      {s.name}
                    </span>
                    {isMyStop && (
                      <span className="badge shrink-0 bg-[var(--color-txt-0)] text-[var(--color-surface)]">
                        My stop
                      </span>
                    )}
                    {isHere && (
                      <span className="badge shrink-0 bg-[var(--color-success)] text-[var(--color-on-route)]">
                        Here
                      </span>
                    )}
                    {signedIn && (
                    <button
                      type="button"
                      disabled={!canPickMyStop}
                      onClick={() => canPickMyStop && toggleMyStop(s.id)}
                      title={
                        !canPickMyStop
                          ? 'First stop has no “before” stop - pick another'
                          : isMyStop
                            ? 'Tap to clear my stop'
                            : 'Set as my stop (chime at the stop before)'
                      }
                      className={`btn btn-sm shrink-0 w-11 md:w-9 px-0 disabled:opacity-40 ${
                        isMyStop ? 'btn-ink' : 'btn-ghost text-[var(--color-txt-3)] hover:text-[var(--color-txt-0)]'
                      }`}
                    >
                      <Icon name="bell" size={18} />
                    </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
