import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  LEAD_MINUTE_OPTIONS,
  MAX_LEAD_MINUTES,
  MIN_LEAD_MINUTES,
  describePushSupport,
  describeTestResult,
  fetchPushConfig,
  fetchPushSettings,
  formatLeadMinutes,
  readPushSupportEnv,
  urlBase64ToUint8Array,
  type PushSupportEnv,
} from './push'

// Issue #9 - Web Push. The pure helpers behind the Settings card, plus how the
// fetch wrappers translate the server's "not switched on" answers.

function toBase64Url(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

describe('urlBase64ToUint8Array', () => {
  it('decodes padded standard base64', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3])
  })

  it('restores missing padding', () => {
    expect(Array.from(urlBase64ToUint8Array('AQ'))).toEqual([1])
    expect(Array.from(urlBase64ToUint8Array('AQI'))).toEqual([1, 2])
  })

  it('maps the url-safe alphabet back to + and /', () => {
    expect(Array.from(urlBase64ToUint8Array('-_-_'))).toEqual([251, 255, 191])
  })

  it('round-trips a 65-byte uncompressed P-256 point like a VAPID public key', () => {
    const bytes = [4, ...Array.from({ length: 64 }, (_, i) => (i * 37) % 256)]
    const encoded = toBase64Url(bytes)
    expect(encoded).toHaveLength(87)
    expect(encoded).not.toContain('=')
    expect(Array.from(urlBase64ToUint8Array(encoded))).toEqual(bytes)
  })
})

describe('formatLeadMinutes', () => {
  it('spells out every offered lead time', () => {
    expect(LEAD_MINUTE_OPTIONS.map(formatLeadMinutes)).toEqual([
      '15 minutes',
      '30 minutes',
      '1 hour',
      '2 hours',
      '3 hours',
      '6 hours',
      '12 hours',
      '1 day',
    ])
  })

  it('handles singulars and values between the presets', () => {
    expect(formatLeadMinutes(1)).toBe('1 minute')
    expect(formatLeadMinutes(90)).toBe('1 hour 30 minutes')
    expect(formatLeadMinutes(2880)).toBe('2 days')
  })
})

describe('LEAD_MINUTE_OPTIONS', () => {
  it('are whole minutes inside the range the server validates, ascending', () => {
    for (const minutes of LEAD_MINUTE_OPTIONS) {
      expect(Number.isInteger(minutes)).toBe(true)
      expect(minutes).toBeGreaterThanOrEqual(MIN_LEAD_MINUTES)
      expect(minutes).toBeLessThanOrEqual(MAX_LEAD_MINUTES)
    }
    expect([...LEAD_MINUTE_OPTIONS].sort((a, b) => a - b)).toEqual([...LEAD_MINUTE_OPTIONS])
  })
})

const SUPPORTED: PushSupportEnv = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isIos: false,
  isStandalone: false,
  isSecureContext: true,
}

describe('describePushSupport', () => {
  it('is supported in a modern desktop browser over https', () => {
    expect(describePushSupport(SUPPORTED)).toMatchObject({ supported: true, reason: null })
  })

  it('tells iPhone and iPad users to install the app first', () => {
    const result = describePushSupport({ ...SUPPORTED, isIos: true, hasPushManager: false })
    expect(result.supported).toBe(false)
    expect(result.reason).toBe('ios-not-installed')
    expect(result.message).toContain('Add to Home Screen')
  })

  it('is supported on iOS once installed to the Home Screen', () => {
    expect(describePushSupport({ ...SUPPORTED, isIos: true, isStandalone: true })).toMatchObject({
      supported: true,
      reason: null,
    })
  })

  it('flags an insecure context before anything else', () => {
    expect(describePushSupport({ ...SUPPORTED, isSecureContext: false, hasPushManager: false }).reason).toBe('insecure')
  })

  it('reports missing browser support', () => {
    expect(describePushSupport({ ...SUPPORTED, hasPushManager: false }).reason).toBe('unsupported')
    expect(describePushSupport({ ...SUPPORTED, hasServiceWorker: false }).reason).toBe('unsupported')
    expect(describePushSupport({ ...SUPPORTED, hasNotification: false }).reason).toBe('unsupported')
  })
})

describe('readPushSupportEnv', () => {
  it('returns plain booleans from the real environment', () => {
    const env = readPushSupportEnv()
    expect(Object.keys(env).sort()).toEqual(Object.keys(SUPPORTED).sort())
    for (const value of Object.values(env)) expect(typeof value).toBe('boolean')
  })
})

describe('describeTestResult', () => {
  it('describes the outcome in words', () => {
    expect(describeTestResult({ sent: 1, failed: 0, removed: 0 })).toBe('Sent to 1 device.')
    expect(describeTestResult({ sent: 2, failed: 1, removed: 0 })).toBe('Sent to 2 devices (1 failed).')
    expect(describeTestResult({ sent: 0, failed: 0, removed: 1 })).toBe(
      'Nothing was delivered (1 expired device removed).',
    )
    expect(describeTestResult({ sent: 0, failed: 0, removed: 0 })).toContain('No devices to send to yet')
  })
})

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('push API wrappers', () => {
  let fetchMock: Mock

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetchPushConfig asks the public endpoint without credentials', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { enabled: true, publicKey: 'BKey' }))
    await expect(fetchPushConfig()).resolves.toEqual({ enabled: true, publicKey: 'BKey' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/push/config')
    expect(init.credentials).toBe('omit')
  })

  it('fetchPushConfig treats a failing endpoint or a missing key as switched off', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'not here' }))
    await expect(fetchPushConfig()).resolves.toEqual({ enabled: false, publicKey: null })

    fetchMock.mockResolvedValue(jsonResponse(200, { enabled: true, publicKey: null }))
    await expect(fetchPushConfig()).resolves.toEqual({ enabled: false, publicKey: null })
  })

  it('fetchPushSettings returns the settings and devices with credentials', async () => {
    const subscriptions = [{ id: 's1', createdAt: '2026-09-01T00:00:00.000Z', userAgent: 'UA', lastUsedAt: null }]
    fetchMock.mockResolvedValue(
      jsonResponse(200, { enabled: true, settings: { deadlineReminders: false, leadMinutes: 120 }, subscriptions }),
    )
    await expect(fetchPushSettings()).resolves.toEqual({
      enabled: true,
      settings: { deadlineReminders: false, leadMinutes: 120 },
      subscriptions,
      notConfiguredMessage: null,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/push/settings')
    expect(init.credentials).toBe('include')
  })

  it('fetchPushSettings falls back to defaults for an out-of-range lead time', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { enabled: true, settings: { deadlineReminders: true, leadMinutes: 99999 }, subscriptions: [] }),
    )
    const state = await fetchPushSettings()
    expect(state.settings.leadMinutes).toBe(60)
  })

  it('fetchPushSettings maps the 503 push_not_configured answer to a disabled state', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: { code: 'push_not_configured', message: 'Push tables are missing.', status: 503 } }),
    )
    await expect(fetchPushSettings()).resolves.toEqual({
      enabled: false,
      settings: { deadlineReminders: true, leadMinutes: 60 },
      subscriptions: [],
      notConfiguredMessage: 'Push tables are missing.',
    })
  })

  it('fetchPushSettings rethrows any other failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: 'boom' } }))
    await expect(fetchPushSettings()).rejects.toThrow('boom')
  })
})
