// Toggleable overlays on the campus map (issue #158). Each overlay is a
// self-contained component that renders nothing when its layer is off; this
// module owns the registry, the persisted on/off state, and the hook.

import { useCallback, useEffect, useState } from 'react'

export type MapLayerId = 'buildings' | 'parking'

export const MAP_LAYERS: { id: MapLayerId; label: string; icon: string }[] = [
  { id: 'buildings', label: 'Buildings', icon: 'building' },
  { id: 'parking', label: 'Parking', icon: 'parking' },
]

export type MapLayerState = Record<MapLayerId, boolean>

export const DEFAULT_MAP_LAYERS: MapLayerState = { buildings: true, parking: false }

const STORAGE_KEY = 'boilerindy:map-layers'

export function readStoredLayers(): Partial<MapLayerState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Partial<MapLayerState> = {}
    for (const layer of MAP_LAYERS) {
      if (typeof parsed[layer.id] === 'boolean') out[layer.id] = parsed[layer.id] as boolean
    }
    return out
  } catch {
    return {}
  }
}

function writeStoredLayers(state: MapLayerState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the toggle still works for the session.
  }
}

/**
 * Layer visibility with localStorage persistence. `forceOn` lets a caller
 * (e.g. a `?layer=parking` link) switch a layer on for this visit without
 * clobbering the stored preference until the user toggles something.
 */
export function useMapLayers(forceOn: MapLayerId[] = []) {
  const [layers, setLayers] = useState<MapLayerState>(() => {
    const next = { ...DEFAULT_MAP_LAYERS, ...readStoredLayers() }
    for (const id of forceOn) next[id] = true
    return next
  })
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (touched) writeStoredLayers(layers)
  }, [layers, touched])

  const toggle = useCallback((id: MapLayerId) => {
    setTouched(true)
    setLayers((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  return { layers, toggle }
}
