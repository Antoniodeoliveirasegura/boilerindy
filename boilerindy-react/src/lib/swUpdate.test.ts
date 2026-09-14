import { describe, expect, test, vi } from 'vitest'
import { applyUpdate, registerServiceWorker, watchForWaitingWorker, type ContainerLike, type RegistrationLike, type WorkerLike } from './swUpdate'

// Issue #220 - a new service worker used to activate silently; now the page
// must learn about a waiting worker, keep checking for one, and swap it in
// with exactly one reload when the student accepts.

function fakeWorker(state = 'installing'): WorkerLike & { fire: (s: string) => void; messages: unknown[] } {
  const listeners: Array<() => void> = []
  const w = {
    state,
    messages: [] as unknown[],
    addEventListener: (_type: 'statechange', l: () => void) => { listeners.push(l) },
    postMessage: (m: unknown) => { w.messages.push(m) },
    fire(next: string) { w.state = next; listeners.forEach((l) => l()) },
  }
  return w
}

function fakeRegistration(): RegistrationLike & { emitUpdateFound: () => void; updateCalls: number } {
  const listeners: Array<() => void> = []
  const reg = {
    waiting: null as WorkerLike | null,
    installing: null as WorkerLike | null,
    updateCalls: 0,
    addEventListener: (_type: 'updatefound', l: () => void) => { listeners.push(l) },
    update: async () => { reg.updateCalls += 1 },
    emitUpdateFound() { listeners.forEach((l) => l()) },
  }
  return reg
}

function fakeContainer(registration: RegistrationLike, controller: unknown = {}): ContainerLike & { emitControllerChange: () => void } {
  const listeners: Array<() => void> = []
  return {
    controller,
    register: async () => registration,
    addEventListener: (_type: 'controllerchange', l: () => void) => { listeners.push(l) },
    emitControllerChange() { listeners.forEach((l) => l()) },
  }
}

describe('watchForWaitingWorker', () => {
  test('announces a worker that is already waiting behind a controller', () => {
    const reg = fakeRegistration()
    reg.waiting = fakeWorker('installed')
    const ready = vi.fn()
    watchForWaitingWorker(reg, ready, fakeContainer(reg))
    expect(ready).toHaveBeenCalledWith(reg)
  })

  test('announces a later update once it reaches installed, but never a first install', () => {
    const reg = fakeRegistration()
    const ready = vi.fn()
    watchForWaitingWorker(reg, ready, fakeContainer(reg))
    expect(ready).not.toHaveBeenCalled()

    const w = fakeWorker()
    reg.installing = w
    reg.emitUpdateFound()
    w.fire('installing')
    expect(ready).not.toHaveBeenCalled()
    reg.waiting = w
    w.fire('installed')
    expect(ready).toHaveBeenCalledTimes(1)

    // First install: no controller yet, so nothing to refresh to.
    const first = fakeRegistration()
    const firstReady = vi.fn()
    watchForWaitingWorker(first, firstReady, fakeContainer(first, null))
    const fw = fakeWorker()
    first.installing = fw
    first.emitUpdateFound()
    first.waiting = fw
    fw.fire('installed')
    expect(firstReady).not.toHaveBeenCalled()
  })
})

describe('registerServiceWorker', () => {
  test('registers, checks hourly and on return to the tab, and resolves null when registration fails', async () => {
    const reg = fakeRegistration()
    const container = fakeContainer(reg)
    let interval: { fn: () => void; ms: number } | null = null
    const visibility: Array<() => void> = []
    const doc = { visibilityState: 'hidden', addEventListener: (_t: 'visibilitychange', l: () => void) => { visibility.push(l) } }

    const result = await registerServiceWorker({
      onUpdateReady: () => {},
      container,
      doc,
      setInterval: (fn, ms) => { interval = { fn, ms }; return 1 },
    })
    expect(result).toBe(reg)
    expect(interval!.ms).toBe(60 * 60 * 1000)
    interval!.fn()
    expect(reg.updateCalls).toBe(1)
    visibility.forEach((l) => l()) // hidden: no check
    expect(reg.updateCalls).toBe(1)
    doc.visibilityState = 'visible'
    visibility.forEach((l) => l())
    expect(reg.updateCalls).toBe(2)

    const failing: ContainerLike = { controller: null, register: async () => { throw new Error('nope') }, addEventListener: () => {} }
    expect(await registerServiceWorker({ onUpdateReady: () => {}, container: failing, doc, setInterval: () => 1 })).toBeNull()
  })
})

describe('applyUpdate', () => {
  test('asks the waiting worker to take over and reloads exactly once on controllerchange', () => {
    const reg = fakeRegistration()
    const w = fakeWorker('installed')
    reg.waiting = w
    const container = fakeContainer(reg)
    const reload = vi.fn()

    applyUpdate(reg, container, reload)
    expect(w.messages).toEqual([{ type: 'SKIP_WAITING' }])
    expect(reload).not.toHaveBeenCalled()
    container.emitControllerChange()
    container.emitControllerChange()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('with nothing waiting any more it simply reloads', () => {
    const reg = fakeRegistration()
    const reload = vi.fn()
    applyUpdate(reg, fakeContainer(reg), reload)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
