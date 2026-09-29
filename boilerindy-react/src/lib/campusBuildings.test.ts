import { describe, expect, test } from 'vitest'
import { buildingKey, buildingsFromGeoJson, findBuildingByCode } from './campusBuildings'

// Issue #374 - the ArcGIS building layer returns one feature per footprint, and
// the track and soccer stadium is six of them, so the map listed it six times.
// Features now group into one building each. The shapes below mirror the live
// layer: the stadium's features have no PU_ABBR, share a BUILDING_NAME and all
// carry the label TF.

const square = (lng: number, lat: number, size = 0.001) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng, lat],
      [lng + size, lat],
      [lng + size, lat + size],
      [lng, lat + size],
      [lng, lat],
    ],
  ],
})

const stadium = (lng: number, lat: number, extra: Record<string, unknown> = {}) => ({
  type: 'Feature',
  properties: {
    BUILDING_NAME: 'TRACK & SOCCER STADIUM (MICHAEL CARROLL)',
    PU_ABBR: null,
    BuildingLabels: 'TF',
    add_full: '1001 W NEW YORK ST',
    ...extra,
  },
  geometry: square(lng, lat),
})

const et = {
  type: 'Feature',
  properties: { BUILDING_NAME: 'Engineering and Technology', PU_ABBR: 'ETPI', BuildingLabels: 'ET', add_full: '799 W MICHIGAN ST' },
  geometry: square(-86.1745, 39.7745),
}

const layer = (...features: unknown[]) => ({ type: 'FeatureCollection', features })

describe('buildingKey', () => {
  test('PU_ABBR wins, then BUILDING_NAME, then the map label, case and spacing ignored', () => {
    expect(buildingKey({ PU_ABBR: ' etpi ', BUILDING_NAME: 'Engineering and Technology' })).toBe('abbr:ETPI')
    expect(buildingKey({ PU_ABBR: null, BUILDING_NAME: 'Cavanaugh Hall', BuildingLabels: 'CA' })).toBe('name:CAVANAUGH HALL')
    expect(buildingKey({ PU_ABBR: '  ', BUILDING_NAME: 'CAVANAUGH HALL ' })).toBe('name:CAVANAUGH HALL')
    expect(buildingKey({ PU_ABBR: null, BUILDING_NAME: null, BuildingLabels: '501I' })).toBe('label:501I')
  })

  test('is null for a feature with nothing to name it by', () => {
    expect(buildingKey({ PU_ABBR: null, BUILDING_NAME: null, BuildingLabels: null })).toBeNull()
    expect(buildingKey({})).toBeNull()
    expect(buildingKey(null)).toBeNull()
  })
})

describe('buildingsFromGeoJson', () => {
  test('two shapes with the same name become one building with both shapes', () => {
    const buildings = buildingsFromGeoJson(layer(stadium(-86.18, 39.77), stadium(-86.178, 39.771), et))
    expect(buildings.map((b) => b.name)).toEqual(['Engineering and Technology', 'TRACK & SOCCER STADIUM (MICHAEL CARROLL)'])

    const merged = buildings[1]
    expect(merged.id).toBe('name:TRACK & SOCCER STADIUM (MICHAEL CARROLL)')
    expect(merged.shapeCount).toBe(2)
    expect(merged.displayCode).toBe('TF')
    expect(merged.abbr).toBe('TF')
    expect(merged.address).toBe('1001 W NEW YORK ST')
    // Bounds cover both squares, as [[south, west], [north, east]].
    const [[south, west], [north, east]] = merged.bounds
    expect(south).toBeCloseTo(39.77)
    expect(west).toBeCloseTo(-86.18)
    expect(north).toBeCloseTo(39.772)
    expect(east).toBeCloseTo(-86.177)
    // The label sits between the two shapes' centroids.
    expect(merged.lat).toBeCloseTo((39.7704 + 39.7714) / 2, 4)
    expect(merged.lng).toBeCloseTo((-86.1796 - 86.1776) / 2, 4)
  })

  test('a single-shape building keeps its own centroid and bounds', () => {
    const [building] = buildingsFromGeoJson(layer(et))
    expect(building.id).toBe('abbr:ETPI')
    expect(building.shapeCount).toBe(1)
    expect(building.abbr).toBe('ETPI')
    expect(building.displayCode).toBe('ET')
    expect(building.section).toBe('academic')
    // Vertex average of the closed ring, as before the grouping.
    expect(building.lat).toBeCloseTo(39.7745 + 0.0004, 6)
    expect(building.lng).toBeCloseTo(-86.1745 + 0.0004, 6)
    const [[south, west], [north, east]] = building.bounds
    expect(south).toBeCloseTo(39.7745, 6)
    expect(west).toBeCloseTo(-86.1745, 6)
    expect(north).toBeCloseTo(39.7755, 6)
    expect(east).toBeCloseTo(-86.1735, 6)
  })

  test('a field blank on the first shape is taken from a later one', () => {
    const [building] = buildingsFromGeoJson(layer(stadium(-86.18, 39.77, { add_full: '' }), stadium(-86.178, 39.771)))
    expect(building.address).toBe('1001 W NEW YORK ST')
  })

  test('skips features with no name, abbreviation or label, and non-polygons', () => {
    const unnamed = { type: 'Feature', properties: { BUILDING_NAME: null, PU_ABBR: null, BuildingLabels: null }, geometry: square(-86.17, 39.77) }
    const point = { type: 'Feature', properties: { BUILDING_NAME: 'Bus Stop' }, geometry: { type: 'Point', coordinates: [-86.17, 39.77] } }
    expect(buildingsFromGeoJson(layer(unnamed, point, et)).map((b) => b.id)).toEqual(['abbr:ETPI'])
    expect(buildingsFromGeoJson(null)).toEqual([])
    expect(buildingsFromGeoJson({})).toEqual([])
  })
})

describe('findBuildingByCode', () => {
  const buildings = buildingsFromGeoJson(layer(stadium(-86.18, 39.77), stadium(-86.178, 39.771), et))

  test('a deep-link code resolves to the merged building, by label or abbreviation, any case', () => {
    expect(findBuildingByCode(buildings, 'tf')?.id).toBe('name:TRACK & SOCCER STADIUM (MICHAEL CARROLL)')
    expect(findBuildingByCode(buildings, 'ET')?.id).toBe('abbr:ETPI')
    expect(findBuildingByCode(buildings, 'etpi')?.id).toBe('abbr:ETPI')
  })

  test('returns null for an unknown or empty code', () => {
    expect(findBuildingByCode(buildings, 'ZZ')).toBeNull()
    expect(findBuildingByCode(buildings, '')).toBeNull()
  })
})
