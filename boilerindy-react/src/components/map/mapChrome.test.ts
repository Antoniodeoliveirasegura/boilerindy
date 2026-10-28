import { describe, expect, test } from 'vitest'
import { ESRI_TILE_ATTRIBUTION } from './mapChrome'

// Issue #530 - the basemap credit said "Tiles © Esri, HERE, Garmin,
// OpenStreetMap contributors" with nothing linked and no "Powered by Esri",
// which Esri's attribution guidelines and OpenStreetMap's licence both ask for.
describe('ESRI_TILE_ATTRIBUTION', () => {
  const doc = new DOMParser().parseFromString(`<p>${ESRI_TILE_ATTRIBUTION}</p>`, 'text/html')
  const links = [...doc.querySelectorAll('a')]

  test('says Powered by Esri and keeps the data sources', () => {
    expect(doc.body.textContent).toBe('Powered by Esri | Esri, HERE, Garmin, © OpenStreetMap contributors')
  })

  test('links Esri and the OpenStreetMap copyright page in a new tab', () => {
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Esri', 'https://www.esri.com/'],
      ['OpenStreetMap', 'https://www.openstreetmap.org/copyright'],
    ])
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })
})
