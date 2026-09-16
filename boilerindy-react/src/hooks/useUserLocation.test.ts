import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { CACHE_TTL_MS, LOCATION_STORAGE_KEYS, readCache, useUserLocation, writeCache } from './useUserLocation'

// Issue #294 - the dashboard cached the student's position at full precision,
// with no expiry, and sign-out left it behind. The cache now stores a coarse,
// timestamped copy that expires; the live session keeps the precise fix.

const V2 = 'boilerindy-user-location-v2'
const V1 = 'boilerindy-user-location-v1'
const ASKED = 'boilerindy-geo-asked-v1'
const NOW = Date.UTC(2026, 8, 16, 14, 0, 0)
// A spot on Purdue's campus with more precision than the cache should keep.
const PRECISE = { lat: 40.4237054, lon: -86.9211946 }

type PermissionState = 'granted' | 'prompt' | 'denied'

function stubGeolocation(permission: PermissionState | null) {
  const getCurrentPosition = vi.fn((success: PositionCallback) => {
    success({ coords: { latitude: PRECISE.lat, longitude: PRECISE.lon } } as GeolocationPosition)
  })
  Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true })
  if (permission) {
    const query = vi.fn(async () => ({ state: permission }) as PermissionStatus)
    Object.defineProperty(navigator, 'permissions', { value: { query }, configurable: true })
  }
  return getCurrentPosition
}

beforeEach(() => localStorage.clear())

afterEach(() => {
  // jsdom has neither property; remove the stubs so each test starts clean.
  Reflect.deleteProperty(navigator, 'geolocation')
  Reflect.deleteProperty(navigator, 'permissions')
})

describe('writeCache', () => {
  test('stores 3 decimals and the write time under the v2 key', () => {
    writeCache(PRECISE, NOW)
    expect(JSON.parse(localStorage.getItem(V2) || 'null')).toEqual({ lat: 40.424, lon: -86.921, ts: NOW })
    expect(localStorage.getItem(V1)).toBeNull()
  })
})

describe('readCache', () => {
  test('returns a fresh entry', () => {
    writeCache(PRECISE, NOW)
    expect(readCache(NOW + CACHE_TTL_MS - 1)).toEqual({ lat: 40.424, lon: -86.921 })
  })

  test('ignores an entry older than 12 hours', () => {
    writeCache(PRECISE, NOW)
    expect(CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000)
    expect(readCache(NOW + CACHE_TTL_MS + 1)).toBeNull()
  })

  test('ignores a v1-shaped payload with no timestamp, even under the v2 key', () => {
    localStorage.setItem(V2, JSON.stringify(PRECISE))
    expect(readCache(NOW)).toBeNull()
  })

  test('ignores an entry stamped in the future and anything unparseable', () => {
    localStorage.setItem(V2, JSON.stringify({ lat: 40.424, lon: -86.921, ts: NOW + 60_000 }))
    expect(readCache(NOW)).toBeNull()
    localStorage.setItem(V2, '{not json')
    expect(readCache(NOW)).toBeNull()
  })

  test('never reads the legacy v1 key', () => {
    localStorage.setItem(V1, JSON.stringify({ ...PRECISE, ts: NOW }))
    expect(readCache(NOW)).toBeNull()
  })
})

describe('LOCATION_STORAGE_KEYS', () => {
  test('names the cache, the legacy cache and the prompt flag', () => {
    expect([...LOCATION_STORAGE_KEYS].sort()).toEqual([ASKED, V1, V2].sort())
  })
})

describe('useUserLocation', () => {
  test('mounting removes the legacy v1 key, even without geolocation support', () => {
    localStorage.setItem(V1, JSON.stringify(PRECISE))
    expect('geolocation' in navigator).toBe(false)
    renderHook(() => useUserLocation({ autoPrompt: true }))
    expect(localStorage.getItem(V1)).toBeNull()
  })

  test('keeps full precision in state while the cache gets the coarse copy', async () => {
    const getCurrentPosition = stubGeolocation('granted')
    const { result } = renderHook(() => useUserLocation())
    await waitFor(() => expect(result.current).toEqual(PRECISE))
    expect(getCurrentPosition).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(localStorage.getItem(V2) || 'null')
    expect(stored).toMatchObject({ lat: 40.424, lon: -86.921 })
    expect(typeof stored.ts).toBe('number')
  })

  test('a returning student gets the cached position with no new prompt', async () => {
    writeCache(PRECISE)
    localStorage.setItem(ASKED, '1')
    const getCurrentPosition = stubGeolocation('prompt')
    const { result } = renderHook(() => useUserLocation({ autoPrompt: true }))
    expect(result.current).toEqual({ lat: 40.424, lon: -86.921 })
    await waitFor(() => expect(navigator.permissions.query).toHaveBeenCalled())
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })
})
