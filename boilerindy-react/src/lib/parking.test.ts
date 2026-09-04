import { describe, expect, test } from 'vitest'
import { availabilityLabel, directionsUrl, formatUpdated, statusTone } from './parking'

// Issue #14 - the parking page and map layer format the server snapshot with
// these helpers; keep them honest about missing data.

describe('availabilityLabel', () => {
  test('formats open spaces against capacity', () => {
    expect(availabilityLabel({ available: 975, capacity: 1143 })).toBe('975 of 1,143 open')
  })
  test('falls back when either count is missing', () => {
    expect(availabilityLabel({ available: null, capacity: 1324 })).toBe('Counts unavailable')
    expect(availabilityLabel({ available: 10, capacity: null })).toBe('Counts unavailable')
  })
})

describe('formatUpdated', () => {
  const now = new Date('2026-09-04T07:00:00.000Z')
  test('buckets by minutes and hours', () => {
    expect(formatUpdated('2026-09-04T06:59:40.000Z', now)).toBe('Updated just now')
    expect(formatUpdated('2026-09-04T06:56:00.000Z', now)).toBe('Updated 4 min ago')
    expect(formatUpdated('2026-09-04T05:48:00.000Z', now)).toBe('Updated 1 h 12 min ago')
    expect(formatUpdated('2026-09-04T05:00:00.000Z', now)).toBe('Updated 2 h ago')
  })
  test('handles missing or bad timestamps', () => {
    expect(formatUpdated(null, now)).toBe('No timestamp')
    expect(formatUpdated('garbage', now)).toBe('No timestamp')
  })
})

describe('statusTone', () => {
  test('maps every status to a tone', () => {
    expect(statusTone('open')).toBe('ok')
    expect(statusTone('busy')).toBe('warn')
    expect(statusTone('full')).toBe('bad')
    expect(statusTone('unknown')).toBe('muted')
  })
})

describe('directionsUrl', () => {
  test('prefers coordinates', () => {
    expect(directionsUrl({ lat: 39.775, lng: -86.17, address: '725 W Michigan St', name: 'Blackford Garage' })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=39.775%2C-86.17',
    )
  })
  test('falls back to the address', () => {
    expect(directionsUrl({ lat: null, lng: null, address: '725 W Michigan St', name: 'Blackford Garage' })).toContain(
      encodeURIComponent('725 W Michigan St, Indianapolis, IN'),
    )
  })
})
