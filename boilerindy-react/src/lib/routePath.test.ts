import { describe, expect, test } from 'vitest'
import { normalizeRoutePath } from './routePath'

describe('normalizeRoutePath', () => {
  test('compares paths the way the router matches them', () => {
    expect(normalizeRoutePath('/dashboard')).toBe('/dashboard')
    expect(normalizeRoutePath('/dashboard/')).toBe('/dashboard')
    expect(normalizeRoutePath('/Schedule')).toBe('/schedule')
    expect(normalizeRoutePath('/MAP//')).toBe('/map')
  })

  test('keeps the root', () => {
    expect(normalizeRoutePath('/')).toBe('/')
    expect(normalizeRoutePath('///')).toBe('/')
  })
})
