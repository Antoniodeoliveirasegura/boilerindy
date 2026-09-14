// Service worker update flow (issue #220).
//
// The app ships an /install walkthrough, so students keep it open as an
// installed PWA for days. Before this, sw.js called skipWaiting() at install
// and the page was never told: an old bundle kept running against a possibly
// changed API until the student happened to reload. Now the worker waits
// (public/sw.js), this module notices the waiting worker, the UpdateToast
// offers a refresh, and applyUpdate() swaps the worker and reloads once.
//
// Every browser API is injectable so the logic is unit-tested without a real
// service worker.

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export type WorkerLike = {
  state: string
  addEventListener: (type: 'statechange', listener: () => void) => void
  postMessage: (message: unknown) => void
}

export type RegistrationLike = {
  waiting: WorkerLike | null
  installing: WorkerLike | null
  addEventListener: (type: 'updatefound', listener: () => void) => void
  update: () => Promise<unknown>
}

export type ContainerLike = {
  controller: unknown
  register: (url: string) => Promise<RegistrationLike>
  addEventListener: (type: 'controllerchange', listener: () => void) => void
}

export type UpdateReady = (registration: RegistrationLike) => void

/**
 * Call onUpdateReady when a new worker is installed and waiting behind a
 * controller. Fires at once when that is already the case (the page was
 * reloaded during an install), and after any later `updatefound` that reaches
 * `installed`. A first install (no controller yet) is not an update and is
 * never announced.
 */
export function watchForWaitingWorker(registration: RegistrationLike, onUpdateReady: UpdateReady, container: ContainerLike): void {
  const announceIfWaiting = () => {
    if (registration.waiting && container.controller) onUpdateReady(registration)
  }
  announceIfWaiting()
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') announceIfWaiting()
    })
  })
}

export type DocLike = {
  visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
}

export type RegisterOptions = {
  onUpdateReady: UpdateReady
  container?: ContainerLike
  doc?: DocLike
  setInterval?: (fn: () => void, ms: number) => unknown
  checkIntervalMs?: number
  scriptUrl?: string
}

/**
 * Register the worker and keep looking for updates: hourly, and whenever the
 * tab comes back into view, because an installed app can sit in the
 * background across several releases. Resolves null when registration fails;
 * the app must work exactly the same without a worker.
 */
export async function registerServiceWorker({
  onUpdateReady,
  container = navigator.serviceWorker,
  doc = document,
  setInterval = (fn, ms) => window.setInterval(fn, ms),
  checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  scriptUrl = '/sw.js',
}: RegisterOptions): Promise<RegistrationLike | null> {
  let registration: RegistrationLike
  try {
    registration = await container.register(scriptUrl)
  } catch {
    return null
  }
  watchForWaitingWorker(registration, onUpdateReady, container)

  const check = () => {
    registration.update().catch(() => {})
  }
  setInterval(check, checkIntervalMs)
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') check()
  })
  return registration
}

/**
 * The student accepted the prompt: tell the waiting worker to take over and
 * reload once it controls the page. The controllerchange listener is attached
 * only here, never at registration, so the first install (clients.claim())
 * can not trigger a reload loop. With no worker waiting any more (it already
 * activated in another tab) a plain reload is the right move.
 */
export function applyUpdate(
  registration: RegistrationLike,
  container: ContainerLike = navigator.serviceWorker,
  reload: () => void = () => window.location.reload(),
): void {
  const waiting = registration.waiting
  if (!waiting) {
    reload()
    return
  }
  let reloaded = false
  container.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    reload()
  })
  waiting.postMessage({ type: 'SKIP_WAITING' })
}
