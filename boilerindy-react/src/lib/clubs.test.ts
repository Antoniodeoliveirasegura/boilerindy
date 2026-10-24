import { describe, expect, test } from 'vitest'
import {
  CLUBS_PAGE_SIZE,
  applyFollow,
  buildClubsQuery,
  categoryCount,
  filterFollowedClubs,
  followedCategories,
  followingFromParam,
  followingLabel,
  formatFetched,
  initialsFor,
  normalizeClubFollows,
  organizationKeyOf,
  resultsLabel,
  scopeFromParam,
  type Club,
  type FollowedClub,
} from './clubs'

// Issue #16 - the clubs page builds its API queries and labels with these
// helpers; keep the URL short and the copy honest about what is filtered.

describe('buildClubsQuery', () => {
  test('omits defaults entirely', () => {
    expect(buildClubsQuery({})).toBe('')
    expect(buildClubsQuery({ q: '   ', category: '', scope: 'all', page: 1, pageSize: CLUBS_PAGE_SIZE })).toBe('')
  })
  test('encodes every non-default parameter', () => {
    expect(buildClubsQuery({ q: ' chess & go ', category: 'Club Sports', scope: 'indianapolis', page: 2.7, pageSize: 10 })).toBe(
      '?q=chess+%26+go&category=Club+Sports&scope=indianapolis&page=2&pageSize=10',
    )
  })
})

describe('scopeFromParam', () => {
  test('defaults to Indianapolis unless the param says all', () => {
    expect(scopeFromParam(null)).toBe('indianapolis')
    expect(scopeFromParam('indianapolis')).toBe('indianapolis')
    expect(scopeFromParam('bogus')).toBe('indianapolis')
    expect(scopeFromParam('all')).toBe('all')
  })
})

describe('initialsFor', () => {
  test('takes the first letter of the first two words, skipping punctuation', () => {
    expect(initialsFor('Chess Club Purdue Indianapolis')).toBe('CC')
    expect(initialsFor('"ABC" - The Art of Bonsai Club')).toBe('AT')
    expect(initialsFor('3D Printed Prosthetics Club')).toBe('3P')
    expect(initialsFor('Pokémon')).toBe('P')
    expect(initialsFor('---')).toBe('?')
  })
})

describe('categoryCount', () => {
  test('follows the scope', () => {
    const row = { name: 'Hobby', count: 293, indianapolisCount: 9 }
    expect(categoryCount(row, 'all')).toBe(293)
    expect(categoryCount(row, 'indianapolis')).toBe(9)
  })
})

describe('resultsLabel', () => {
  test('describes the unfiltered list per scope', () => {
    expect(resultsLabel({ total: 58, q: '', category: '', scope: 'indianapolis' })).toBe('58 organizations in Indianapolis')
    expect(resultsLabel({ total: 1208, q: '', category: '', scope: 'all' })).toBe('1,208 organizations across Purdue')
    expect(resultsLabel({ total: 1, q: '', category: '', scope: 'all' })).toBe('1 organization across Purdue')
  })
  test('names the query and category when filtering', () => {
    expect(resultsLabel({ total: 3, q: 'chess', category: '', scope: 'indianapolis' })).toBe('3 matches for "chess" in Indianapolis')
    expect(resultsLabel({ total: 1, q: 'chess', category: 'Hobby', scope: 'all' })).toBe('1 match for "chess" in Hobby across Purdue')
    expect(resultsLabel({ total: 0, q: '', category: 'Dance', scope: 'indianapolis' })).toBe('0 matches in Dance in Indianapolis')
  })
})

describe('formatFetched', () => {
  test('says today for same-day stamps and dates otherwise', () => {
    const now = new Date('2026-09-08T15:00:00')
    expect(formatFetched('2026-09-08T06:04:00', now)).toMatch(/^today at 6:04/)
    expect(formatFetched('2026-09-07T22:30:00', now)).toMatch(/^Sep 7 at 10:30/)
    expect(formatFetched('garbage', now)).toBeNull()
  })
})

// Issue #16 - following a club: the key the server stores, the follows answer,
// and the Following view's filter and labels.
describe('following a club', () => {
  const club = (overrides: Partial<Club>): Club => ({
    id: '404807',
    name: 'Chess Club Purdue Indianapolis',
    shortName: 'Chess Club',
    slug: 'indychess',
    url: 'https://boilerlink.purdue.edu/organization/indychess',
    imageUrl: null,
    blurb: 'Weekly meetings for players of every level.',
    categories: ['Hobby', 'Club Sports'],
    indianapolis: true,
    ...overrides,
  })
  const followed = (c: Club): FollowedClub => ({ ...c, organizationKey: organizationKeyOf(c) })
  const CHESS = club({})
  const POKEMON = club({ id: '296383', name: 'Pokémon GO Club of Purdue', shortName: null, slug: 'pokemongo', blurb: 'Raids on campus.', categories: ['Hobby'], indianapolis: false })
  const ROBOTICS = club({ id: '406974', name: 'VEX U Team Purdue Indianapolis', shortName: 'VEX U', slug: 'vexu', blurb: '', categories: ['Technology'] })

  test('a club is followed by its BoilerLink key', () => {
    expect(organizationKeyOf(CHESS)).toBe('boilerlink:404807')
  })

  test('the follows answer always has both lists, and drops what is not a key or a followed club', () => {
    expect(normalizeClubFollows(null)).toEqual({ follows: [], clubs: [] })
    expect(normalizeClubFollows({ follows: 'boilerlink:1', clubs: {} })).toEqual({ follows: [], clubs: [] })
    expect(normalizeClubFollows({ follows: ['boilerlink:404807', 404807, null], clubs: [followed(CHESS), CHESS, null, 'x'] })).toEqual({
      follows: ['boilerlink:404807'],
      clubs: [followed(CHESS)],
    })
  })

  test('applyFollow adds a club once, in name order, and removes it', () => {
    const start = { follows: ['boilerlink:404807'], clubs: [followed(CHESS)] }
    const more = applyFollow(start, ROBOTICS, true)
    expect(more.follows).toEqual(['boilerlink:404807', 'boilerlink:406974'])
    expect(applyFollow(more, POKEMON, true).clubs.map((c) => c.name)).toEqual([
      'Chess Club Purdue Indianapolis',
      'Pokémon GO Club of Purdue',
      'VEX U Team Purdue Indianapolis',
    ])
    expect(applyFollow(more, ROBOTICS, true)).toEqual(more)
    expect(applyFollow(more, CHESS, false)).toEqual({ follows: ['boilerlink:406974'], clubs: [followed(ROBOTICS)] })
    expect(applyFollow(start, ROBOTICS, false)).toEqual(start)
    expect(start).toEqual({ follows: ['boilerlink:404807'], clubs: [followed(CHESS)] })
  })

  test('the Following view filters by every word, folded like the server search, and by category', () => {
    const clubs = [CHESS, POKEMON, ROBOTICS].map(followed)
    const names = (list: FollowedClub[]) => list.map((c) => c.name)
    expect(filterFollowedClubs(clubs)).toEqual(clubs)
    expect(names(filterFollowedClubs(clubs, { q: 'pokemon' }))).toEqual(['Pokémon GO Club of Purdue'])
    expect(names(filterFollowedClubs(clubs, { q: '  CHESS   players ' }))).toEqual(['Chess Club Purdue Indianapolis'])
    expect(names(filterFollowedClubs(clubs, { q: 'vex' }))).toEqual(['VEX U Team Purdue Indianapolis'])
    expect(names(filterFollowedClubs(clubs, { q: 'chess robots' }))).toEqual([])
    expect(names(filterFollowedClubs(clubs, { category: 'hobby' }))).toEqual(['Chess Club Purdue Indianapolis', 'Pokémon GO Club of Purdue'])
    expect(names(filterFollowedClubs(clubs, { q: 'raids', category: 'Hobby' }))).toEqual(['Pokémon GO Club of Purdue'])
  })

  test('the Following view counts its own categories and says what it lists', () => {
    expect(followedCategories([CHESS, POKEMON, ROBOTICS].map(followed))).toEqual([
      { name: 'Club Sports', count: 1 },
      { name: 'Hobby', count: 2 },
      { name: 'Technology', count: 1 },
    ])
    expect(followingLabel({ total: 3, q: '', category: '' })).toBe('3 clubs you follow')
    expect(followingLabel({ total: 1, q: '', category: '' })).toBe('1 club you follow')
    expect(followingLabel({ total: 1, q: 'chess', category: 'Hobby' })).toBe('1 match for "chess" in Hobby among the clubs you follow')
    expect(followingLabel({ total: 0, q: 'go', category: '' })).toBe('0 matches for "go" among the clubs you follow')
  })

  test('?following=1 and nothing else opens the Following view', () => {
    expect(followingFromParam('1')).toBe(true)
    for (const value of [null, undefined, '', '0', 'true', 'yes']) expect(followingFromParam(value)).toBe(false)
  })
})
