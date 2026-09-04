// Client-side types and pure helpers for live garage availability (issue #14).
// The shapes mirror src/parkingStatus.mjs on the server.

export type GarageStatus = 'open' | 'busy' | 'full' | 'unknown'

export type Garage = {
  id: string
  name: string
  sourceName: string | null
  code: string | null
  address: string | null
  type: string | null
  stRule: string | null
  lat: number | null
  lng: number | null
  capacity: number | null
  occupied: number | null
  available: number | null
  percentFull: number | null
  status: GarageStatus
  icon: string | null
  updatedAt: string | null
  stale: boolean
}

export type PermitInfo = {
  reviewedOn: string
  permits: { code: string; name: string; eligibility: string; valid: string; afterHours: string }[]
  links: { label: string; href: string }[]
  notes: string[]
}

export type ParkingSnapshot = {
  ok: boolean
  error?: string
  source: string
  sourceUrl: string
  fetchedAt: string
  garages: Garage[]
  permits: PermitInfo
}

export const STATUS_LABEL: Record<GarageStatus, string> = {
  open: 'Open',
  busy: 'Filling up',
  full: 'Full',
  unknown: 'No live count',
}

export type StatusTone = 'ok' | 'warn' | 'bad' | 'muted'

export function statusTone(status: GarageStatus): StatusTone {
  if (status === 'open') return 'ok'
  if (status === 'busy') return 'warn'
  if (status === 'full') return 'bad'
  return 'muted'
}

/** "975 of 1,143 open", or a plain fallback when the sensors gave nothing. */
export function availabilityLabel(garage: Pick<Garage, 'available' | 'capacity'>): string {
  if (garage.available == null || garage.capacity == null) return 'Counts unavailable'
  return `${garage.available.toLocaleString()} of ${garage.capacity.toLocaleString()} open`
}

/** "Updated just now" / "Updated 4 min ago" / "Updated 1 h 12 min ago" / "No timestamp". */
export function formatUpdated(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'No timestamp'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'No timestamp'
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000))
  if (minutes < 1) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `Updated ${hours} h ago` : `Updated ${hours} h ${rest} min ago`
}

/** Google Maps directions to the garage, by coordinates when known, else by address. */
export function directionsUrl(garage: Pick<Garage, 'lat' | 'lng' | 'address' | 'name'>): string {
  const destination =
    garage.lat != null && garage.lng != null
      ? `${garage.lat},${garage.lng}`
      : `${garage.address || garage.name}, Indianapolis, IN`
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`
}

export async function fetchParkingSnapshot(signal?: AbortSignal): Promise<ParkingSnapshot> {
  const response = await fetch('/api/parking/garages', { signal })
  if (!response.ok) throw new Error(`Parking request failed (${response.status})`)
  return (await response.json()) as ParkingSnapshot
}
