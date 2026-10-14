import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom'
import Transit from './Transit'
import PreviewBar from '../components/PreviewBar'

// Two navigation bugs on the live map page:
// - The bus markers waited only on the vehicles, not on the map, which is
//   created a microtask after mount. With the feed already loaded (and a poll
//   that returns the same feed keeping the same array), no bus was drawn
//   until one moved.
// - The selected route was component state, so leaving and coming Back
//   reopened All Routes and the saved "my stop" alert was no longer armed.
//   It is now ?route= in the URL.

vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))

type AuthState = { loading: boolean; user: null | { id: string } }
const auth = vi.hoisted(() => ({ value: { loading: false, user: { id: 'user-1' } } as AuthState }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.value }))

// The feed through the query cache. The arrays are module constants so every
// render (and every "poll") hands back the same reference, as TanStack's
// structural sharing does when the feed has not changed.
const VEHICLES = [
  { VehicleID: 1, RouteID: 31, Name: '101', Latitude: 39.775, Longitude: -86.176, GroundSpeed: 0 },
  { VehicleID: 2, RouteID: 31, Name: '102', Latitude: 39.776, Longitude: -86.177, GroundSpeed: 0 },
  { VehicleID: 3, RouteID: 27, Name: '201', Latitude: 39.774, Longitude: -86.175, GroundSpeed: 0 },
]
const STOPS = [
  { RouteID: 31, RouteStopID: 1001, Description: 'Campus Center', Latitude: 39.78, Longitude: -86.18 },
  { RouteID: 31, RouteStopID: 1002, Description: 'Science Building', Latitude: 39.79, Longitude: -86.19 },
  { RouteID: 31, RouteStopID: 1003, Description: 'Engineering and Technology', Latitude: 39.8, Longitude: -86.2 },
]
const ROUTES: unknown[] = []
const settled = (data: unknown) => ({ data, isPending: false, dataUpdatedAt: 0, refetch: vi.fn() })
vi.mock('../lib/queries/publicData', () => ({
  useTransitVehicles: () => settled(VEHICLES),
  useTransitStops: () => settled(STOPS),
  useTransitRoutes: () => settled(ROUTES),
}))

// A stand-in Leaflet that only tracks which markers are on the map.
const leaflet = vi.hoisted(() => {
  const onMap = new Set<{ icon?: { className?: string } }>()
  const layer = () => {
    const self = {
      addTo: () => self,
      remove: () => {},
      on: () => self,
      bindPopup: () => self,
      setLatLng: () => self,
      getBounds: () => ({}),
    }
    return self
  }
  const fake = {
    map: () => {
      const map = { setView: () => map, fitBounds: () => map, remove: () => {} }
      return map
    },
    control: { zoom: () => layer() },
    tileLayer: () => layer(),
    polyline: () => layer(),
    latLngBounds: () => ({}),
    divIcon: (options: { className?: string }) => options,
    marker: (_at: unknown, options: { icon?: { className?: string } }) => {
      const marker = {
        ...options,
        addTo: () => {
          onMap.add(marker)
          return marker
        },
        remove: () => {
          onMap.delete(marker)
        },
        on: () => marker,
        bindPopup: () => marker,
        setLatLng: () => marker,
      }
      return marker
    },
  }
  return { fake, onMap }
})
vi.mock('leaflet', () => leaflet.fake)

const busesOnMap = () => [...leaflet.onMap].filter((m) => m.icon?.className === 'custom-bus-marker').length

function Where() {
  const { pathname, search } = useLocation()
  const type = useNavigationType()
  return (
    <p data-testid="where" data-navigation={type}>
      {pathname + search}
    </p>
  )
}

function renderAt(entry: string, { preview = false } = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      {preview && <PreviewBar />}
      <Transit />
      <Where />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  auth.value = { loading: false, user: { id: 'user-1' } }
  localStorage.clear()
  leaflet.onMap.clear()
})

afterEach(() => {
  cleanup()
})

describe('Transit live map', () => {
  test('draws every live bus once the map is ready, with the feed already loaded', async () => {
    renderAt('/transit')
    await waitFor(() => expect(busesOnMap()).toBe(3))
  })
})

describe('Transit selected route in the URL', () => {
  test('opens on ?route= with that route selected and its saved stop alert armed', async () => {
    localStorage.setItem('transit-my-stop-31', JSON.stringify('1003'))
    renderAt('/transit?route=31')

    expect(screen.getByRole('heading', { name: 'Route 1 - Crimson' })).toBeInTheDocument()
    expect(screen.getByText(/Alert when bus reaches:/)).toHaveTextContent('Alert when bus reaches: Science Building')
    await waitFor(() => expect(busesOnMap()).toBe(2))
  })

  test('a pill writes ?route= in place and All Routes takes it out again', () => {
    renderAt('/transit')
    const where = screen.getByTestId('where')

    fireEvent.click(screen.getByRole('button', { name: /Crimson/ }))
    expect(where).toHaveTextContent(/^\/transit\?route=31$/)
    expect(where).toHaveAttribute('data-navigation', 'REPLACE')
    expect(screen.getByRole('heading', { name: 'Route 1 - Crimson' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /All Routes/ }))
    expect(where).toHaveTextContent(/^\/transit$/)
    expect(screen.queryByRole('heading', { name: 'Route 1 - Crimson' })).toBeNull()
  })

  test('an unknown ?route= falls back to All Routes', () => {
    renderAt('/transit?route=999')
    expect(screen.getByRole('button', { name: /All Routes/ }).className).toContain('pill-active')
    expect(screen.queryByRole('heading', { name: /^Route / })).toBeNull()
  })

  test('the signed-out preview keeps the route and carries it through Sign in, with no bell or saved stop', () => {
    auth.value = { loading: false, user: null }
    localStorage.setItem('transit-my-stop-31', JSON.stringify('1003'))
    renderAt('/transit', { preview: true })

    fireEvent.click(screen.getByRole('button', { name: /Crimson/ }))

    expect(screen.getByRole('heading', { name: 'Route 1 - Crimson' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?next=%2Ftransit%3Froute%3D31',
    )
    expect(screen.queryByText(/Alert when bus reaches:/)).toBeNull()
    expect(screen.queryByRole('button', { name: /my stop/i })).toBeNull()
  })
})
