// Shared look for the floating controls on the Leaflet maps on /map and
// /transit, so the two pages do not drift apart. Leaflet's own controls (zoom,
// attribution, the popup close) are styled in index.css under .purdue-map.

// A floating control over the map (search, locate): a 44px square ink plate.
export const INK_BUTTON =
  'ink-panel grid place-items-center w-11 h-11 rounded-[var(--radius-lg)] shadow-[var(--shadow-md)] transition-colors hover:bg-[var(--color-ink-lift-2)]'
