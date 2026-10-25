import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import ParkingGarageLayer from './ParkingGarageLayer'
import type { Garage } from '../../lib/parking'

// Issue #366: the campus map is open to signed-out visitors, and /parking is
// not, so a garage popup links to it for a signed-in student only. The pins
// and the directions are for everyone.

type AuthState = { loading: boolean; user: null | { id: string } }
const auth = vi.hoisted(() => ({ value: { loading: false, user: null } as AuthState }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth.value }))

const GARAGE: Garage = {
  id: 'vermont',
  name: 'Vermont Street Garage',
  sourceName: 'Vermont Street Garage',
  code: 'VSG',
  address: '1001 W Vermont St',
  type: 'garage',
  stRule: null,
  lat: 39.7717,
  lng: -86.1741,
  capacity: 1200,
  occupied: 900,
  available: 300,
  percentFull: 75,
  status: 'open',
  icon: null,
  updatedAt: new Date().toISOString(),
  stale: false,
}
vi.mock('../../lib/queries/publicData', () => ({ useParking: () => ({ data: { garages: [GARAGE] } }) }))

// The Leaflet layers need a real map; here each one just renders what it holds.
vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children }: { children?: ReactNode }) => <div data-testid="garage-pin">{children}</div>,
  Popup: ({ children }: { children?: ReactNode }) => <div data-testid="garage-popup">{children}</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

function renderLayer() {
  render(
    <MemoryRouter useTransitions={false}>
      <ParkingGarageLayer visible />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  auth.value = { loading: false, user: null }
})

afterEach(cleanup)

describe('the garage popup', () => {
  test('signed out: the pin, its count and directions, and no link to the parking page', () => {
    renderLayer()
    expect(screen.getByTestId('garage-pin')).toHaveTextContent('300')
    expect(screen.getByText('Vermont Street Garage')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Directions' })).toHaveAttribute('target', '_blank')
    expect(screen.queryByRole('link', { name: 'All garages' })).toBeNull()
  })

  test('while auth loads: no link yet', () => {
    auth.value = { loading: true, user: { id: 'user-1' } }
    renderLayer()
    expect(screen.queryByRole('link', { name: 'All garages' })).toBeNull()
  })

  test('signed in: the link to the parking page', () => {
    auth.value = { loading: false, user: { id: 'user-1' } }
    renderLayer()
    expect(screen.getByRole('link', { name: 'All garages' })).toHaveAttribute('href', '/parking')
  })
})
