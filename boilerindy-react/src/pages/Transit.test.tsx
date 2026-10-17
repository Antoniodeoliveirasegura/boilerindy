import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
// The vehicles read, swapped per test for a failed one.
const feed = vi.hoisted(() => ({ vehicles: null as unknown }))
vi.mock('../lib/queries/publicData', async (importOriginal) => ({
  errorMessage: (await importOriginal<typeof import('../lib/queries/publicData')>()).errorMessage,
  useTransitVehicles: () => feed.vehicles ?? settled(VEHICLES),
  useTransitStops: () => settled(STOPS),
  useTransitRoutes: () => settled(ROUTES),
}))

// A stand-in Leaflet that only tracks which markers are on the map.
const leaflet = vi.hoisted(() => {
  const onMap = new Set<{ icon?: { className?: string } }>()
  // The options of every fitBounds call, and the map's size in pixels.
  const fits: unknown[] = []
  const size = { x: 0, y: 0 }
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
      const map = {
        setView: () => map,
        fitBounds: (_bounds: unknown, options: unknown) => {
          fits.push(options)
          return map
        },
        getSize: () => size,
        remove: () => {},
      }
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
  return { fake, onMap, fits, size }
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
    <MemoryRouter initialEntries={[entry]} useTransitions={false}>
      {preview && <PreviewBar />}
      <Transit />
      <Where />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  auth.value = { loading: false, user: { id: 'user-1' } }
  feed.vehicles = null
  localStorage.clear()
  leaflet.onMap.clear()
  leaflet.fits.length = 0
  Object.assign(leaflet.size, { x: 0, y: 0 })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
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

// The vehicles read was only checked for isPending. A feed that failed (502)
// or was rate limited (429) with nothing cached left an empty list, so the
// page claimed "All Routes (0)" and "Not in service" and a visitor read it as
// the shuttles not running.
describe('Transit when the vehicles read fails', () => {
  test('says live positions are unavailable, not that no bus runs, and retries', () => {
    const refetch = vi.fn()
    feed.vehicles = {
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error('Too many transit requests. Please slow down.'),
      dataUpdatedAt: 0,
      refetch,
    }
    renderAt('/transit')

    expect(screen.getByRole('alert')).toHaveTextContent('Live positions unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent('Too many transit requests. Please slow down.')
    expect(screen.queryByText('No buses currently active')).toBeNull()
    expect(screen.getByRole('button', { name: 'All Routes' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalled()
  })

  // During an outage TanStack resets a read with no data to pending, with no
  // error, at the start of every 10 s retry. The page took that for a first
  // load: the notice gave way to the loading screen and came back, so it was
  // announced again and focus on Try again was lost on every poll.
  test('keeps the same notice, and focus on Try again, while the failed feed retries', () => {
    const error = new Error('Transit data is temporarily unavailable.')
    feed.vehicles = { data: undefined, isPending: false, isError: true, error, errorUpdatedAt: 1000, errorUpdateCount: 1, dataUpdatedAt: 0, refetch: vi.fn() }
    // A new element each time, so React renders the page again on rerender.
    const tree = () => (
      <MemoryRouter initialEntries={['/transit']} useTransitions={false}>
        <Transit />
      </MemoryRouter>
    )
    const { rerender } = render(tree())
    const alert = screen.getByRole('alert')
    const retry = screen.getByRole('button', { name: 'Try again' })
    retry.focus()

    feed.vehicles = { data: undefined, isPending: true, isError: false, error: null, errorUpdatedAt: 1000, errorUpdateCount: 1, dataUpdatedAt: 0, refetch: vi.fn() }
    rerender(tree())

    expect(screen.queryByText('Loading transit data...')).toBeNull()
    expect(screen.getByRole('alert')).toBe(alert)
    expect(screen.getByRole('alert')).toHaveTextContent('Transit data is temporarily unavailable.')
    expect(document.activeElement).toBe(retry)
    expect(screen.getByRole('button', { name: 'All Routes' })).toBeInTheDocument()
  })

  test('says it is already retrying instead of offering a press that would only wait', () => {
    const refetch = vi.fn()
    feed.vehicles = { data: undefined, isPending: true, isFetching: true, isError: false, error: null, errorUpdatedAt: 1000, errorUpdateCount: 1, dataUpdatedAt: 0, refetch }
    renderAt('/transit')
    const button = within(screen.getByRole('alert')).getByRole('button', { name: 'Retrying...' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    expect(refetch).not.toHaveBeenCalled()
  })

  test('an answer with no buses still reads as not in service', () => {
    feed.vehicles = settled([])
    renderAt('/transit')

    expect(screen.getByText('No buses currently active')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'All Routes (0)' })).toBeInTheDocument()
  })
})

// The legend covers the map's top left corner, and on phones it is larger
// than the 50px fitBounds left, so the north-west bus sat under it.
describe('Transit fits the buses clear of the legend', () => {
  function legendSize(left: number, top: number, width: number, height: number) {
    const on = (el: HTMLElement, value: number) => (el.classList.contains('ink-panel') ? value : 0)
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) { return on(this, left) })
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { return on(this, top) })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return on(this, width) })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return on(this, height) })
  }

  test('below the legend on a tall phone map', async () => {
    Object.assign(leaflet.size, { x: 288, y: 340 })
    legendSize(13, 13, 120, 83)
    renderAt('/transit')

    await waitFor(() => expect(leaflet.fits.length).toBeGreaterThan(0))
    expect(leaflet.fits.at(-1)).toEqual({ paddingTopLeft: [50, 116], paddingBottomRight: [50, 50], maxZoom: 16 })
  })

  test('beside the legend on a wide desktop map', async () => {
    Object.assign(leaflet.size, { x: 1150, y: 460 })
    legendSize(13, 13, 150, 110)
    renderAt('/transit')

    await waitFor(() => expect(leaflet.fits.length).toBeGreaterThan(0))
    expect(leaflet.fits.at(-1)).toEqual({ paddingTopLeft: [183, 50], paddingBottomRight: [50, 50], maxZoom: 16 })
  })
})

// Off duty, the whole route square faded to 40%, number included, and on
// phones that number is the pill's only visible text: 1.7 to 3.0:1.
describe('Transit off-duty route pills', () => {
  test('fade only the square fill, keep the number at full strength and announce the note', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Noon on Saturday 2026-10-17 in Indianapolis: Yellow (Mon-Fri) is off duty.
    vi.setSystemTime(new Date('2026-10-17T12:00:00-04:00'))
    renderAt('/transit')

    const yellow = screen.getByRole('button', { name: /Yellow/ })
    expect(yellow.className).not.toMatch(/opacity/)
    const fill = yellow.querySelector('.opacity-35')
    expect(fill).not.toBeNull()
    const number = within(yellow).getAllByText('3')[0]
    expect(fill!.contains(number)).toBe(false)
    expect(number.closest('[class*="opacity"]')).toBeNull()
    expect(within(yellow).getByText('not running now')).toHaveClass('sr-only', 'sm:not-sr-only')

    const crimson = screen.getByRole('button', { name: /Crimson/ })
    expect(crimson.querySelector('.opacity-35')).toBeNull()
  })
})
