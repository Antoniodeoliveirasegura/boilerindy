import { test, expect } from './fixtures/mock-backend.js'

// Issue #374 - the ArcGIS building layer returns one feature per footprint, so
// the track and soccer stadium (six shapes on the live layer) was listed once
// per shape. Its shapes carry no PU_ABBR, so the old highlight, keyed on
// PU_ABBR alone, never lit them either. The layer is served from a fixture
// shaped like the live one: two stadium shapes and one other building.

const square = (lng, lat, size = 0.001) => ({
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

const STADIUM = 'TRACK & SOCCER STADIUM (MICHAEL CARROLL)'
const stadiumShape = (lng, lat) => ({
  type: 'Feature',
  properties: { BUILDING_NAME: STADIUM, PU_ABBR: null, BuildingLabels: 'TF', add_full: '1001 W NEW YORK ST' },
  geometry: square(lng, lat),
})

const buildingShapes = {
  type: 'FeatureCollection',
  features: [
    stadiumShape(-86.1790, 39.7703),
    stadiumShape(-86.1777, 39.7706),
    {
      type: 'Feature',
      properties: { BUILDING_NAME: 'Engineering and Technology', PU_ABBR: 'ETPI', BuildingLabels: 'ET', add_full: '799 W MICHIGAN ST' },
      geometry: square(-86.1745, 39.7745),
    },
  ],
}

// Leaflet draws each shape as an SVG path; a selected one gets a 3px gold stroke.
const highlightedShapes = (page) => page.locator('path.leaflet-interactive[stroke="#FFD700"]')

test.describe('Campus map', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    mockApi.login()
    await page.route(/Indianapolis_Building_Shapes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildingShapes) }),
    )
    // Keep the Esri basemap offline.
    await page.route(/server\.arcgisonline\.com/, (route) => route.abort())
  })

  test('a building drawn as several shapes is listed once and a deep link selects all of it', async ({ page }) => {
    await page.goto('/map?building=TF')

    const list = page.locator('aside')
    await expect(list.getByRole('button', { name: /Engineering and Technology/ })).toBeVisible()
    await expect(list.getByRole('button', { name: new RegExp(STADIUM.replace(/[()&]/g, '\\$&')) })).toHaveCount(1)

    // The deep link opened the merged entry, and both of its shapes are lit.
    await expect(page.getByRole('heading', { level: 3, name: STADIUM })).toBeVisible()
    await expect(highlightedShapes(page)).toHaveCount(2)

    // Picking another building moves the highlight to its one shape.
    await list.getByRole('button', { name: /Engineering and Technology/ }).click()
    await expect(page.getByRole('heading', { level: 3, name: 'Engineering and Technology' })).toBeVisible()
    await expect(highlightedShapes(page)).toHaveCount(1)
  })
})
