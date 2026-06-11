import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Icon from '../components/Icons'
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
} from '../lib/transitShared'

const CAMPUS_CENTER = { lat: 39.7745, lng: -86.1756 }
const HERE_METERS = 72
const VISITED_METERS = 95
/** After chime, allow again once bus is this far from the “before” stop */
const CHIME_RESET_METERS = 380

function playAlertChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const beep = (freq, t0) => {
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
}) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const markersRef = useRef({})
  const routeLinesRef = useRef([])
  const stopMarkersRef = useRef([])
  const userMarkerRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)
  const [userLocation, setUserLocation] = useState(null)
  const [locationLoading, setLocationLoading] = useState(false)
  const [locationError, setLocationError] = useState(null)

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
      const userIcon = L.divIcon({
        html: `
          <div style="position:relative;width:40px;height:40px;">
            <div style="
              position:absolute;
              top:50%;left:50%;
              transform:translate(-50%,-50%);
              width:40px;height:40px;
              background:rgba(59,130,246,0.2);
              border:2px solid rgba(59,130,246,0.4);
              border-radius:50%;
              animation:user-pulse 2s ease-out infinite;
            "></div>
            <div style="
              position:absolute;
              top:50%;left:50%;
              transform:translate(-50%,-50%);
              width:18px;height:18px;
              background:#3b82f6;
              border:3px solid white;
              border-radius:50%;
              box-shadow:0 2px 8px rgba(0,0,0,0.3);
            "></div>
          </div>`,
        className: 'user-location-marker',
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      })
      userMarkerRef.current = L.marker([userLocation.lat, userLocation.lng], { icon: userIcon, zIndexOffset: 1000 })
        .addTo(map)
        .bindPopup('<div style="font-family:system-ui;font-size:13px;font-weight:500;">You are here</div>')
    }

    map.setView([userLocation.lat, userLocation.lng], 16)
  }, [userLocation, mapReady])

  useEffect(() => {
    if (!mapRef.current) return

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove()
      mapInstanceRef.current = null
    }

    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
      document.head.appendChild(link)
    }

    const loadLeaflet = () => {
      return new Promise((resolve) => {
        if (window.L) {
          resolve(window.L)
          return
        }
        const script = document.createElement('script')
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
        script.onload = () => resolve(window.L)
        document.head.appendChild(script)
      })
    }

    let mounted = true

    loadLeaflet().then((L) => {
      if (!mounted || !mapRef.current) return
      if (mapRef.current._leaflet_id) return

      const map = L.map(mapRef.current, {
        zoomControl: false,
      }).setView([CAMPUS_CENTER.lat, CAMPUS_CENTER.lng], 14)

      L.control.zoom({ position: 'bottomright' }).addTo(map)

      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
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

    const points = []
    stops.forEach((stop) => {
      if (canonicalRouteId(stop.RouteID) !== selectedRoute.id) return
      if (stop.MapPoints && stop.MapPoints.length > 0) {
        stop.MapPoints.forEach((point) => {
          points.push([point.Latitude, point.Longitude])
        })
      }
    })

    if (points.length < 2) return

    const polyline = L.polyline(points, {
      color: selectedRoute.color,
      weight: 5,
      opacity: 0.9,
      smoothFactor: 1,
    }).addTo(map)

    routeLinesRef.current.push(polyline)
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
    const uniqueStops = []
    const seen = new Set()
    visibleStops.forEach((stop) => {
      const id = stop.RouteStopID != null ? String(stop.RouteStopID) : `${stop.Latitude},${stop.Longitude}`
      const key = `${stop.Latitude.toFixed(4)},${stop.Longitude.toFixed(4)}`
      if (seen.has(key)) return
      seen.add(key)
      uniqueStops.push({ ...stop, _sid: id })
    })

    uniqueStops.forEach((stop) => {
      const route = selectedRoute
      const sid = stop._sid
      const mode = stopHighlights?.[sid] || 'normal'

      const bg = mode === 'visited' ? route.color : '#ffffff'
      let ring = 'box-shadow:0 2px 6px rgba(0,0,0,0.25);'
      if (mode === 'here') {
        ring =
          'box-shadow:0 0 0 4px rgba(34,197,94,0.9),0 0 22px rgba(34,197,94,0.55);animation:transit-pulse 1.15s ease-in-out infinite;'
      } else if (mode === 'visited') {
        ring = `box-shadow:0 0 0 2px #fff,0 2px 8px ${route.color}66;`
      }

      const icon = L.divIcon({
        html: `<div style="
          width:14px;height:14px;background:${bg};
          border:3px solid ${mode === 'here' ? '#22c55e' : route.color};border-radius:50%;
          ${ring}
        "></div>`,
        className: 'transit-stop-marker',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      })

      const marker = L.marker([stop.Latitude, stop.Longitude], { icon })
        .addTo(map)
        .bindPopup(
          `<div style="font-family:system-ui;min-width:120px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:4px;">${stop.Description}</div>
            <div style="font-size:11px;color:${route.color};">${route.name}</div>
          </div>`,
        )

      stopMarkersRef.current.push(marker)
    })
  }, [stops, routes, selectedRoute, mapReady, stopHighlights, canonicalRouteId])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !window.L) return

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
      const isMoving = vehicle.GroundSpeed > 0

      const iconHtml = `
        <div style="
          width: 32px;
          height: 32px;
          background: ${route.color};
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px ${route.color}60;
          border: 3px solid white;
          transform: ${isSelected ? 'scale(1.2)' : 'scale(1)'};
          transition: transform 0.2s;
        ">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 6v6M16 6v6M2 12h2M20 12h2M5 18v2M19 18v2M5 6a3 3 0 013-3h8a3 3 0 013 3v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6z"/>
          </svg>
        </div>
        <div style="
          position: absolute;
          bottom: -6px;
          left: 50%;
          transform: translateX(-50%);
          background: white;
          padding: 1px 5px;
          border-radius: 4px;
          font-size: 9px;
          font-weight: 700;
          color: ${route.color};
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        ">${vehicle.Name}</div>
        ${
          isMoving
            ? `
          <div style="
            position: absolute;
            top: -3px;
            right: -3px;
            width: 10px;
            height: 10px;
            background: #22c55e;
            border-radius: 50%;
            border: 2px solid white;
          "></div>
        `
            : ''
        }
      `

      const icon = L.divIcon({
        html: iconHtml,
        className: 'custom-bus-marker',
        iconSize: [32, 42],
        iconAnchor: [16, 32],
      })

      const marker = L.marker([vehicle.Latitude, vehicle.Longitude], { icon })
        .addTo(map)
        .on('click', () => onSelectBus(vehicle))

      marker.bindPopup(
        `<div style="font-family: system-ui; min-width: 140px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 4px;">Bus ${vehicle.Name}</div>
          <div style="font-size: 12px; color: #666; margin-bottom: 8px;">${route.name}</div>
          <div style="font-size: 11px; display: flex; align-items: center; gap: 4px;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${isMoving ? '#22c55e' : '#9ca3af'}"></span>
            ${isMoving ? `${Math.round(vehicle.GroundSpeed)} mph` : 'Stopped'}
          </div>
        </div>`,
      )

      markersRef.current[vehicle.VehicleID] = marker
    })

    if (displayVehicles.length > 0) {
      const bounds = L.latLngBounds(displayVehicles.map((v) => [v.Latitude, v.Longitude]))
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 })
    }
  }, [vehicles, selectedBus, selectedRoute, onSelectBus, canonicalRouteId])

  return (
    <div className="relative w-full h-[280px] sm:h-[380px] lg:h-[450px] rounded-2xl overflow-hidden border border-[var(--color-border)] shadow-lg">
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
      <div ref={mapRef} className="w-full h-full" />

      <div className="absolute top-3 left-3 bg-white/95 dark:bg-[var(--color-bg-2)]/95 backdrop-blur-sm rounded-xl p-2 sm:p-3 shadow-lg z-[1000] max-w-[140px] sm:max-w-none">
        <div className="text-[9px] sm:text-[10px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-1.5 sm:mb-2">
          Active Routes
        </div>
        <div className="space-y-1 sm:space-y-1.5">
          {routes.map((route) => {
            const count = vehicles.filter((v) => canonicalRouteId(v.RouteID) === route.id).length
            if (count === 0) return null
            return (
              <div key={route.id} className="flex items-center gap-1.5 sm:gap-2">
                <div
                  className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded flex items-center justify-center text-[8px] sm:text-[9px] font-bold text-white shrink-0"
                  style={{ backgroundColor: route.color }}
                >
                  {route.num}
                </div>
                <span className="text-[10px] sm:text-[11px] text-[var(--color-txt-1)] truncate">{route.shortName}</span>
                <span className="text-[9px] sm:text-[10px] text-[var(--color-txt-3)]">({count})</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Locate Me Button */}
      <button
        type="button"
        onClick={locateUser}
        disabled={locationLoading}
        className={`absolute bottom-3 right-3 w-11 h-11 rounded-xl shadow-lg z-[1000] flex items-center justify-center transition-all border-2 ${
          userLocation
            ? 'bg-blue-500 text-white border-blue-400'
            : 'bg-white dark:bg-[var(--color-bg-2)] border-gray-200 dark:border-[var(--color-border)] text-gray-700 dark:text-[var(--color-txt-1)] hover:text-blue-500 hover:border-blue-400'
        } ${locationLoading ? 'animate-pulse' : ''}`}
        title={locationError || 'Show my location'}
        aria-label="Show my location"
      >
        <Icon name="locateMe" size={22} />
      </button>

      {vehicles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg-1)]/50 backdrop-blur-sm z-[1000]">
          <div className="text-center px-4">
            <Icon name="bus" size={28} className="mx-auto mb-2 text-[var(--color-txt-3)]" />
            <p className="text-[12px] sm:text-[13px] text-[var(--color-txt-2)]">No buses currently active</p>
          </div>
        </div>
      )}
    </div>
  )
}

function myStopStorageKey(routeId) {
  return `transit-my-stop-${routeId}`
}

export default function Transit() {
  const [rawVehicles, setRawVehicles] = useState([])
  const [stops, setStops] = useState([])
  const [selectedRoute, setSelectedRoute] = useState(null)
  const [selectedBus, setSelectedBus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [visitedStopIds, setVisitedStopIds] = useState(() => new Set())
  const [hereStopId, setHereStopId] = useState(null)
  /** One “my stop” per route — chime fires when bus reaches the stop before this one */
  const [myStopId, setMyStopId] = useState(null)
  const chimePlayedRef = useRef(false)
  const [routeIdToCanonical, setRouteIdToCanonical] = useState(() => ({ ...TRANLOC_ROUTE_ALIASES }))

  const canonicalRouteId = useCallback(
    (routeId) => canonicalFromMap(routeIdToCanonical, routeId),
    [routeIdToCanonical],
  )

  /**
   * Remap vehicles whose canonical route isn't running today to their active
   * schedule peer (e.g. Gray ↔ Orange share the same corridor but run on
   * opposite day sets). The RouteID on the returned object is replaced with the
   * peer's canonical id so all downstream filtering and coloring work correctly.
   */
  const vehicles = useMemo(() => {
    return rawVehicles.map((v) => {
      const canon = canonicalFromMap(routeIdToCanonical, v.RouteID)
      const route = routes.find((r) => r.id === canon)
      if (route && !isRouteActiveNow(route)) {
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

  const fetchVehicles = useCallback(async () => {
    try {
      const response = await fetch('/api/transit/vehicles')
      const data = await response.json()
      setRawVehicles(data || [])
      setLastUpdate(new Date())
    } catch (error) {
      console.error('Failed to fetch vehicles:', error)
    }
  }, [])

  const fetchStops = useCallback(async () => {
    try {
      const response = await fetch('/api/transit/stops')
      const data = await response.json()
      setStops(data || [])
    } catch (error) {
      console.error('Failed to fetch stops:', error)
    }
  }, [])

  const fetchTransitRouteMap = useCallback(async () => {
    try {
      const response = await fetch('/api/transit/routes')
      const data = await response.json()
      setRouteIdToCanonical(buildTranslocRouteIdMap(data))
    } catch {
      /* keep static TRANLOC_ROUTE_ALIASES */
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      setLoading(true)
      await Promise.all([fetchVehicles(), fetchStops(), fetchTransitRouteMap()])
      setLoading(false)
    }
    init()

    const interval = setInterval(fetchVehicles, 10000)
    return () => clearInterval(interval)
  }, [fetchVehicles, fetchStops, fetchTransitRouteMap])

  const orderedStops = useMemo(() => {
    if (!selectedRoute) return []
    return getOrderedStopsForRoute(stops, selectedRoute.id, routeIdToCanonical)
  }, [stops, selectedRoute, routeIdToCanonical])

  const trackingBus = useMemo(() => {
    if (!selectedRoute) return null
    const onRoute = vehicles.filter((v) => canonicalRouteId(v.RouteID) === selectedRoute.id)
    if (!onRoute.length) return null
    if (selectedBus && onRoute.some((v) => v.VehicleID === selectedBus.VehicleID)) return selectedBus
    return onRoute[0]
  }, [vehicles, selectedRoute, selectedBus, canonicalRouteId])

  useEffect(() => {
    setVisitedStopIds(new Set())
    setHereStopId(null)
    chimePlayedRef.current = false
    if (!selectedRoute) {
      setMyStopId(null)
      return
    }
    try {
      const raw = localStorage.getItem(myStopStorageKey(selectedRoute.id))
      if (raw) {
        const parsed = JSON.parse(raw)
        setMyStopId(typeof parsed === 'string' ? parsed : null)
      } else {
        setMyStopId(null)
      }
    } catch {
      setMyStopId(null)
    }
  }, [selectedRoute?.id])

  const toggleMyStop = useCallback(
    (stopId) => {
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
    [selectedRoute?.id],
  )

  const stopBeforeMyStop = useMemo(() => {
    if (!myStopId || !orderedStops.length) return null
    const idx = orderedStops.findIndex((s) => s.id === myStopId)
    if (idx <= 0) return null
    return orderedStops[idx - 1]
  }, [myStopId, orderedStops])

  useEffect(() => {
    if (!trackingBus || !orderedStops.length) {
      setHereStopId(null)
      return
    }

    let nearest = null
    let nearestD = Infinity
    const lat = trackingBus.Latitude
    const lon = trackingBus.Longitude

    orderedStops.forEach((s) => {
      const d = haversineMeters(lat, lon, s.lat, s.lon)
      if (d < nearestD) {
        nearestD = d
        nearest = s
      }
    })

    setHereStopId(nearest && nearestD <= HERE_METERS ? nearest.id : null)

    setVisitedStopIds((prev) => {
      const next = new Set(prev)
      orderedStops.forEach((s) => {
        const d = haversineMeters(lat, lon, s.lat, s.lon)
        if (d <= VISITED_METERS) next.add(s.id)
      })
      return next
    })
  }, [trackingBus, orderedStops])

  useEffect(() => {
    if (!trackingBus || !stopBeforeMyStop) return

    const lat = trackingBus.Latitude
    const lon = trackingBus.Longitude
    const dist = haversineMeters(lat, lon, stopBeforeMyStop.lat, stopBeforeMyStop.lon)

    if (dist <= HERE_METERS && !chimePlayedRef.current) {
      chimePlayedRef.current = true
      playAlertChime()
    }
    if (dist > CHIME_RESET_METERS) {
      chimePlayedRef.current = false
    }
  }, [trackingBus, stopBeforeMyStop])

  const stopHighlights = useMemo(() => {
    const h = {}
    orderedStops.forEach((s) => {
      if (hereStopId === s.id) h[s.id] = 'here'
      else if (visitedStopIds.has(s.id)) h[s.id] = 'visited'
      else h[s.id] = 'normal'
    })
    return h
  }, [orderedStops, hereStopId, visitedStopIds])

  return (
    <div className="max-w-[1000px] mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-4 mb-5 sm:mb-6 animate-fade-in-up">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-[var(--color-txt-0)]">Campus Transit</h1>
          <p className="text-[13px] sm:text-[14px] text-[var(--color-txt-2)] mt-1">
            JAGLINE shuttle live tracking
            {lastUpdate && (
              <span className="text-[var(--color-txt-3)] hidden sm:inline"> · Updated {lastUpdate.toLocaleTimeString()}</span>
            )}
          </p>
        </div>
        <button
          onClick={fetchVehicles}
          className="text-[13px] text-[var(--color-accent)] flex items-center gap-1.5 hover:gap-2 transition-all font-medium self-start sm:self-auto py-2 px-3 -mx-3 sm:mx-0 sm:p-0 rounded-lg active:bg-[var(--color-accent)]/10"
        >
          <Icon name="refresh" size={14} />
          Refresh
        </button>
      </div>

      {/* Route filter pills — horizontal scroll on mobile */}
      <div className="mb-5 sm:mb-6 animate-fade-in-up stagger-1">
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible scrollbar-hide">
          <button
            onClick={() => setSelectedRoute(null)}
            className={`pill whitespace-nowrap shrink-0 min-h-[40px] sm:min-h-0 ${!selectedRoute ? 'pill-active' : ''}`}
          >
            All Routes ({vehicles.length})
          </button>
          {routes.map((route) => {
            const count = vehicles.filter((v) => canonicalRouteId(v.RouteID) === route.id).length
            const activeToday = isRouteActiveNow(route)
            return (
              <button
                key={route.id}
                onClick={() => setSelectedRoute(selectedRoute?.id === route.id ? null : route)}
                className={`pill whitespace-nowrap flex items-center gap-2 transition-opacity shrink-0 min-h-[40px] sm:min-h-0
                  ${selectedRoute?.id === route.id ? 'pill-active' : ''}
                  ${!activeToday ? 'opacity-40' : ''}`}
                title={route.schedule?.label ?? ''}
              >
                <span
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                  style={{ backgroundColor: route.color }}
                >
                  {route.num}
                </span>
                <span className="hidden sm:inline">{route.shortName}</span>
                <span className="sm:hidden">{route.num}</span>
                {count > 0 && <span className="text-[var(--color-txt-3)]">({count})</span>}
                {!activeToday && (
                  <span className="text-[10px] text-[var(--color-txt-3)] font-normal hidden sm:inline">off</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Schedule reference — hidden on mobile for cleaner UI */}
        <div className="mt-3 hidden sm:flex flex-wrap gap-x-5 gap-y-1">
          {[...new Map(routes.map(r => [r.schedule?.label, r])).values()].map(r => {
            if (!r.schedule) return null
            const groupRoutes = routes.filter(x => x.schedule?.label === r.schedule.label)
            return (
              <div key={r.schedule.label} className="flex items-center gap-1.5 text-[11px] text-[var(--color-txt-3)]">
                <div className="flex gap-0.5">
                  {groupRoutes.map(gr => (
                    <span key={gr.id} className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: gr.color }} />
                  ))}
                </div>
                <span>{r.schedule.label}</span>
              </div>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="card p-12 text-center animate-fade-in-up stagger-2">
          <div className="w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-[13px] text-[var(--color-txt-2)]">Loading transit data...</p>
        </div>
      ) : (
        <div className="animate-fade-in-up stagger-2 mb-6">
          <LiveMap
            vehicles={vehicles}
            routes={routes}
            stops={stops}
            selectedRoute={selectedRoute}
            selectedBus={selectedBus}
            onSelectBus={setSelectedBus}
            stopHighlights={stopHighlights}
            canonicalRouteId={canonicalRouteId}
          />
        </div>
      )}

      {selectedRoute && (
        <div className="card p-4 sm:p-5 animate-fade-in-up stagger-3">
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: selectedRoute.color }}
            >
              <Icon name="bus" size={20} className="text-white" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[14px] sm:text-[15px] font-semibold text-[var(--color-txt-0)]">{selectedRoute.name}</h3>
              <p className="text-[11px] sm:text-[12px] text-[var(--color-txt-2)] truncate">
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
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
            <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
              Stops on this route
            </div>
            <p className="text-[11px] text-[var(--color-txt-3)]">
              Green pulse = at stop · Filled = reached · Bell = your stop — chimes when the bus reaches the{' '}
              <span className="font-medium text-[var(--color-txt-2)]">stop before</span> yours
            </p>
          </div>

          {myStopId && stopBeforeMyStop && (
            <p className="text-[11px] text-[var(--color-txt-2)] mb-2 px-0.5">
              Alert when bus reaches: <span className="font-medium">{stopBeforeMyStop.name}</span>
            </p>
          )}
          {myStopId && !stopBeforeMyStop && (
            <p className="text-[11px] text-amber-700/90 dark:text-amber-400/90 mb-2 px-0.5">
              Pick a stop after the first in the list — there is no previous stop to trigger the chime.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {orderedStops.map((s, idx) => {
              const mode = stopHighlights[s.id]
              const isHere = mode === 'here'
              const isVisited = mode === 'visited'
              const isMyStop = myStopId === s.id
              const canPickMyStop = idx > 0
              return (
                <div
                  key={s.id}
                  className={`flex items-center gap-2.5 sm:gap-3 rounded-xl border px-3 py-3 sm:py-2.5 transition-all duration-300 ${
                    isHere
                      ? 'border-emerald-400/80 bg-emerald-500/10 shadow-[0_0_20px_rgba(34,197,94,0.25)]'
                      : isMyStop
                        ? 'border-[var(--color-accent)]/60 bg-[var(--color-accent)]/8'
                        : isVisited
                          ? 'border-[var(--color-border)] bg-[var(--color-stat)]/80'
                          : 'border-[var(--color-border)] bg-[var(--color-bg-1)]'
                  }`}
                >
                  <div
                    className={`shrink-0 w-2.5 h-2.5 rounded-full ${isHere ? 'animate-pulse bg-emerald-500' : isVisited ? '' : 'bg-[var(--color-txt-3)]/40'}`}
                    style={isVisited && !isHere ? { backgroundColor: selectedRoute.color } : undefined}
                  />
                  <span className={`text-[13px] flex-1 min-w-0 ${isHere ? 'font-semibold text-[var(--color-txt-0)]' : 'text-[var(--color-txt-1)]'}`}>
                    {s.name}
                  </span>
                  {isMyStop && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent)] shrink-0">
                      My stop
                    </span>
                  )}
                  {isHere && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400 shrink-0">
                      Here
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={!canPickMyStop}
                    onClick={() => canPickMyStop && toggleMyStop(s.id)}
                    title={
                      !canPickMyStop
                        ? 'First stop has no “before” stop — pick another'
                        : isMyStop
                          ? 'Tap to clear my stop'
                          : 'Set as my stop (chime at the stop before)'
                    }
                    className={`shrink-0 p-2.5 sm:p-2 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      isMyStop
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                        : 'border-[var(--color-border)] text-[var(--color-txt-3)] hover:text-[var(--color-txt-1)] active:bg-[var(--color-bg-2)]'
                    }`}
                  >
                    <Icon name="bell" size={18} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
