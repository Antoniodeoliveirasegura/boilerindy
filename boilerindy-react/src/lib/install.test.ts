import { describe, expect, it } from 'vitest'
import { INSTALL_STEPS, PLATFORM_LABEL, detectInstallPlatform, readInstallEnv } from './install'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

describe('detectInstallPlatform', () => {
  it('recognises iPhones and iPads, including iPadOS pretending to be a Mac', () => {
    expect(detectInstallPlatform({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 })).toBe('ios')
    expect(detectInstallPlatform({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios')
  })

  it('recognises Android and falls back to desktop', () => {
    expect(detectInstallPlatform({ userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe('android')
    expect(detectInstallPlatform({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe('desktop')
    expect(detectInstallPlatform({ userAgent: '', platform: '', maxTouchPoints: 0 })).toBe('desktop')
  })
})

describe('install content', () => {
  it('has a label, steps and the iOS web-app toggle reminder for every platform', () => {
    for (const platform of ['ios', 'android', 'desktop'] as const) {
      expect(PLATFORM_LABEL[platform]).toBeTruthy()
      expect(INSTALL_STEPS[platform].length).toBeGreaterThanOrEqual(4)
    }
    expect(INSTALL_STEPS.ios.join(' ')).toContain('Open as Web App')
  })

  it('readInstallEnv returns the expected shape', () => {
    const env = readInstallEnv()
    expect(typeof env.userAgent).toBe('string')
    expect(typeof env.isStandalone).toBe('boolean')
  })
})
