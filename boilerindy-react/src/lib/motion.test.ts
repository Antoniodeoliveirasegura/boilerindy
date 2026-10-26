import { afterEach, describe, expect, test } from 'vitest'
import { canAnimate, finiteAnimations, riseOnce, routeEntranceKey, whenSettled } from './motion'
import { fakeAnimation, installFakeAnimations, type FakeAnimation } from './fakeAnimations'

// The motion system's script side (docs/motion.md): the CSS does the moving,
// these decide when an attribute goes on and comes off. jsdom has no Web
// Animations API, so each test that needs one installs a fake.

let uninstall: (() => void) | null = null
afterEach(() => {
  uninstall?.()
  uninstall = null
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('canAnimate', () => {
  test('is false in jsdom, which has no Web Animations API', () => {
    expect(canAnimate()).toBe(false)
  })

  test('is true where elements have getAnimations', () => {
    uninstall = installFakeAnimations(() => [])
    expect(canAnimate()).toBe(true)
  })
})

describe('finiteAnimations', () => {
  test('keeps what ends on its own and drops what never does', () => {
    const exit = fakeAnimation({ endTime: 260 })
    const spinner = fakeAnimation({ endTime: Infinity })
    uninstall = installFakeAnimations(() => [exit, spinner])
    expect(finiteAnimations(document.createElement('div'))).toEqual([exit])
  })

  test('is empty without the Web Animations API', () => {
    expect(finiteAnimations(document.createElement('div'))).toEqual([])
  })
})

describe('whenSettled', () => {
  test('resolves once every animation has finished or been cancelled', async () => {
    const a = fakeAnimation()
    const b = fakeAnimation()
    let done = false
    void whenSettled([a, b]).then(() => {
      done = true
    })
    a.finish()
    await tick()
    expect(done).toBe(false)
    b.cancel()
    await tick()
    expect(done).toBe(true)
  })
})

describe('riseOnce', () => {
  function setup(): { el: HTMLElement; running: FakeAnimation[] } {
    const state = { el: document.createElement('ul'), running: [] as FakeAnimation[] }
    uninstall = installFakeAnimations(() => state.running)
    return state
  }

  test('does nothing without the Web Animations API', () => {
    const el = document.createElement('ul')
    const cleanup = riseOnce(el, 'data-entering')
    expect(el.hasAttribute('data-entering')).toBe(false)
    cleanup()
  })

  test('keeps the attribute while a rise runs and takes it off once it has finished', async () => {
    const state = setup()
    const rise = fakeAnimation({ name: 'motion-rise', endTime: 700 })
    state.running = [rise]
    riseOnce(state.el, 'data-entering')
    expect(state.el.hasAttribute('data-entering')).toBe(true)

    await tick()
    expect(state.el.hasAttribute('data-entering')).toBe(true)

    state.running = []
    rise.finish()
    await tick()
    expect(state.el.hasAttribute('data-entering')).toBe(false)
  })

  test('also waits for a rise that started meanwhile', async () => {
    const state = setup()
    const first = fakeAnimation({ name: 'motion-rise' })
    const late = fakeAnimation({ name: 'motion-rise' })
    state.running = [first]
    riseOnce(state.el, 'data-route-enter')

    state.running = [late]
    first.finish()
    await tick()
    expect(state.el.hasAttribute('data-route-enter')).toBe(true)

    state.running = []
    late.finish()
    await tick()
    expect(state.el.hasAttribute('data-route-enter')).toBe(false)
  })

  test('a rise still listed after it finished (a forwards fill) does not hold the attribute on', async () => {
    const state = setup()
    const rise = fakeAnimation({ name: 'motion-rise' })
    state.running = [rise]
    riseOnce(state.el, 'data-entering')
    rise.finish()
    await tick()
    expect(state.el.hasAttribute('data-entering')).toBe(false)
  })

  test('does not wait for other animations, such as a colour transition', async () => {
    const state = setup()
    state.running = [fakeAnimation({ endTime: 120 })]
    riseOnce(state.el, 'data-entering')
    await tick()
    expect(state.el.hasAttribute('data-entering')).toBe(false)
  })

  test('its cleanup takes the attribute off at once', () => {
    const state = setup()
    state.running = [fakeAnimation({ name: 'motion-rise' })]
    const cleanup = riseOnce(state.el, 'data-entering')
    cleanup()
    expect(state.el.hasAttribute('data-entering')).toBe(false)
  })
})

describe('routeEntranceKey', () => {
  test('a new path is a new page, however it is written', () => {
    expect(routeEntranceKey('/events')).toBe('/events')
    expect(routeEntranceKey('/events/')).toBe('/events')
    expect(routeEntranceKey('/Events')).toBe('/events')
    expect(routeEntranceKey('/')).toBe('/')
    expect(routeEntranceKey('/dining')).not.toBe(routeEntranceKey('/transit'))
  })

  test("the admin console's sections are one page", () => {
    expect(routeEntranceKey('/admin')).toBe('/admin')
    expect(routeEntranceKey('/admin/leads')).toBe('/admin')
    expect(routeEntranceKey('/admin/reports/')).toBe('/admin')
    expect(routeEntranceKey('/administer')).toBe('/administer')
  })
})
