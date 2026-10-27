// Shared look for the floating controls on the Leaflet maps on /map and
// /transit, so the two pages do not drift apart. Leaflet's own controls (zoom,
// attribution, the popup close) are styled in index.css under .purdue-map.

// A floating control over the map (search, locate): a 44px square ink plate.
export const INK_BUTTON =
  'ink-panel grid place-items-center w-11 h-11 rounded-[var(--radius-lg)] shadow-[var(--shadow-md)] transition-colors hover:bg-[var(--color-ink-lift-2)]'

// The credit under every Esri basemap on /map, /transit and /guide (issue
// #530): Esri's attribution guidelines ask for "Powered by Esri" next to the
// data sources, and OpenStreetMap's licence asks for its credit to link to its
// copyright page. Leaflet renders the string as HTML in its attribution control.
const NEW_TAB = 'target="_blank" rel="noopener noreferrer"'
export const ESRI_TILE_ATTRIBUTION =
  `Powered by <a href="https://www.esri.com/" ${NEW_TAB}>Esri</a> | ` +
  `Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" ${NEW_TAB}>OpenStreetMap</a> contributors`
