import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import Map from './Map'

// Two phone-layout bugs on the campus map:
// - The loading and error lines lived only in the desktop sidebar, which is
//   hidden below lg. When the building layer failed, a phone showed no
//   message anywhere, a room link selected nothing, and a search came back
//   blank.
// - The closed search sheet only slid off screen, so its controls stayed in
//   the Tab order, and Escape did not close the open one.

vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))
vi.mock('../components/map/ParkingGarageLayer', () => ({ default: () => null }))
// The Leaflet map itself needs a real layout; only the page around it is
// under test here.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children?: ReactNode }) => <div data-testid="leaflet-map">{children}</div>,
  TileLayer: () => null,
  GeoJSON: () => null,
  Marker: () => null,
  CircleMarker: () => null,
  ZoomControl: () => null,
  useMap: () => ({ flyTo: () => {}, flyToBounds: () => {} }),
}))

const square = (lng: number, lat: number) => ({
  type: 'Polygon',
  coordinates: [[[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]],
})
const BUILDINGS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { BUILDING_NAME: 'Science Building', PU_ABBR: 'SL', BuildingLabels: 'SL' }, geometry: square(-86.176, 39.774) },
    { type: 'Feature', properties: { BUILDING_NAME: 'University Library', PU_ABBR: 'UL', BuildingLabels: 'UL' }, geometry: square(-86.178, 39.773) },
  ],
}

function answerBuildings(response: { ok: boolean; json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn(async () => response))
}

function renderMap(entry = '/map') {
  return render(
    <MemoryRouter initialEntries={[entry]} useTransitions={false}>
      <Map />
    </MemoryRouter>,
  )
}

const searchButton = () => screen.getByRole('button', { name: 'Search buildings' })
const sheet = () => screen.getByRole('heading', { name: 'Find Building' }).closest('.r-map') as HTMLElement

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Map when the building layer fails to load', () => {
  test('says so on the map and in the phone sheet, not only in the desktop sidebar', async () => {
    answerBuildings({ ok: false })
    renderMap('/map?room=SL%20008')

    expect(await screen.findByRole('alert')).toHaveTextContent('Buildings could not load')
    expect(within(sheet()).getByText('Error: Failed to fetch building data')).toBeInTheDocument()

    fireEvent.click(searchButton())
    fireEvent.change(within(sheet()).getByPlaceholderText('Search buildings...'), { target: { value: 'science' } })
    // An empty list here is the failure above, not a search with no match.
    expect(within(sheet()).queryByText(/No buildings match/)).toBeNull()
  })

  test('the phone sheet shows the loading line while the layer loads', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderMap()
    expect(within(sheet()).getByText('Loading buildings...')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('Map building search', () => {
  test('a search that matches nothing says so', async () => {
    answerBuildings({ ok: true, json: async () => BUILDINGS })
    renderMap()
    await waitFor(() => expect(within(sheet()).getByRole('button', { name: /Science Building/ })).toBeInTheDocument())

    fireEvent.click(searchButton())
    fireEvent.change(within(sheet()).getByPlaceholderText('Search buildings...'), { target: { value: 'gym' } })
    expect(within(sheet()).getByText('No buildings match “gym”.')).toBeInTheDocument()
  })
})

describe('Map phone search sheet', () => {
  beforeEach(() => answerBuildings({ ok: true, json: async () => BUILDINGS }))

  test('is inert while closed, and opening it moves focus to its search box', async () => {
    renderMap()
    expect(sheet()).toHaveAttribute('inert')

    fireEvent.click(searchButton())
    expect(sheet()).not.toHaveAttribute('inert')
    await waitFor(() => expect(within(sheet()).getByPlaceholderText('Search buildings...')).toHaveFocus())
  })

  test('Escape closes it and returns focus to the search button', async () => {
    renderMap()
    fireEvent.click(searchButton())
    const input = within(sheet()).getByPlaceholderText('Search buildings...')
    await waitFor(() => expect(input).toHaveFocus())

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(sheet()).toHaveAttribute('inert')
    expect(searchButton()).toHaveFocus()
  })

  test('picking a building closes it and hands focus back to the search button', async () => {
    renderMap()
    fireEvent.click(searchButton())
    const building = await within(sheet()).findByRole('button', { name: /University Library/ })
    building.focus()

    fireEvent.click(building)
    expect(sheet()).toHaveAttribute('inert')
    expect(searchButton()).toHaveFocus()
  })
})
