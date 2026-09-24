import { describe, expect, test } from 'vitest'
import { extractBuildingCode } from './buildingCode'

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
