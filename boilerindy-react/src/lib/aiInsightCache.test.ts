import { beforeEach, describe, expect, test } from 'vitest'
import {
  aiCacheKey,
  boardDraftKey,
  boardReplyDraftKey,
  clearAiCaches,
  clearUserStores,
  readAiCache,
  writeAiCache,
} from './aiInsightCache'

// Issue #219 - the AI insight caches and the board draft were stored without a
// user id, so the next account on a shared computer saw the previous student's
// assignment ranking, week-ahead digest, event picks and unsent post.
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

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

  test('scopes a reply draft to the user and the post, under the post draft prefix', () => {
    expect(boardReplyDraftKey('user-1', 'post-9')).toBe('boilerindy-board-draft-v1-user-1-reply-post-9')
    expect(boardReplyDraftKey('user-1', 'post-9')).not.toBe(boardReplyDraftKey('user-2', 'post-9'))
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
    localStorage.setItem(boardReplyDraftKey('user-1', 'post-9'), 'an unsent reply')
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
      'boilerindy-board-draft-v1-user-1-reply-post-9',
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

// Sign-out and account deletion left the student's grades, schedule edits and
// assistant conversation in browser storage, readable in devtools by the next
// person at a shared computer.
describe('clearUserStores', () => {
  function seed() {
    localStorage.setItem('boilerindy-grades-v1-user-1', '[{"courseName":"PSY 12000","letterGrade":"D"}]')
    localStorage.setItem('boilerindy-major-v1-user-1', 'Psychology')
    localStorage.setItem('boilerindy-schedule-overrides-v1-user-1', '{"series":{},"manual":[]}')
    // Only on this device.
    localStorage.setItem('boilerindy-task-priority-v1-user-1', '{"task-a":"high"}')
    localStorage.setItem('boilerindy-tasks-v1-user-1', '{"completions":{},"manualTasks":[]}')
    localStorage.setItem('boilerindy-dashboard-layout-v1-user-1', '[]')
    localStorage.setItem('boilerindy-services-layout-v1-user-1', '[]')
    // Another account on the same computer, and a device-wide setting.
    localStorage.setItem('boilerindy-grades-v1-user-11', '[]')
    localStorage.setItem('boilerindy-grades-v1-user-2', '[]')
    localStorage.setItem('pih-theme', 'dark')
    sessionStorage.setItem('boilerindy-assistant-history-v1-user-1', '[{"role":"user","text":"Should I drop PSY 12000?"}]')
    sessionStorage.setItem('boilerindy-assistant-history-v1-user-2', '[]')
  }

  test('sign-out removes what the server keeps and the conversation, and leaves device-only stores', () => {
    seed()
    clearUserStores('user-1')
    expect(Object.keys(localStorage).sort()).toEqual([
      'boilerindy-dashboard-layout-v1-user-1',
      'boilerindy-grades-v1-user-11',
      'boilerindy-grades-v1-user-2',
      'boilerindy-services-layout-v1-user-1',
      'boilerindy-task-priority-v1-user-1',
      'boilerindy-tasks-v1-user-1',
      'pih-theme',
    ])
    expect(Object.keys(sessionStorage)).toEqual(['boilerindy-assistant-history-v1-user-2'])
  })

  // The upload is still owed, so dropping the edits would lose them.
  test('sign-out keeps schedule edits that have not reached the server', () => {
    seed()
    localStorage.setItem('boilerindy-schedule-overrides-dirty-v1-user-1', '1')
    clearUserStores('user-1')
    expect(localStorage.getItem('boilerindy-schedule-overrides-v1-user-1')).not.toBeNull()
    expect(localStorage.getItem('boilerindy-schedule-overrides-dirty-v1-user-1')).toBe('1')
    expect(localStorage.getItem('boilerindy-grades-v1-user-1')).toBeNull()
  })

  test('a deleted account loses every one of its stores and nobody else\'s', () => {
    seed()
    localStorage.setItem('boilerindy-schedule-overrides-dirty-v1-user-1', '1')
    clearUserStores('user-1', { accountDeleted: true })
    expect(Object.keys(localStorage).sort()).toEqual([
      'boilerindy-grades-v1-user-11',
      'boilerindy-grades-v1-user-2',
      'pih-theme',
    ])
    expect(Object.keys(sessionStorage)).toEqual(['boilerindy-assistant-history-v1-user-2'])
  })

  test('does nothing without a user id', () => {
    seed()
    const before = Object.keys(localStorage).length
    clearUserStores(undefined, { accountDeleted: true })
    expect(Object.keys(localStorage).length).toBe(before)
  })
})
