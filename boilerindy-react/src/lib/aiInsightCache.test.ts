import { beforeEach, describe, expect, test } from 'vitest'
import { aiCacheKey, boardDraftKey, clearAiCaches, readAiCache, writeAiCache } from './aiInsightCache'

// Issue #219 - the AI insight caches and the board draft were stored without a
// user id, so the next account on a shared computer saw the previous student's
// assignment ranking, week-ahead digest, event picks and unsent post.
beforeEach(() => localStorage.clear())

describe('aiCacheKey', () => {
  test('includes the feature, the user id and the suffix', () => {
    expect(aiCacheKey('assignments', 'user-1', 'priority-2026-09-14')).toBe(
      'ai-assignments-user-1-priority-2026-09-14',
    )
    expect(aiCacheKey('week-ahead', 'user-1', '2026-09-14')).toBe('ai-week-ahead-user-1-2026-09-14')
    expect(aiCacheKey('event-recs', 'user-1', '2026-09-15')).toBe('ai-event-recs-user-1-2026-09-15')
  })

  test('changes with the user', () => {
    for (const feature of ['assignments', 'week-ahead', 'event-recs'] as const) {
      expect(aiCacheKey(feature, 'user-1', '2026-09-14')).not.toBe(aiCacheKey(feature, 'user-2', '2026-09-14'))
    }
  })

  test('one user never reads what another user cached', () => {
    writeAiCache(aiCacheKey('week-ahead', 'user-1', '2026-09-14'), 'You have CS 180 on MWF.')
    expect(readAiCache(aiCacheKey('week-ahead', 'user-2', '2026-09-14'))).toBeNull()
    expect(readAiCache(aiCacheKey('week-ahead', 'user-1', '2026-09-14'))?.text).toBe('You have CS 180 on MWF.')
  })
})

describe('boardDraftKey', () => {
  test('is scoped per user', () => {
    expect(boardDraftKey('user-1')).toBe('boilerindy-board-draft-v1-user-1')
    expect(boardDraftKey('user-1')).not.toBe(boardDraftKey('user-2'))
  })
})

describe('readAiCache / writeAiCache', () => {
  test('round-trips insight text with a generated-at stamp', () => {
    const written = writeAiCache('ai-event-recs-user-1-2026-09-15', 'Go to the career fair.')
    expect(JSON.parse(localStorage.getItem('ai-event-recs-user-1-2026-09-15') || 'null')).toEqual({
      text: 'Go to the career fair.',
      at: written.at,
    })
    expect(readAiCache('ai-event-recs-user-1-2026-09-15')).toEqual(written)
  })

  test('an entry past the TTL reads as nothing', () => {
    writeAiCache('ai-week-ahead-user-1-2026-09-14', 'stale')
    expect(readAiCache('ai-week-ahead-user-1-2026-09-14', -1)).toBeNull()
  })

  test('a pre-timestamp bare string reads as expired, not as undated text', () => {
    localStorage.setItem('ai-week-ahead-user-1-2026-09-14', '"written by an older build"')
    expect(readAiCache('ai-week-ahead-user-1-2026-09-14')).toBeNull()
  })

  test('a null key (no user id yet) reads nothing and writes nothing', () => {
    writeAiCache(null, 'text')
    expect(localStorage.length).toBe(0)
    expect(readAiCache(null)).toBeNull()
  })

  test('returns null for missing, blank, non-string or unparseable entries', () => {
    expect(readAiCache('ai-week-ahead-user-1-2026-09-14')).toBeNull()
    localStorage.setItem('ai-a', '"   "')
    localStorage.setItem('ai-b', '42')
    localStorage.setItem('ai-c', '{not json')
    expect(readAiCache('ai-a')).toBeNull()
    expect(readAiCache('ai-b')).toBeNull()
    expect(readAiCache('ai-c')).toBeNull()
  })
})

describe('clearAiCaches', () => {
  function seed() {
    localStorage.setItem('ai-assignments-user-1-priority-2026-09-14', '"rank"')
    localStorage.setItem('ai-week-ahead-user-1-2026-09-14', '"digest"')
    localStorage.setItem('ai-event-recs-user-2-2026-09-15', '"recs"')
    // Unscoped entries written by builds before issue #219.
    localStorage.setItem('ai-week-ahead-2026-09-07', '"old digest"')
    localStorage.setItem('boilerindy-board-draft-v1', '{"title":"old","body":""}')
    localStorage.setItem('boilerindy-board-draft-v1-user-1', '{"title":"draft","body":""}')
    // The dashboard's cached location and its prompt flag (issue #294), plus the
    // full-precision key written before it.
    localStorage.setItem('boilerindy-user-location-v2', '{"lat":40.424,"lon":-86.921,"ts":1789560000000}')
    localStorage.setItem('boilerindy-user-location-v1', '{"lat":40.4237054,"lon":-86.9211946}')
    localStorage.setItem('boilerindy-geo-asked-v1', '1')
    // Stores that must survive a sign-out.
    localStorage.setItem('boilerindy-task-priority-v1-user-1', '{"task-a":"high"}')
    localStorage.setItem('boilerindy-dashboard-layout-v1-user-1', '[]')
    localStorage.setItem('pih-theme', 'dark')
  }

  test('removes only the ai-*, board draft and location keys', () => {
    seed()
    clearAiCaches()
    expect(Object.keys(localStorage).sort()).toEqual([
      'boilerindy-dashboard-layout-v1-user-1',
      'boilerindy-task-priority-v1-user-1',
      'pih-theme',
    ])
  })

  test('keepBoardDrafts removes the ai-* and location keys and leaves the drafts', () => {
    seed()
    clearAiCaches({ keepBoardDrafts: true })
    expect(Object.keys(localStorage).sort()).toEqual([
      'boilerindy-board-draft-v1',
      'boilerindy-board-draft-v1-user-1',
      'boilerindy-dashboard-layout-v1-user-1',
      'boilerindy-task-priority-v1-user-1',
      'pih-theme',
    ])
  })

  test('is a no-op on empty storage', () => {
    expect(() => clearAiCaches()).not.toThrow()
    expect(localStorage.length).toBe(0)
  })
})
