// Campus buildings for the Map page's list and labels, from the ArcGIS
// Indianapolis_Building_Shapes layer (issue #374). The layer returns one
// feature per footprint, so a building drawn as several shapes (the track and
// soccer stadium is six) used to be listed once per shape. Features now group
// into one building each; the map layer still draws every shape from the raw
// GeoJSON. Pure, so it can be tested.

/** [[south, west], [north, east]], the shape Leaflet's fitBounds takes. */
export type LatLngBounds = [[number, number], [number, number]]

export type Building = {
  /** The group key from buildingKey. */
  id: string
  abbr: string
  displayCode: string
  name: string
  fullName: string
  address: string
  section: string
  /** Label position: the average of the shapes' centroids. */
  lat: number
  lng: number
  /** Covers every shape, for fitting the map to the whole building. */
  bounds: LatLngBounds
  shapeCount: number
}

type BuildingProps = {
  BUILDING_NAME?: string | null
  PU_ABBR?: string | null
  BuildingLabels?: string | null
  add_full?: string | null
}

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * Which building a feature belongs to: its PU_ABBR, or its BUILDING_NAME when
 * the abbreviation is blank (30 of the layer's 45 features have none, the
 * stadium's six among them), or its map label as a last resort. Null for a
 * feature with none of the three. The map layer's click and highlight use the
 * same key, so a list entry, its label and all of its shapes stay linked.
 */
export function buildingKey(props: BuildingProps | null | undefined): string | null {
  const abbr = clean(props?.PU_ABBR)
  if (abbr) return `abbr:${abbr.toUpperCase()}`
  const name = clean(props?.BUILDING_NAME)
  if (name) return `name:${name.toUpperCase()}`
  const label = clean(props?.BuildingLabels)
  if (label) return `label:${label.toUpperCase()}`
  return null
}

// Categorize buildings by their abbreviation or name
function categorizeBuilding(abbr: string | undefined, name: string | undefined) {
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
function getPolygonCentroid(coordinates: any): [number, number] | null {
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

type Group = {
  props: BuildingProps[]
  centroids: [number, number][]
  south: number
  west: number
  north: number
  east: number
}

/** One Building per buildingKey, sorted by name. Only Polygon shapes count. */
export function buildingsFromGeoJson(geoData: any): Building[] {
  if (!geoData?.features) return []

  const groups = new Map<string, Group>()
  for (const feature of geoData.features) {
    const props: BuildingProps = feature?.properties || {}
    const key = buildingKey(props)
    if (!key) continue

    const geometry = feature.geometry
    if (!geometry || geometry.type !== 'Polygon') continue

    const centroid = getPolygonCentroid(geometry.coordinates)
    if (!centroid) continue

    let group = groups.get(key)
    if (!group) {
      group = { props: [], centroids: [], south: Infinity, west: Infinity, north: -Infinity, east: -Infinity }
      groups.set(key, group)
    }
    group.props.push(props)
    group.centroids.push(centroid)
    // The outer ring bounds the shape; inner rings are holes inside it.
    for (const coord of geometry.coordinates[0] || []) {
      if (!Array.isArray(coord) || coord.length < 2) continue
      const [lng, lat] = coord
      group.south = Math.min(group.south, lat)
      group.north = Math.max(group.north, lat)
      group.west = Math.min(group.west, lng)
      group.east = Math.max(group.east, lng)
    }
  }

  const buildings: Building[] = []
  for (const [key, group] of groups) {
    // Shapes of one building can leave a field blank, so take the first one set.
    const first = (field: keyof BuildingProps) => group.props.map((p) => clean(p[field])).find(Boolean) || ''
    const name = first('BUILDING_NAME')
    const abbr = first('PU_ABBR') || first('BuildingLabels')
    // BuildingLabels is the display code (it's what shows on the official map)
    const displayCode = first('BuildingLabels') || abbr
    const n = group.centroids.length
    buildings.push({
      id: key,
      abbr,
      displayCode,
      name,
      fullName: displayCode ? `${name} (${displayCode})` : name,
      address: first('add_full'),
      section: categorizeBuilding(abbr, name),
      lat: group.centroids.reduce((sum, c) => sum + c[0], 0) / n,
      lng: group.centroids.reduce((sum, c) => sum + c[1], 0) / n,
      bounds: [
        [group.south, group.west],
        [group.north, group.east],
      ],
      shapeCount: n,
    })
  }

  return buildings.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The building a deep link (?building= or the code in ?room=) names, matched
 * on its abbreviation or its display code, ignoring case.
 */
export function findBuildingByCode(buildings: Building[], code: string): Building | null {
  const upper = code.trim().toUpperCase()
  if (!upper) return null
  return buildings.find((b) => b.abbr.toUpperCase() === upper || b.displayCode.toUpperCase() === upper) ?? null
}
