import { beforeEach, describe, expect, test } from 'vitest'
import { createLocalLayoutStore } from './createLocalLayoutStore'
import * as dashboardStore from './dashboardLayoutStore'
import * as servicesStore from './servicesLayoutStore'

// Issue #219 - dashboardLayoutStore and servicesLayoutStore were byte-identical
// apart from the key prefix and schema, so the per-user scoping now lives in one
// factory. The key strings must not change: existing users' cached layouts and
// the e2e mocks depend on them.
beforeEach(() => localStorage.clear())

const { normalizeLayout, defaultLayout } = dashboardStore
const store = createLocalLayoutStore('test-layout-v1-', { normalizeLayout })

describe('createLocalLayoutStore', () => {
  test('returns null when nothing is cached, so the caller falls back to the default', () => {
    expect(store.loadLocalLayout('user-1')).toBeNull()
  })

  test('saves and loads a layout under prefix + user id', () => {
    const layout = defaultLayout()
    store.saveLocalLayout('user-1', layout)
    expect(localStorage.getItem('test-layout-v1-user-1')).toBe(JSON.stringify(layout))
    expect(store.loadLocalLayout('user-1')).toEqual(normalizeLayout(layout))
  })

  test('is scoped per user', () => {
    store.saveLocalLayout('user-1', defaultLayout())
    expect(store.loadLocalLayout('user-2')).toBeNull()
  })

  test('no-ops without a user id', () => {
    store.saveLocalLayout(undefined, defaultLayout())
    store.saveLocalLayout(null, defaultLayout())
    store.saveLocalLayout('', defaultLayout())
    expect(localStorage.length).toBe(0)
    expect(store.loadLocalLayout(undefined)).toBeNull()
  })

  test('returns null for unparseable JSON', () => {
    localStorage.setItem('test-layout-v1-user-1', '{not json')
    expect(store.loadLocalLayout('user-1')).toBeNull()
  })

  test('runs a malformed stored layout through normalizeLayout', () => {
    localStorage.setItem(
      'test-layout-v1-user-1',
      JSON.stringify([{ id: 'not-a-widget', size: 'full' }, { id: 'gpa', size: 'huge' }, 'junk']),
    )
    const loaded = store.loadLocalLayout('user-1')
    expect(loaded).toEqual(normalizeLayout([{ id: 'gpa', size: 'huge' }]))
    expect(loaded?.some((w) => w.id === 'not-a-widget')).toBe(false)
    expect(loaded?.[0]).toEqual({ id: 'gpa', size: 'half', visible: true })
  })
})

describe('board stores built on the factory', () => {
  test('dashboard store keeps its key string', () => {
    dashboardStore.saveLocalLayout('user-1', dashboardStore.defaultLayout())
    expect(Object.keys(localStorage)).toEqual(['boilerindy-dashboard-layout-v1-user-1'])
    expect(dashboardStore.loadLocalLayout('user-1')).toEqual(dashboardStore.defaultLayout())
  })

  test('services store keeps its key string', () => {
    servicesStore.saveLocalLayout('user-1', servicesStore.defaultLayout())
    expect(Object.keys(localStorage)).toEqual(['boilerindy-services-layout-v1-user-1'])
    expect(servicesStore.loadLocalLayout('user-1')).toEqual(servicesStore.defaultLayout())
  })

  test('the two boards never read each other', () => {
    dashboardStore.saveLocalLayout('user-1', dashboardStore.defaultLayout())
    expect(servicesStore.loadLocalLayout('user-1')).toBeNull()
  })
})
