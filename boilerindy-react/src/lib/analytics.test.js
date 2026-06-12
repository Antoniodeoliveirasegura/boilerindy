import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureAnalytics, track, flush } from './analytics'

function lastFetchPayload(fetchMock) {
  const [, init] = fetchMock.mock.calls.at(-1)
  return JSON.parse(init.body)
}

describe('analytics client', () => {
  let fetchMock

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn(() => Promise.resolve({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    configureAnalytics({ enabled: false }) // reset module state between tests
  })

  afterEach(() => {
    configureAnalytics({ enabled: false })
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not queue or send anything while disabled', () => {
    track('page_view', { path: '/dashboard' })
    flush()
    vi.advanceTimersByTime(30_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('flushes queued events on the interval when enabled', () => {
    configureAnalytics({ enabled: true })
    track('page_view', { path: '/dashboard' })
    track('task_completed')
    expect(fetchMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const payload = lastFetchPayload(fetchMock)
    expect(payload.events).toHaveLength(2)
    expect(payload.events[0]).toMatchObject({ event_name: 'page_view', props: { path: '/dashboard' } })
  })

  it('flushes immediately when the batch cap is reached', () => {
    configureAnalytics({ enabled: true })
    for (let i = 0; i < 20; i += 1) track('page_view')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastFetchPayload(fetchMock).events).toHaveLength(20)
  })

  it('drops the queue when tracking is disabled (opt-out takes effect immediately)', () => {
    configureAnalytics({ enabled: true })
    track('page_view')
    configureAnalytics({ enabled: false })
    vi.advanceTimersByTime(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends nothing when the queue is empty', () => {
    configureAnalytics({ enabled: true })
    vi.advanceTimersByTime(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
