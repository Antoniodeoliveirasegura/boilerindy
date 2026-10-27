import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MapContainer, TileLayer, useMap, GeoJSON, Marker, CircleMarker, ZoomControl } from 'react-leaflet'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import Icon from '../components/Icons'
import { useTheme } from '../context/ThemeContext'
import { extractBuildingCode } from '../lib/buildingCode'
import { buildingKey, buildingsFromGeoJson, findBuildingByCode, type Building, type LatLngBounds } from '../lib/campusBuildings'
import MapLayerToggle from '../components/map/MapLayerToggle'
import ParkingGarageLayer from '../components/map/ParkingGarageLayer'
import { useMapLayers, type MapLayerId } from '../components/map/mapLayers'
import PageTitle from '../components/PageTitle'
import { ESRI_TILE_ATTRIBUTION as TILE_ATTRIBUTION, INK_BUTTON } from '../components/map/mapChrome'

const CAMPUS_CENTER: [number, number] = [39.7740, -86.1720]
const DEFAULT_ZOOM = 16
const FLY_ZOOM = 18

// A building is fitted whole (all of its shapes, issue #374); the user's
// location is a point at a fixed zoom. Each request is a new object, so the
// same target twice still flies.
type FlyRequest = { lat: number; lng: number; zoom: number } | { bounds: LatLngBounds } | null

// Basemap: Esri's keyless light/dark gray canvases (issue #160). CARTO's free
// basemaps started returning "API KEY REQUIRED" watermarks in Sept 2026. The
// canvases only have real data to zoom 16, so the layer upscales past that.
const TILE_DARK = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
const TILE_LIGHT = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'
const TILE_MAX_NATIVE_ZOOM = 16

// Official Purdue Indianapolis Building Shapes - has BUILDING_NAME, PU_ABBR, BuildingLabels
const PURDUE_BUILDINGS_URL = "https://services1.arcgis.com/mLNdQKiKsj5Z5YMN/arcgis/rest/services/Indianapolis_Building_Shapes/FeatureServer/123/query?where=1%3D1&outFields=BUILDING_NAME,PU_ABBR,BuildingLabels,add_full&returnGeometry=true&outSR=4326&f=geojson"

const SECTIONS = [
  { key: 'academic', label: 'Academic', icon: 'graduation' },
  { key: 'services', label: 'Services & Dining', icon: 'grid' },
  { key: 'parking', label: 'Parking', icon: 'bus' },
  { key: 'other', label: 'Other', icon: 'mapPin' },
]

// Leaflet writes shape colours into SVG attributes, which cannot read CSS
// variables, so these mirror the tokens in index.css for each theme: the Map
// line (teal) for the buildings layer, the signal amber for "you are here"
// (it is now), and txt-0 for that stop's ring (ink on paper, white on the
// dark basemap).
const LINE = {
  light: { map: '#08706F', gold: '#F4A51C', ring: '#0F1217' },
  dark: { map: '#4ECDC4', gold: '#FFB938', ring: '#F3F4F6' },
}
// The selected building's outline; map.spec finds the lit shapes by it.
const SELECTED_STROKE = '#FFD700'

// Building codes are small square plates on the Map line, like route badges.
// Selection is not amber (amber is for now): the selected building's plate
// inverts to txt-0, ink on the light map and white on the dark one.
const LABEL_BASE =
  'w-fit min-w-[24px] mx-auto px-[5px] py-[3px] rounded-[3px] font-display font-extrabold text-[10px] leading-none tracking-[0.06em] whitespace-nowrap text-center'
const LABEL_IDLE = 'bg-[var(--color-map-color)] text-[var(--color-on-route)] shadow-[0_0_0_1.5px_var(--color-surface)]'
const LABEL_SELECTED = 'bg-[var(--color-txt-0)] text-[var(--color-surface)] shadow-[0_0_0_2px_var(--color-surface)]'

// From md the assistant button floats over the map's bottom right corner;
// keep the tile credit and the zoom buttons above it (bottom right, as on
// /transit) clear of it. Phones hide the zoom buttons (index.css), and below
// lg the search button and layer chips own the top left corner.
const CONTROLS_CLEAR_FAB =
  'md:[&_.leaflet-control-attribution]:mr-[72px]! md:[&_.leaflet-control-zoom]:mr-[72px]!'

// The dark gray canvas is a flat mid gray. Push it apart, darker ground and
// lighter streets, so it sits in the dark theme without tinting it (the old
// sepia wash in index.css turned the whole map brown).
const DARK_TILES = '[&_.leaflet-tile-pane]:[filter:brightness(0.94)_contrast(1.44)]'

/** Create a custom div icon for building labels */
function createLabelIcon(label: string, selected: boolean) {
  return L.divIcon({
    className: 'building-label-marker',
    html: `<div class="${LABEL_BASE} ${selected ? LABEL_SELECTED : LABEL_IDLE}">${label}</div>`,
    iconSize: [50, 20],
    iconAnchor: [25, 10],
  })
}

function BuildingLabels({
  buildings,
  selectedId,
}: {
  buildings: Building[]
  selectedId: string | null
}) {
  return (
    <>
      {buildings.map((bldg) => {
        if (!bldg.displayCode) return null
        const isSelected = bldg.id === selectedId
        return (
          <Marker
            key={bldg.id}
            position={[bldg.lat, bldg.lng]}
            icon={createLabelIcon(bldg.displayCode, isSelected)}
            opacity={isSelected ? 1 : 0.92}
            zIndexOffset={isSelected ? 1000 : 0}
            interactive={false}
          />
        )
      })}
    </>
  )
}

function MapController({ flyRequest }: { flyRequest: FlyRequest }) {
  const map = useMap()

  useEffect(() => {
    if (!flyRequest) return
    if ('bounds' in flyRequest) {
      map.flyToBounds(flyRequest.bounds, { maxZoom: FLY_ZOOM, padding: [48, 48], duration: 0.85 })
    } else {
      map.flyTo([flyRequest.lat, flyRequest.lng], flyRequest.zoom, { duration: 0.85 })
    }
  }, [flyRequest, map])

  return null
}

type Section = (typeof SECTIONS)[number] & { items: Building[] }

/**
 * Whether the building layer is still loading or failed, under the search box
 * in the desktop sidebar and in the phone sheet. Only the sidebar had it, and
 * it is hidden below lg, so on a phone a failed layer looked like an empty
 * list.
 */
function BuildingsStatus({ loading, error, className = '' }: { loading: boolean; error: string | null; className?: string }) {
  if (loading) return <div className={`text-[12.5px] text-[var(--color-txt-2)] ${className}`}>Loading buildings...</div>
  if (error) return <div className={`text-[12.5px] text-[var(--color-error)] ${className}`}>Error: {error}</div>
  return null
}

/** A search that matches nothing says so, instead of leaving the list blank. */
function NoMatches({ query }: { query: string }) {
  return <p className="px-2 py-4 text-[13.5px] text-[var(--color-txt-2)]">No buildings match “{query}”.</p>
}

/** The grouped building list, shared by the desktop sidebar and the phone sheet. */
function BuildingList({
  sections,
  selectedId,
  onSelect,
  heading: Heading,
  roomy = false,
}: {
  sections: Section[]
  selectedId: string | null
  onSelect: (b: Building) => void
  heading: 'h2' | 'h3'
  roomy?: boolean
}) {
  return (
    <>
      {sections.map((section) => section.items.length > 0 && (
        <div key={section.key} className="mt-4 first:mt-1">
          <div className="sticky top-0 z-[1] flex items-center gap-2.5 px-2 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <span className="route-badge sm"><Icon name={section.icon} size={14} /></span>
            <Heading className="eyebrow bare m-0 text-[var(--color-txt-1)]">
              {section.label} ({section.items.length})
            </Heading>
          </div>
          <ul className="list-none m-0 p-0">
            {section.items.map((b) => {
              const isSelected = selectedId === b.id
              return (
                <li key={b.id} className="border-b border-[var(--color-border)] last:border-b-0">
                  <button
                    onClick={() => onSelect(b)}
                    className={`w-full text-left flex gap-3 transition-colors ${roomy ? 'px-3 py-3.5' : 'px-2.5 py-2.5'} ${
                      isSelected
                        ? 'bg-[var(--route-tint)] shadow-[inset_4px_0_0_var(--route)]'
                        : 'hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-bg-2)]'
                    }`}
                  >
                    <span className={`mt-0.5 shrink-0 ${isSelected ? 'text-[var(--route-text)]' : 'text-[var(--color-txt-3)]'}`}>
                      <Icon name="mapPin" size={roomy ? 16 : 14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block font-display font-semibold leading-snug text-[var(--color-txt-0)] ${roomy ? 'text-[14.5px]' : 'text-[13.5px]'}`}>
                        {b.name}
                      </span>
                      {b.displayCode && (
                        <span className={`code mt-1.5 ${isSelected ? 'solid' : ''}`}>
                          {b.displayCode}
                        </span>
                      )}
                    </span>
                    {roomy && <Icon name="arrowUpRight" size={16} className="text-[var(--color-txt-3)] shrink-0 mt-0.5" />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </>
  )
}

export default function Map() {
  const { dark } = useTheme()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [geoData, setGeoData] = useState<any>(null)
  const [buildings, setBuildings] = useState<Building[]>([])
  const [flyRequest, setFlyRequest] = useState<FlyRequest>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false) // For mobile
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const sheetSearchRef = useRef<HTMLInputElement | null>(null)
  const searchButtonRef = useRef<HTMLButtonElement | null>(null)
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [locationLoading, setLocationLoading] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  // Toggleable overlays (issue #158). `/map?layer=parking` opens with that layer on.
  const [searchParams] = useSearchParams()
  const forcedLayers = useMemo(
    () => (searchParams.get('layer') || '').split(',').filter((v): v is MapLayerId => v === 'parking' || v === 'buildings'),
    [searchParams],
  )
  const { layers, toggle: toggleLayer } = useMapLayers(forcedLayers)

  const locateUser = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported')
      return
    }
    setLocationLoading(true)
    setLocationError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setUserLocation(loc)
        setLocationLoading(false)
        setFlyRequest({ lat: loc.lat, lng: loc.lng, zoom: 17 })
      },
      (err) => {
        setLocationError(err.code === 1 ? 'Location access denied' : 'Could not get location')
        setLocationLoading(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    )
  }, [])

  // Fetch official Purdue Indianapolis building data, then resolve any deep
  // link (?building= / ?room=) from the Schedule page once buildings exist.
  // Deep-link selection lives in this async callback (not a reactive effect)
  // so it never calls setState synchronously inside an effect body. The URL is
  // read directly (mount-time value) because deep links arrive on navigation.
  useEffect(() => {
    fetch(PURDUE_BUILDINGS_URL)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch building data')
        return res.json()
      })
      .then(data => {
        setGeoData(data)
        const processedBuildings = buildingsFromGeoJson(data)
        setBuildings(processedBuildings)
        setLoading(false)

        const params = new URLSearchParams(window.location.search)
        const room = params.get('room')
        const targetCode =
          params.get('building') ||
          (room ? extractBuildingCode(room) : null)
        if (!targetCode) return

        const place = findBuildingByCode(processedBuildings, targetCode)
        if (place) {
          setSelectedId(place.id)
          setFlyRequest({ bounds: place.bounds })
        }
      })
      .catch(err => {
        console.error("Failed to load Purdue building data:", err)
        setError(err instanceof Error ? err.message : 'Failed to load building data')
        setLoading(false)
      })
  }, [])

  const filteredBuildings = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return buildings
    return buildings.filter(b =>
      b.name.toLowerCase().includes(q) ||
      b.abbr.toLowerCase().includes(q) ||
      (b.displayCode && b.displayCode.toLowerCase().includes(q)) ||
      (b.address && b.address.toLowerCase().includes(q))
    )
  }, [search, buildings])

  const grouped = useMemo(() => {
    const bySection: Record<string, Building[]> = Object.fromEntries(
      SECTIONS.map(s => [s.key, [] as Building[]]),
    )
    for (const b of filteredBuildings) {
      if (bySection[b.section]) {
        bySection[b.section].push(b)
      } else {
        bySection['other'].push(b)
      }
    }
    return SECTIONS.map(s => ({ ...s, items: bySection[s.key] }))
  }, [filteredBuildings])

  const noMatches = buildings.length > 0 && filteredBuildings.length === 0
  const selectedBuilding = buildings.find(b => b.id === selectedId) ?? null
  const line = LINE[dark ? 'dark' : 'light']

  // Shapes and list entries share buildingKey, so selecting a building lights
  // up every one of its shapes. PU_ABBR alone missed the 30 features that have
  // none (issue #374).
  const geoJsonStyle = (feature: any) => {
    const isSelected = selectedId != null && buildingKey(feature.properties) === selectedId

    return {
      color: isSelected ? SELECTED_STROKE : line.map,
      weight: isSelected ? 3 : 1.5,
      fillOpacity: isSelected ? 0.4 : 0.16,
      fillColor: line.map,
      opacity: isSelected ? 1 : 0.85,
    }
  }

  const onEachFeature = (feature: any, layer: L.Layer) => {
    const props = feature.properties || {}
    const name = props.BUILDING_NAME || 'Building'
    const code = props.BuildingLabels || props.PU_ABBR || ''
    const address = props.add_full || ''

    const popupContent = `
      <div style="color:var(--color-txt-0);min-width:180px;font-family:var(--font-sans);">
        <div style="font-family:var(--font-display);font-weight:800;font-size:14px;line-height:1.25;margin-bottom:6px;">${name}</div>
        ${code ? `<div style="font-size:12px;color:var(--color-txt-2);margin-bottom:3px;">Code: <strong style="font-family:var(--font-display);font-weight:800;color:var(--color-map-color);">${code}</strong></div>` : ''}
        ${address ? `<div style="font-size:12px;color:var(--color-txt-2);">${address}</div>` : ''}
      </div>
    `
    layer.bindPopup(popupContent)

    layer.on('click', () => {
      const key = buildingKey(props)
      if (key && buildings.some(b => b.id === key)) {
        setSelectedId(key)
      }
    })
  }

  // Opening the phone sheet puts focus in its search box. autoFocus only ran
  // at mount, when the sheet was closed, so focus stayed on the search button
  // behind the backdrop.
  useEffect(() => {
    if (sidebarOpen) sheetSearchRef.current?.focus({ preventScroll: true })
  }, [sidebarOpen])

  // Focus left in the sheet as it closes (a building picked, the close
  // button) goes back to the search button instead of dropping to the page
  // body. A layout effect, so it runs before the browser clears focus out of
  // the newly inert sheet.
  useLayoutEffect(() => {
    if (!sidebarOpen && sheetRef.current?.contains(document.activeElement)) searchButtonRef.current?.focus()
  }, [sidebarOpen])

  // Escape closes the sheet, as it does the assistant panel. Nothing handled
  // it, so the sheet stayed open.
  useEffect(() => {
    if (!sidebarOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSidebarOpen(false)
      searchButtonRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [sidebarOpen])

  // Close sidebar when a building is selected on mobile
  const handleBuildingSelect = (b: Building) => {
    setSelectedId(b.id)
    setFlyRequest({ bounds: b.bounds })
    setSidebarOpen(false) // Close on mobile after selection
  }

  return (
    // Phones: the map stops above the fixed tab bar (62px plus the safe area)
    // so nothing pinned to its bottom edge hides behind it; signed out, above
    // the preview bar's pitch card instead, whose height PreviewBar keeps in
    // --preview-note-h (issue #366). From md the bar is gone and the nav band
    // is 64px.
    <div className="flex flex-col lg:grid lg:grid-cols-[340px_1fr] h-[calc(100dvh_-_56px_-_var(--preview-note-h,calc(62px_+_env(safe-area-inset-bottom))))] md:h-[calc(100dvh-4rem)] overflow-hidden bg-[var(--color-bg-1)]">
      <PageTitle>Campus Map</PageTitle>
      {/* The visible h1 lives in the desktop sidebar, which is display:none
          below lg, so phones and tablets had no page heading at all. This
          one is for screen readers there and is gone from lg, so exactly one
          h1 is exposed at every width. */}
      <h1 className="sr-only lg:hidden">Campus Map</h1>
      {/* Desktop Sidebar */}
      <aside className="r-map hidden lg:flex flex-col z-10 min-h-0 border-r border-[var(--color-border-2)] bg-[var(--color-surface)]">
        <div className="px-5 pt-6 pb-4 border-b border-[var(--color-border)] space-y-4 shrink-0">
          <div className="flex items-center gap-3">
            <span className="route-badge lg"><Icon name="mapPin" size={22} /></span>
            <h1 className="page-title compact">Campus Map</h1>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search buildings..."
            className="input"
          />
          <MapLayerToggle layers={layers} onToggle={toggleLayer} />
          <BuildingsStatus loading={loading} error={error} />
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-6">
          <BuildingList sections={grouped} selectedId={selectedId} onSelect={handleBuildingSelect} heading="h2" />
          {noMatches && <NoMatches query={search.trim()} />}
        </div>
      </aside>

      {/* Map Container */}
      {/* `isolate` keeps Leaflet's pane z-indexes (400 to 1000) inside the
          map, so the assistant button and the tab bar stay on top of it. */}
      <div className="relative isolate flex-1 p-2 md:p-3 min-h-0">
        <div className={`h-full w-full overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border-2)] purdue-map ${CONTROLS_CLEAR_FAB} ${
          dark ? DARK_TILES : 'is-light'
        }`}>
          <MapContainer center={CAMPUS_CENTER} zoom={DEFAULT_ZOOM} zoomControl={false} className="h-full w-full bg-[var(--color-bg-2)]!">
            <ZoomControl position="bottomright" />
            <TileLayer
              key={dark ? 'dark' : 'light'}
              url={dark ? TILE_DARK : TILE_LIGHT}
              attribution={TILE_ATTRIBUTION}
              maxNativeZoom={TILE_MAX_NATIVE_ZOOM}
              maxZoom={19}
            />

            {geoData && layers.buildings && (
              <GeoJSON
                key={`geojson-${selectedId}-${dark ? 'dark' : 'light'}`}
                data={geoData}
                style={geoJsonStyle}
                onEachFeature={onEachFeature}
              />
            )}

            {layers.buildings && <BuildingLabels buildings={buildings} selectedId={selectedId} />}
            <ParkingGarageLayer visible={layers.parking} dark={dark} />
            <MapController flyRequest={flyRequest} />

            {/* User location: the amber "you are here" stop with a txt-0 ring */}
            {userLocation && (
              <>
                <CircleMarker
                  center={[userLocation.lat, userLocation.lng]}
                  radius={20}
                  pathOptions={{
                    fillColor: line.gold,
                    fillOpacity: 0.18,
                    color: line.gold,
                    weight: 1.5,
                    opacity: 0.7,
                  }}
                />
                <CircleMarker
                  center={[userLocation.lat, userLocation.lng]}
                  radius={8}
                  pathOptions={{
                    fillColor: line.gold,
                    fillOpacity: 1,
                    color: line.ring,
                    weight: 3,
                  }}
                />
              </>
            )}
          </MapContainer>
        </div>

        {/* Mobile: Search FAB */}
        <button
          ref={searchButtonRef}
          onClick={() => setSidebarOpen(true)}
          className={`lg:hidden absolute top-4 left-4 z-[1000] ${INK_BUTTON}`}
          aria-label="Search buildings"
        >
          <Icon name="search" size={20} />
        </button>

        {/* Mobile: layer chips next to the search button (desktop has them in
            the sidebar). Each chip is its own 44px ink plate, level with the
            search and locate buttons; the empty part of the strip lets map
            drags through. */}
        <div className="lg:hidden absolute top-4 left-[68px] right-[68px] z-[1000] pointer-events-none">
          <MapLayerToggle
            layers={layers}
            onToggle={toggleLayer}
            tone="ink"
            className="flex-nowrap gap-1.5 w-fit max-w-[calc(100%+12px)] overflow-x-auto scrollbar-hide p-1.5 pb-3 -m-1.5 -mb-3 pointer-events-auto"
          />
        </div>

        {/* Phones: a failed building layer says so on the map itself, under
            the top controls, as the desktop sidebar does. Without it the map
            showed no labels, a room link selected nothing and nothing said
            why. */}
        {error && (
          <div className="lg:hidden absolute top-[72px] left-4 right-4 z-[1000] pointer-events-none">
            <p role="alert" className="ink-panel w-fit px-3 py-2 text-[12.5px] leading-snug text-[var(--color-ink-txt)] shadow-[var(--shadow-md)]">
              Buildings could not load, so search and room links cannot find one.
            </p>
          </div>
        )}

        {/* Locate Me Button */}
        <button
          type="button"
          onClick={locateUser}
          disabled={locationLoading}
          className={`absolute top-4 right-4 z-[1000] ${INK_BUTTON} ${
            userLocation ? 'text-[var(--color-ink-signal)]' : ''
          } ${locationLoading ? 'animate-pulse' : ''}`}
          title={locationError || 'Show my location'}
          aria-label="Show my location"
        >
          <Icon name="locateMe" size={22} />
        </button>

        {/* Selected building info card. On phones it stops short of the
            assistant button; from md it sits bottom left, clear of it. */}
        {selectedBuilding && (
          <div className="r-map ink-panel absolute z-[1000] bottom-4 left-4 right-[80px] md:right-auto md:bottom-5 md:left-5 md:w-80 p-4 shadow-[var(--shadow-lg)] animate-fade-in-up">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {selectedBuilding.displayCode && (
                  <span className="code solid mb-2.5">
                    {selectedBuilding.displayCode}
                  </span>
                )}
                <h3 className="text-[17px] leading-tight text-[var(--color-ink-txt)]">{selectedBuilding.name}</h3>
                {selectedBuilding.address && (
                  <p className="text-[12.5px] text-[var(--color-ink-dim)] mt-1.5 leading-relaxed">{selectedBuilding.address}</p>
                )}
              </div>
              <button
                onClick={() => setSelectedId(null)}
                className="icon-btn -mr-2 -mt-2 shrink-0"
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Mobile: Bottom Sheet Sidebar */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/40 z-[1001]"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* The sheet stays mounted and only slides off screen, so closed it is
          inert: its close button, search box and building list used to stay
          in the Tab order, focus moving through them out of sight. */}
      <div ref={sheetRef} inert={!sidebarOpen} className={`r-map lg:hidden fixed bottom-0 left-0 right-0 bg-[var(--color-surface)] border-t border-[var(--color-border-2)] rounded-t-[var(--radius-2xl)] shadow-[var(--shadow-xl)] z-[1002] transition-transform duration-300 ${
        sidebarOpen ? 'translate-y-0' : 'translate-y-full'
      }`} style={{ maxHeight: '75vh' }}>
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-[var(--color-border-3)] rounded-[2px]" />
        </div>

        {/* Search Header */}
        <div className="px-4 pb-3 border-b border-[var(--color-border)]">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2.5">
              <span className="route-badge sm"><Icon name="mapPin" size={14} /></span>
              <h2 className="card-title text-[18px]">Find Building</h2>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="icon-btn -mr-2"
            >
              <Icon name="close" size={20} />
            </button>
          </div>
          <input
            ref={sheetSearchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search buildings..."
            className="input"
          />
          <BuildingsStatus loading={loading} error={error} className="mt-2.5" />
        </div>

        {/* Building List */}
        <div className="overflow-y-auto px-2 pb-8" style={{ maxHeight: 'calc(75vh - 120px)' }}>
          <BuildingList sections={grouped} selectedId={selectedId} onSelect={handleBuildingSelect} heading="h3" roomy />
          {noMatches && <NoMatches query={search.trim()} />}
        </div>
      </div>
    </div>
  )
}
