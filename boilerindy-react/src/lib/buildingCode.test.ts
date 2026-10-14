import { describe, expect, test } from 'vitest'
import { extractBuildingCode, mapHrefForRoom } from './buildingCode'

// Issue #225 - the Map page keys building lookups on this one regex, so its
// edges are pinned here: two to four leading letters, case-insensitive, the
// room number optional.

describe('extractBuildingCode', () => {
  test('takes the leading letters of a room string, upper-cased', () => {
    expect(extractBuildingCode('ET 215')).toBe('ET')
    expect(extractBuildingCode('lwsn b155')).toBe('LWSN')
    expect(extractBuildingCode('SL150')).toBe('SL')
    expect(extractBuildingCode('LWSN')).toBe('LWSN')
  })

  test('returns null without letters up front, or without input', () => {
    expect(extractBuildingCode('215')).toBeNull()
    expect(extractBuildingCode(' ET 215')).toBeNull()
    expect(extractBuildingCode('')).toBeNull()
    expect(extractBuildingCode(null)).toBeNull()
    expect(extractBuildingCode(undefined)).toBeNull()
  })

  test('a four-letter word passes as a code and a longer word is cut to four letters', () => {
    // Current behaviour, pinned rather than endorsed: the regex takes up to four
    // letters and does not require the word to end there. "Room 12" therefore
    // yields ROOM and "Hallway 3" yields HALL. Anything smarter belongs in the
    // room parser, not here.
    expect(extractBuildingCode('Room 12')).toBe('ROOM')
    expect(extractBuildingCode('Hallway 3')).toBe('HALL')
    expect(extractBuildingCode('A 12')).toBeNull()
  })
})

// Home's Get Directions linked to plain /map, so the class's building was never
// selected; it now builds the same deep link as Schedule's Find Room.
describe('mapHrefForRoom', () => {
  test('carries the building code and the encoded room when the room starts with a code', () => {
    expect(mapHrefForRoom('SL 008')).toBe('/map?building=SL&room=SL%20008')
    expect(mapHrefForRoom('lwsn b155')).toBe('/map?building=LWSN&room=lwsn%20b155')
  })

  test('carries the room alone when there is no code to take', () => {
    expect(mapHrefForRoom('215')).toBe('/map?room=215')
    expect(mapHrefForRoom('215 & 216')).toBe('/map?room=215%20%26%20216')
  })

  test('is plain /map without a room or with the "Location unavailable" placeholder', () => {
    expect(mapHrefForRoom(null)).toBe('/map')
    expect(mapHrefForRoom(undefined)).toBe('/map')
    expect(mapHrefForRoom('')).toBe('/map')
    expect(mapHrefForRoom('   ')).toBe('/map')
    expect(mapHrefForRoom('Location unavailable')).toBe('/map')
  })
})
