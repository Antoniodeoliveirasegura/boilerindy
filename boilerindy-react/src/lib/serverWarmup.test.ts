import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getServerWarmupState,
  resetServerWarmupForTests,
  startServerWarmup,
  subscribeServerWarmup,
} from './serverWarmup'

// Issue #164 - the store behind the "waking up the server" notice. The clock is
// faked (timers and Date together), so each test spells out how long the
// pretend cold start takes and checks the status at exact moments.

function respondAfter(ms: number, status = 200): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ ok: status < 400, status } as Response), ms)
  })
}

function failAfter(ms: number): Promise<Response> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new TypeError('Failed to fetch')), ms)
  })
}

function stubFetch(respond: (init?: RequestInit) => Promise<Response>) {
  const stub = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => respond(init))
  return { stub, fetchImpl: stub as unknown as typeof fetch }
}

const cleanups: Array<() => void> = []

/** Every status the store publishes from now on, in order. */
function recordStatuses(): string[] {
  const seen: string[] = []
  cleanups.push(subscribeServerWarmup(() => seen.push(getServerWarmupState().status)))
  return seen
}

describe('startServerWarmup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    resetServerWarmupForTests()
  })

  afterEach(() => {
    cleanups.splice(0).forEach((unsubscribe) => unsubscribe())
    resetServerWarmupForTests()
    vi.useRealTimers()
  })

  it('goes straight to ready when the server answers quickly', async () => {
    const { stub, fetchImpl } = stubFetch(() => respondAfter(100))
    const seen = recordStatuses()

    void startServerWarmup({ fetchImpl })
    expect(getServerWarmupState().status).toBe('pending')

    await vi.advanceTimersByTimeAsync(100)
    expect(getServerWarmupState()).toMatchObject({ status: 'ready', elapsedMs: 100 })

    // The slow timer was cleared, so nothing more happens once the answer is in.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(seen).toEqual(['pending', 'ready'])

    expect(stub).toHaveBeenCalledTimes(1)
    const [url, init] = stub.mock.calls[0]
    expect(url).toBe('/api/health')
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit' })
    expect(init?.signal?.aborted).toBe(false)
  })

  it('reports slow while a cold start drags on, then ready', async () => {
    const { fetchImpl } = stubFetch(() => respondAfter(5000))
    const seen = recordStatuses()
    void startServerWarmup({ fetchImpl })

    await vi.advanceTimersByTimeAsync(2499)
    expect(getServerWarmupState().status).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    expect(getServerWarmupState()).toMatchObject({ status: 'slow', elapsedMs: 2500 })

    await vi.advanceTimersByTimeAsync(2500)
    expect(getServerWarmupState()).toMatchObject({ status: 'ready', elapsedMs: 5000 })
    expect(seen).toEqual(['pending', 'slow', 'ready'])
  })

  it('fails on a network error', async () => {
    const { fetchImpl } = stubFetch(() => failAfter(50))
    void startServerWarmup({ fetchImpl })

    await vi.advanceTimersByTimeAsync(50)
    expect(getServerWarmupState().status).toBe('failed')
  })

  it('treats any HTTP response as awake, even an error status', async () => {
    const { fetchImpl } = stubFetch(() => respondAfter(10, 503))
    void startServerWarmup({ fetchImpl })

    await vi.advanceTimersByTimeAsync(10)
    expect(getServerWarmupState().status).toBe('ready')
  })

  it('sends one request no matter how many callers start it', async () => {
    const { stub, fetchImpl } = stubFetch(() => respondAfter(10))

    const first = startServerWarmup({ fetchImpl })
    const second = startServerWarmup({ fetchImpl })
    expect(second).toBe(first)

    await vi.advanceTimersByTimeAsync(10)
    expect(stub).toHaveBeenCalledTimes(1)

    // Still one request after it settled: once per page load, not per mount.
    expect(startServerWarmup({ fetchImpl })).toBe(first)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('gives up after timeoutMs and aborts the request', async () => {
    const { stub, fetchImpl } = stubFetch(() => new Promise<Response>(() => {}))
    void startServerWarmup({ fetchImpl, timeoutMs: 90_000 })

    await vi.advanceTimersByTimeAsync(89_999)
    expect(getServerWarmupState().status).toBe('slow')

    await vi.advanceTimersByTimeAsync(1)
    expect(getServerWarmupState()).toMatchObject({ status: 'failed', elapsedMs: 90_000 })
    expect(stub.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('stops notifying a listener after it unsubscribes', async () => {
    const { fetchImpl } = stubFetch(() => respondAfter(10))
    const listener = vi.fn()
    const unsubscribe = subscribeServerWarmup(listener)

    void startServerWarmup({ fetchImpl })
    expect(listener).toHaveBeenCalledTimes(1) // 'pending'

    unsubscribe()
    await vi.advanceTimersByTimeAsync(10)
    expect(getServerWarmupState().status).toBe('ready')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
