// Shared look for the Leaflet maps on /map and /transit, so the two pages do
// not drift apart. Class strings only; each page keeps its own basemap.

// Leaflet's own controls (zoom, attribution) as ink plates, like the floating
// panels. leaflet.css is unlayered, so these need `!`.
export const LEAFLET_CHROME = [
  '[&_.leaflet-bar]:border-[var(--color-ink-edge)]!',
  '[&_.leaflet-bar]:rounded-[var(--radius-lg)]!',
  '[&_.leaflet-bar]:overflow-hidden',
  '[&_.leaflet-bar]:shadow-[var(--shadow-md)]!',
  '[&_.leaflet-bar_a]:w-9! [&_.leaflet-bar_a]:h-9! [&_.leaflet-bar_a]:leading-9!',
  '[&_.leaflet-bar_a]:rounded-none!',
  '[&_.leaflet-bar_a]:bg-[var(--color-ink-lift)]!',
  '[&_.leaflet-bar_a]:text-[var(--color-ink-txt)]!',
  '[&_.leaflet-bar_a]:border-b-white/12!',
  '[&_.leaflet-bar_a:hover]:bg-[var(--color-ink-lift-2)]!',
  '[&_.leaflet-bar_a.leaflet-disabled]:opacity-45',
  '[&_.leaflet-control-attribution]:bg-[var(--color-surface)]/85!',
  '[&_.leaflet-control-attribution]:text-[var(--color-txt-2)]!',
  '[&_.leaflet-control-attribution_a]:text-[var(--color-accent)]!',
  // The popup close cross: theme text colours, and a 44px target on phones
  // (the popup text moves in to clear it).
  '[&_a.leaflet-popup-close-button]:text-[var(--color-txt-2)]!',
  '[&_a.leaflet-popup-close-button:hover]:text-[var(--color-txt-0)]!',
  'max-md:[&_a.leaflet-popup-close-button]:w-11! max-md:[&_a.leaflet-popup-close-button]:h-11!',
  'max-md:[&_a.leaflet-popup-close-button]:text-[22px]! max-md:[&_a.leaflet-popup-close-button]:leading-[44px]!',
  'max-md:[&_.leaflet-popup-content]:mr-11!',
].join(' ')

// A floating control over the map (search, locate): a 44px square ink plate.
export const INK_BUTTON =
  'ink-panel grid place-items-center w-11 h-11 rounded-[var(--radius-lg)] shadow-[var(--shadow-md)] transition-colors hover:bg-[var(--color-ink-lift-2)]'
