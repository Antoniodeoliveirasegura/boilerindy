import { describe, expect, test } from 'vitest'
import { postMeta } from './campusNews'

// Issue #470: one line of facts under each Circuit headline.
describe('postMeta', () => {
  test('date on the campus calendar, tag and author, leaving out what is missing', () => {
    expect(postMeta({ publishedAt: '2026-10-01T04:24:51.000Z', tag: 'News', author: 'Omkar Govil-Nair' })).toBe('Oct 1 · News · By Omkar Govil-Nair')
    // 03:24 UTC on Oct 1 is still Sep 30 in Indianapolis (UTC-4).
    expect(postMeta({ publishedAt: '2026-10-01T03:24:51.000Z', tag: 'News', author: null })).toBe('Sep 30 · News')
    expect(postMeta({ publishedAt: '2026-09-23T15:00:00.000Z', tag: null, author: null })).toBe('Sep 23')
    expect(postMeta({ publishedAt: 'not a date', tag: 'Opinion', author: null })).toBe('Opinion')
    expect(postMeta({ publishedAt: null, tag: null, author: null })).toBe('')
  })
})
