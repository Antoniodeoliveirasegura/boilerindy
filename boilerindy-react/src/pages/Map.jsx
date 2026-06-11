import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MapContainer, TileLayer, useMap, GeoJSON, Marker, CircleMarker } from 'react-leaflet'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import Icon from '../components/Icons'

const CAMPUS_CENTER = [39.7740, -86.1720]
const DEFAULT_ZOOM = 16
const FLY_ZOOM = 18

const TILE_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'

// Official Purdue Indianapolis Building Shapes - has BUILDING_NAME, PU_ABBR, BuildingLabels
const PURDUE_BUILDINGS_URL = "https://services1.arcgis.com/mLNdQKiKsj5Z5YMN/arcgis/rest/services/Indianapolis_Building_Shapes/FeatureServer/123/query?where=1%3D1&outFields=BUILDING_NAME,PU_ABBR,BuildingLabels,add_full&returnGeometry=true&outSR=4326&f=geojson"

const SECTIONS = [
  { key: 'academic', label: 'Academic', icon: 'graduation' },
  { key: 'services', label: 'Services & Dining', icon: 'grid' },
  { key: 'parking', label: 'Parking', icon: 'bus' },
  { key: 'other', label: 'Other', icon: 'mapPin' },
]

// Categorize buildings by their abbreviation or name
function categorizeBuilding(abbr, name) {
  const abbrUpper = (abbr || '').toUpperCase()
  const nameUpper = (name || '').toUpperCase()
  
  // Parking structures
  if (nameUpper.includes('PARKING') || nameUpper.includes('GARAGE') || abbrUpper.endsWith('G')) {
    return 'parking'
  }
  
  // Services, dining, student life
  if (nameUpper.includes('CAMPUS CENTER') || nameUpper.includes('DINING') || 
      nameUpper.includes('LIBRARY') || nameUpper.includes('STUDENT')) {
    return 'services'
  }
  
  // Academic buildings
  if (nameUpper.includes('HALL') || nameUpper.includes('SCIENCE') || 
      nameUpper.includes('ENGINEERING') || nameUpper.includes('SCHOOL') ||
      nameUpper.includes('EDUCATION') || nameUpper.includes('NURSING') ||
      nameUpper.includes('MEDICINE') || nameUpper.includes('INFORMATICS') ||
      nameUpper.includes('BUSINESS') || nameUpper.includes('LAB')) {
    return 'academic'
  }
  
  return 'other'
}

/** Calculate centroid of a polygon */
function getPolygonCentroid(coordinates) {
  let coords = coordinates
  if (coords[0] && Array.isArray(coords[0][0])) {
    coords = coords[0]
  }
  
  let sumLat = 0, sumLng = 0, count = 0
  for (const coord of coords) {
    if (Array.isArray(coord) && coord.length >= 2) {
      sumLng += coord[0]
      sumLat += coord[1]
      count++
    }
  }
  
  return count > 0 ? [sumLat / count, sumLng / count] : null
}

/** Create a custom div icon for building labels */
function createLabelIcon(label, dark) {
  return L.divIcon({
    className: 'building-label-marker',
    html: `<div class="building-code-label ${dark ? 'dark' : ''}">${label}</div>`,
    iconSize: [50, 20],
    iconAnchor: [25, 10],
  })
}

/** Extract building code from a room string like "ET 215" */
export function extractBuildingCode(roomStr) {
  if (!roomStr) return null
  const match = roomStr.match(/^([A-Z]{2,4})\s*\d*/i)
  return match ? match[1].toUpperCase() : null
}

/** Process GeoJSON to build places list */
function processBuildings(geoData) {
  if (!geoData?.features) return []
  
  const buildings = []
  
  for (const feature of geoData.features) {
    const props = feature.properties || {}
    const name = props.BUILDING_NAME || ''
    const abbr = props.PU_ABBR || props.BuildingLabels || ''
    const address = props.add_full || ''
    
    if (!name && !abbr) continue
    
    const geometry = feature.geometry
    if (!geometry || geometry.type !== 'Polygon') continue
    
    const centroid = getPolygonCentroid(geometry.coordinates)
    if (!centroid) continue
    
    // Use BuildingLabels as the display code (it's what shows on the official map)
    const displayCode = props.BuildingLabels || abbr
    
    const uniqueId = `${abbr || 'bldg'}-${buildings.length}`
    buildings.push({
      id: uniqueId,
      abbr: abbr || '',
      displayCode,
      name,
      fullName: displayCode ? `${name} (${displayCode})` : name,
      address,
      section: categorizeBuilding(abbr, name),
      lat: centroid[0],
      lng: centroid[1],
      feature,
    })
  }
  
  // Sort by name
  return buildings.sort((a, b) => a.name.localeCompare(b.name))
}

function BuildingLabels({ buildings, dark, selectedId }) {
  return (
    <>
      {buildings.map((bldg) => {
        if (!bldg.displayCode) return null
        const isSelected = bldg.id === selectedId
        return (
          <Marker
            key={bldg.id}
            position={[bldg.lat, bldg.lng]}
            icon={createLabelIcon(bldg.displayCode, dark)}
            opacity={isSelected ? 1 : 0.9}
            interactive={false}
          />
        )
      })}
    </>
  )
}

function MapController({ flyRequest }) {
  const map = useMap()
  
  useEffect(() => {
    if (flyRequest.lat == null) return
    map.flyTo([flyRequest.lat, flyRequest.lng], flyRequest.zoom, { duration: 0.85 })
  }, [flyRequest.seq, flyRequest.lat, flyRequest.lng, flyRequest.zoom, map])
  
  return null
}

export default function Map() {
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [geoData, setGeoData] = useState(null)
  const [buildings, setBuildings] = useState([])
  const [flyRequest, setFlyRequest] = useState({ lat: null, lng: null, zoom: DEFAULT_ZOOM, seq: 0 })
  const [initialFlyDone, setInitialFlyDone] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false) // For mobile
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
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setUserLocation(loc)
        setLocationLoading(false)
        setFlyRequest(fr => ({ lat: loc.lat, lng: loc.lng, zoom: 17, seq: fr.seq + 1 }))
      },
      (err) => {
        setLocationError(err.code === 1 ? 'Location access denied' : 'Could not get location')
        setLocationLoading(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    )
  }, [])

  // Fetch official Purdue Indianapolis building data
  useEffect(() => {
    setLoading(true)
    fetch(PURDUE_BUILDINGS_URL)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch building data')
        return res.json()
      })
      .then(data => {
        setGeoData(data)
        const processedBuildings = processBuildings(data)
        setBuildings(processedBuildings)
        setLoading(false)
      })
      .catch(err => {
        console.error("Failed to load Purdue building data:", err)
        setError(err.message)
        setLoading(false)
      })
  }, [])

  // Handle URL parameters for deep linking from Schedule page
  useEffect(() => {
    if (initialFlyDone || !buildings.length) return
    
    const buildingParam = searchParams.get('building')
    const roomParam = searchParams.get('room')
    
    let targetCode = buildingParam
    if (!targetCode && roomParam) {
      targetCode = extractBuildingCode(roomParam)
    }
    
    if (targetCode) {
      const upperCode = targetCode.toUpperCase()
      // Match by abbr, BuildingLabels, or displayCode
      const place = buildings.find(b => 
        b.abbr.toUpperCase() === upperCode || 
        b.displayCode?.toUpperCase() === upperCode
      )
      if (place) {
        setSelectedId(place.id)
        setFlyRequest(fr => ({ lat: place.lat, lng: place.lng, zoom: FLY_ZOOM, seq: fr.seq + 1 }))
        setInitialFlyDone(true)
      }
    }
  }, [searchParams, initialFlyDone, buildings])

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
    const bySection = Object.fromEntries(SECTIONS.map(s => [s.key, []]))
    for (const b of filteredBuildings) {
      if (bySection[b.section]) {
        bySection[b.section].push(b)
      } else {
        bySection['other'].push(b)
      }
    }
    return SECTIONS.map(s => ({ ...s, items: bySection[s.key] }))
  }, [filteredBuildings])

  const selectedBuilding = buildings.find(b => b.id === selectedId) ?? null

  const geoJsonStyle = (feature) => {
    const props = feature.properties || {}
    const featureAbbr = props.PU_ABBR || ''
    const isSelected = selectedBuilding && selectedBuilding.abbr === featureAbbr
    
    return {
      color: isSelected ? '#FFD700' : '#E8C878',
      weight: isSelected ? 3 : 1.5,
      fillOpacity: isSelected ? 0.5 : 0.25,
      fillColor: isSelected ? '#FFD700' : '#C9A227',
      opacity: 1,
    }
  }

  const onEachFeature = (feature, layer) => {
    const props = feature.properties || {}
    const name = props.BUILDING_NAME || 'Building'
    const code = props.BuildingLabels || props.PU_ABBR || ''
    const address = props.add_full || ''
    
    const popupContent = `
      <div style="color:#F5F4F1;min-width:180px;">
        <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${name}</div>
        ${code ? `<div style="font-size:12px;color:#A9A6A0;margin-bottom:2px;">Code: <strong style="color:#E8C878;">${code}</strong></div>` : ''}
        ${address ? `<div style="font-size:11px;color:#8F8B84;">${address}</div>` : ''}
      </div>
    `
    layer.bindPopup(popupContent)
    
    layer.on('click', () => {
      const featureAbbr = props.PU_ABBR || ''
      // Find the building with this abbr
      const bldg = buildings.find(b => b.abbr === featureAbbr)
      if (bldg) {
        setSelectedId(bldg.id)
      }
    })
  }

  // Close sidebar when a building is selected on mobile
  const handleBuildingSelect = (b) => {
    setSelectedId(b.id)
    setFlyRequest(fr => ({ lat: b.lat, lng: b.lng, zoom: FLY_ZOOM, seq: fr.seq + 1 }))
    setSidebarOpen(false) // Close on mobile after selection
  }

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-[320px_1fr] h-[calc(100dvh-3.5rem)] overflow-hidden bg-[var(--color-bg-1)]">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col z-10 border-r border-[var(--color-border-2)] bg-[var(--color-surface)] shadow-md min-h-0">
        <div className="p-4 border-b border-[var(--color-border)] space-y-3 shrink-0">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold">Campus Map</h1>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search buildings..."
            className="w-full px-3 py-2.5 rounded-xl text-sm bg-[var(--color-bg-2)] border border-[var(--color-border-2)] outline-none focus:border-[var(--color-gold)] transition-colors"
          />
          {loading && (
            <div className="text-xs text-[var(--color-txt-2)]">Loading buildings...</div>
          )}
          {error && (
            <div className="text-xs text-[var(--color-error)]">Error: {error}</div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-6">
          {grouped.map((section) => section.items.length > 0 && (
            <div key={section.key} className="mt-4 first:mt-2">
              <div className="flex items-center gap-2 px-2 pb-2 border-b border-[var(--color-border)] mb-1">
                <span className="text-[var(--color-gold-muted)]"><Icon name={section.icon} size={16} /></span>
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-txt-2)] m-0">
                  {section.label} ({section.items.length})
                </h2>
              </div>
              <ul className="list-none m-0 p-0">
                {section.items.map((b) => (
                  <li key={b.id}>
                    <button
                      onClick={() => handleBuildingSelect(b)}
                      className={`w-full text-left px-3 py-2.5 rounded-xl transition-all flex gap-3 ${
                        selectedId === b.id
                          ? 'bg-[var(--color-gold)]/15 ring-1 ring-[var(--color-gold)]'
                          : 'hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      <span className="text-[var(--color-txt-3)] mt-0.5 shrink-0">
                        <Icon name="mapPin" size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium leading-tight">
                          {b.name}
                        </span>
                        {b.displayCode && (
                          <span className="inline-block mt-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-gold)]/20 text-[var(--color-gold)]">
                            {b.displayCode}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      {/* Map Container */}
      <div className="relative flex-1 p-2 lg:p-3 bg-[var(--color-bg-2)] min-h-0">
        <div className="h-full w-full rounded-2xl overflow-hidden border shadow-lg dark-purdue-map border-[#2A1E0A]">
          <MapContainer center={CAMPUS_CENTER} zoom={DEFAULT_ZOOM} className="h-full w-full">
            <TileLayer url={TILE_DARK} />
            
            {geoData && (
              <GeoJSON
                key={`geojson-${selectedId}`}
                data={geoData}
                style={geoJsonStyle}
                onEachFeature={onEachFeature}
              />
            )}
            
            <BuildingLabels buildings={buildings} dark selectedId={selectedId} />
            <MapController flyRequest={flyRequest} />
            
            {/* User location marker */}
            {userLocation && (
              <>
                <CircleMarker
                  center={[userLocation.lat, userLocation.lng]}
                  radius={20}
                  pathOptions={{
                    fillColor: '#3b82f6',
                    fillOpacity: 0.15,
                    color: '#3b82f6',
                    weight: 2,
                    opacity: 0.4,
                  }}
                />
                <CircleMarker
                  center={[userLocation.lat, userLocation.lng]}
                  radius={8}
                  pathOptions={{
                    fillColor: '#3b82f6',
                    fillOpacity: 1,
                    color: '#ffffff',
                    weight: 3,
                  }}
                />
              </>
            )}
          </MapContainer>
        </div>
        
        {/* Mobile: Search FAB */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="lg:hidden absolute top-4 left-4 w-12 h-12 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg flex items-center justify-center text-[var(--color-txt-1)] z-[1000]"
          aria-label="Search buildings"
        >
          <Icon name="search" size={20} />
        </button>
        
        {/* Locate Me Button */}
        <button
          type="button"
          onClick={locateUser}
          disabled={locationLoading}
          className={`absolute top-4 right-4 w-11 h-11 rounded-xl shadow-lg z-[1000] flex items-center justify-center transition-all border-2 ${
            userLocation
              ? 'bg-blue-500 text-white border-blue-400'
              : 'bg-white dark:bg-[var(--color-surface)] border-[var(--color-border)] text-gray-700 dark:text-[var(--color-txt-1)] hover:text-blue-500 hover:border-blue-400'
          } ${locationLoading ? 'animate-pulse' : ''}`}
          title={locationError || 'Show my location'}
          aria-label="Show my location"
        >
          <Icon name="locateMe" size={22} />
        </button>
        
        {/* Selected building info card */}
        {selectedBuilding && (
          <div className="absolute bottom-4 left-4 right-4 lg:left-auto lg:right-6 lg:bottom-6 lg:w-80 bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-lg p-4 animate-fade-in-up z-[1000]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-[var(--color-txt-0)] text-[15px]">{selectedBuilding.name}</h3>
                {selectedBuilding.displayCode && (
                  <span className="inline-block mt-1.5 text-[11px] font-bold px-2 py-0.5 rounded bg-[var(--color-gold)] text-[var(--color-gold-dark)]">
                    {selectedBuilding.displayCode}
                  </span>
                )}
                {selectedBuilding.address && (
                  <p className="text-[12px] text-[var(--color-txt-2)] mt-2 leading-relaxed">{selectedBuilding.address}</p>
                )}
              </div>
              <button 
                onClick={() => setSelectedId(null)}
                className="p-2 rounded-lg hover:bg-[var(--color-bg-2)] text-[var(--color-txt-2)] shrink-0"
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
      <div className={`lg:hidden fixed bottom-0 left-0 right-0 bg-[var(--color-surface)] rounded-t-2xl shadow-xl z-[1002] transition-transform duration-300 ${
        sidebarOpen ? 'translate-y-0' : 'translate-y-full'
      }`} style={{ maxHeight: '75vh' }}>
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-[var(--color-border-2)] rounded-full" />
        </div>
        
        {/* Search Header */}
        <div className="px-4 pb-3 border-b border-[var(--color-border)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[16px] font-semibold text-[var(--color-txt-0)]">Find Building</h2>
            <button 
              onClick={() => setSidebarOpen(false)}
              className="p-2 rounded-lg hover:bg-[var(--color-bg-2)] text-[var(--color-txt-2)]"
            >
              <Icon name="close" size={20} />
            </button>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search buildings..."
            className="w-full px-4 py-3 rounded-xl text-[15px] bg-[var(--color-bg-2)] border border-[var(--color-border-2)] outline-none focus:border-[var(--color-gold)] transition-colors"
            autoFocus={sidebarOpen}
          />
        </div>
        
        {/* Building List */}
        <div className="overflow-y-auto px-2 pb-8" style={{ maxHeight: 'calc(75vh - 120px)' }}>
          {grouped.map((section) => section.items.length > 0 && (
            <div key={section.key} className="mt-4 first:mt-2">
              <div className="flex items-center gap-2 px-2 pb-2 border-b border-[var(--color-border)] mb-1">
                <span className="text-[var(--color-gold-muted)]"><Icon name={section.icon} size={16} /></span>
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-txt-2)] m-0">
                  {section.label} ({section.items.length})
                </h3>
              </div>
              <ul className="list-none m-0 p-0">
                {section.items.map((b) => (
                  <li key={b.id}>
                    <button
                      onClick={() => handleBuildingSelect(b)}
                      className={`w-full text-left px-4 py-3.5 rounded-xl transition-all flex gap-3 active:scale-[0.98] ${
                        selectedId === b.id
                          ? 'bg-[var(--color-gold)]/15 ring-1 ring-[var(--color-gold)]'
                          : 'hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-bg-2)]'
                      }`}
                    >
                      <span className="text-[var(--color-txt-3)] mt-0.5 shrink-0">
                        <Icon name="mapPin" size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-medium leading-tight">
                          {b.name}
                        </span>
                        {b.displayCode && (
                          <span className="inline-block mt-1.5 text-[11px] font-bold px-2 py-0.5 rounded bg-[var(--color-gold)]/20 text-[var(--color-gold)]">
                            {b.displayCode}
                          </span>
                        )}
                      </span>
                      <Icon name="arrowUpRight" size={16} className="text-[var(--color-txt-3)] shrink-0 mt-0.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
