import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { readAiCache, writeAiCache, describeAge, AI_CACHE_TTL_MS } from './aiCache'

beforeEach(() => localStorage.clear())
afterEach(() => vi.useRealTimers())

describe('aiCache', () => {
  it('round-trips generated text with a timestamp', () => {
    const written = writeAiCache('k', 'hello')
    const read = readAiCache('k')
    expect(read?.text).toBe('hello')
    expect(read?.at).toBe(written.at)
  })

  it('returns null once the entry is older than the TTL', () => {
    vi.useFakeTimers()
    writeAiCache('k', 'stale')
    vi.advanceTimersByTime(AI_CACHE_TTL_MS + 1000)
    expect(readAiCache('k')).toBeNull()
  })

  it('honours a caller-supplied TTL', () => {
    vi.useFakeTimers()
    writeAiCache('k', 'text')
    vi.advanceTimersByTime(5000)
    expect(readAiCache('k', 10_000)?.text).toBe('text')
    expect(readAiCache('k', 1000)).toBeNull()
  })

  it('discards undated entries written before timestamps existed', () => {
    localStorage.setItem('legacy', JSON.stringify('old plain string'))
    expect(readAiCache('legacy')).toBeNull()
  })

  it('returns null for missing or corrupt entries', () => {
    expect(readAiCache('nope')).toBeNull()
    localStorage.setItem('bad', '{not json')
    expect(readAiCache('bad')).toBeNull()
    localStorage.setItem('partial', JSON.stringify({ text: 'x' }))
    expect(readAiCache('partial')).toBeNull()
  })

  it('describes how old an entry is', () => {
    const now = Date.now()
    expect(describeAge(now)).toBe('just now')
    expect(describeAge(now - 15 * 60 * 1000)).toBe('15 min ago')
    expect(describeAge(now - 60 * 60 * 1000)).toBe('1 hour ago')
    expect(describeAge(now - 3 * 60 * 60 * 1000)).toBe('3 hours ago')
    expect(describeAge(null)).toBe('')
  })
})
