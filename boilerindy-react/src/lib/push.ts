// Web Push client (issue #9). Types for the /api/push/* contract, pure helpers
// (unit tested in push.test.ts) and the thin browser + API layer that the
// Settings card drives. The server half (VAPID signing, payload encryption,
// the reminder sender) lives in src/webPush.mjs and src/pushReminders.mjs;
// the receiving side is the push/notificationclick handlers in public/sw.js.

import { authRequest } from './authApi'

export type PushConfig = { enabled: boolean; publicKey: string | null }

export type PushSettings = { deadlineReminders: boolean; leadMinutes: number }

export type PushSubscriptionSummary = {
  id: string
  createdAt: string
  userAgent: string | null
  lastUsedAt: string | null
}

export type PushSettingsResponse = {
  enabled: boolean
  settings: PushSettings
  subscriptions: PushSubscriptionSummary[]
}

/** GET /api/push/settings with the "tables not installed yet" 503 folded in. */
export type PushSettingsState = PushSettingsResponse & { notConfiguredMessage: string | null }

export type PushTestResult = { sent: number; failed: number; removed: number }

export const DEFAULT_PUSH_SETTINGS: PushSettings = { deadlineReminders: true, leadMinutes: 60 }

/** The server accepts any whole number of minutes in this range. */
export const MIN_LEAD_MINUTES = 5
export const MAX_LEAD_MINUTES = 10080

/** Lead times offered in Settings (15 minutes up to 1 day). */
export const LEAD_MINUTE_OPTIONS: readonly number[] = [15, 30, 60, 120, 180, 360, 720, 1440]

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** "15 minutes", "1 hour", "2 hours", "12 hours", "1 day"; odd values spell out both parts. */
export function formatLeadMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return ''
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return plural(total, 'minute')
  if (total % 1440 === 0) return plural(total / 1440, 'day')
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`
}

/**
 * Decodes a base64url VAPID public key (unpadded, "-"/"_" alphabet) into the
 * raw bytes PushManager.subscribe() wants as applicationServerKey.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const trimmed = base64url.trim()
  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4)
  const base64 = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** "Sent to 2 devices." / "Sent to 1 device (1 failed, 1 expired device removed)." */
export function describeTestResult(result: PushTestResult): string {
  const { sent, failed, removed } = result
  if (sent === 0 && failed === 0 && removed === 0) {
    return 'No devices to send to yet. Turn on notifications on this device first.'
  }
  const lead = sent > 0 ? `Sent to ${plural(sent, 'device')}` : 'Nothing was delivered'
  const extras: string[] = []
  if (failed > 0) extras.push(`${failed} failed`)
  if (removed > 0) extras.push(`${plural(removed, 'expired device')} removed`)
  return extras.length > 0 ? `${lead} (${extras.join(', ')}).` : `${lead}.`
}

// ---------------------------------------------------------------------------
// Device support
// ---------------------------------------------------------------------------

export type PushSupportEnv = {
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  isIos: boolean
  isStandalone: boolean
  isSecureContext: boolean
}

export type PushSupportReason = 'unsupported' | 'ios-not-installed' | 'insecure' | null

export type PushSupport = { supported: boolean; reason: PushSupportReason; message: string }

export const IOS_INSTALL_MESSAGE =
  'On iPhone and iPad, add BoilerIndy to your Home Screen first: tap Share, then Add to Home Screen, then come back here to turn on notifications.'

export function describePushSupport(env: PushSupportEnv): PushSupport {
  if (!env.isSecureContext) {
    return {
      supported: false,
      reason: 'insecure',
      message:
        'Push notifications only work over a secure (https) connection. Open BoilerIndy from its https address to turn them on.',
    }
  }
  // iOS only offers push to web apps installed on the Home Screen (16.4+), so
  // this comes before the generic feature test: the fix is installing, not
  // switching browsers.
  if (env.isIos && !env.isStandalone) {
    return { supported: false, reason: 'ios-not-installed', message: IOS_INSTALL_MESSAGE }
  }
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return {
      supported: false,
      reason: 'unsupported',
      message: 'This browser does not support push notifications. Try Chrome, Edge, Firefox, or Safari 16.4 or newer.',
    }
  }
  return { supported: true, reason: null, message: 'This device can receive push notifications.' }
}

/** Reads the real navigator/window; kept apart so describePushSupport stays testable. */
export function readPushSupportEnv(): PushSupportEnv {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      hasServiceWorker: false,
      hasPushManager: false,
      hasNotification: false,
      isIos: false,
      isStandalone: false,
      isSecureContext: false,
    }
  }
  const nav = navigator as Navigator & { standalone?: boolean }
  // iPadOS reports itself as a Mac; the touch points give it away.
  const isIos = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  let isStandalone = nav.standalone === true
  try {
    isStandalone = isStandalone || window.matchMedia('(display-mode: standalone)').matches
  } catch {
    /* matchMedia missing on very old engines */
  }
  return {
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    isIos,
    isStandalone,
    isSecureContext: window.isSecureContext === true,
  }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

type ApiError = Error & { status?: number; payload?: unknown }

function apiErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function normalizeSettings(raw: unknown): PushSettings {
  const source = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof PushSettings, unknown>>) : {}
  const lead = typeof source.leadMinutes === 'number' ? source.leadMinutes : Number(source.leadMinutes)
  return {
    deadlineReminders:
      typeof source.deadlineReminders === 'boolean' ? source.deadlineReminders : DEFAULT_PUSH_SETTINGS.deadlineReminders,
    leadMinutes:
      Number.isInteger(lead) && lead >= MIN_LEAD_MINUTES && lead <= MAX_LEAD_MINUTES
        ? lead
        : DEFAULT_PUSH_SETTINGS.leadMinutes,
  }
}

function normalizeSubscriptions(raw: unknown): PushSubscriptionSummary[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      id: String(item.id ?? ''),
      createdAt: String(item.createdAt ?? ''),
      userAgent: typeof item.userAgent === 'string' ? item.userAgent : null,
      lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
    }))
}

/** Public endpoint: plain fetch without credentials, so a logged-out render never redirects. */
export async function fetchPushConfig(): Promise<PushConfig> {
  const response = await fetch('/api/push/config', { credentials: 'omit' })
  if (!response.ok) return { enabled: false, publicKey: null }
  const data = (await response.json().catch(() => null)) as Partial<PushConfig> | null
  const publicKey = typeof data?.publicKey === 'string' && data.publicKey ? data.publicKey : null
  return { enabled: data?.enabled === true && publicKey !== null, publicKey }
}

/**
 * The 503 `push_not_configured` answer (tables not installed yet) becomes a
 * disabled state carrying the server's message instead of an exception.
 */
export async function fetchPushSettings(): Promise<PushSettingsState> {
  try {
    const data = (await authRequest('/api/push/settings')) as Partial<PushSettingsResponse> | null
    return {
      enabled: data?.enabled === true,
      settings: normalizeSettings(data?.settings),
      subscriptions: normalizeSubscriptions(data?.subscriptions),
      notConfiguredMessage: null,
    }
  } catch (error) {
    const apiError = error instanceof Error ? (error as ApiError) : null
    if (apiError && apiError.status === 503 && apiErrorCode(apiError.payload) === 'push_not_configured') {
      return {
        enabled: false,
        settings: { ...DEFAULT_PUSH_SETTINGS },
        subscriptions: [],
        notConfiguredMessage: apiError.message || 'Push notifications are not configured on this server yet.',
      }
    }
    throw error
  }
}

export async function savePushSettings(patch: Partial<PushSettings>): Promise<PushSettings> {
  const data = (await authRequest('/api/push/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })) as { settings?: unknown } | null
  return normalizeSettings(data?.settings)
}

/** Upsert by endpoint on the server, so re-posting the same subscription is safe. */
export async function registerPushSubscription(
  subscription: PushSubscription,
): Promise<{ id: string; createdAt: string }> {
  const data = (await authRequest('/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ subscription: subscription.toJSON(), userAgent: navigator.userAgent }),
  })) as { subscription?: { id?: unknown; createdAt?: unknown } } | null
  return {
    id: String(data?.subscription?.id ?? ''),
    createdAt: String(data?.subscription?.createdAt ?? ''),
  }
}

export async function removePushSubscription(endpoint: string): Promise<boolean> {
  const data = (await authRequest('/api/push/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  })) as { removed?: unknown } | null
  return data?.removed === true
}

export async function sendTestPush(): Promise<PushTestResult> {
  const data = (await authRequest('/api/push/test', { method: 'POST' })) as Partial<
    Record<keyof PushTestResult, unknown>
  > | null
  return { sent: toCount(data?.sent), failed: toCount(data?.failed), removed: toCount(data?.removed) }
}

// ---------------------------------------------------------------------------
// Browser side
// ---------------------------------------------------------------------------

/**
 * The registration for /sw.js, or null. main.tsx only registers the worker in
 * production builds, so null is the normal answer in `vite dev`.
 */
export async function getPushRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration) return null
    if (registration.active) return registration
    // Registered moments ago (first production visit): give it a few seconds
    // to activate, since subscribe() needs an active worker.
    return await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
    ])
  } catch {
    return null
  }
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const registration = await getPushRegistration()
  if (!registration || !('pushManager' in registration)) return null
  try {
    return await registration.pushManager.getSubscription()
  } catch {
    return null
  }
}

export type SubscribeFailure = 'denied' | 'no-worker' | 'subscribe-failed' | 'server-failed'

export type SubscribeResult = { ok: true } | { ok: false; reason: SubscribeFailure; message: string }

export type UnsubscribeResult = { ok: boolean; message: string | null }

function detail(error: unknown): string {
  return error instanceof Error && error.message ? ` (${error.message})` : ''
}

async function askNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  try {
    // Old Safari only knew the callback form, which resolves to undefined.
    const result = await Promise.resolve(Notification.requestPermission())
    return typeof result === 'string' ? result : Notification.permission
  } catch {
    return Notification.permission
  }
}

async function subscribeWithKey(
  registration: ServiceWorkerRegistration,
  applicationServerKey: Uint8Array<ArrayBuffer>,
): Promise<PushSubscription> {
  const options: PushSubscriptionOptionsInit = { userVisibleOnly: true, applicationServerKey }
  try {
    return await registration.pushManager.subscribe(options)
  } catch (error) {
    // A leftover subscription made with a different (rotated) VAPID key makes
    // subscribe() reject with InvalidStateError: drop it and start clean.
    const existing = await registration.pushManager.getSubscription()
    if (!existing) throw error
    await existing.unsubscribe()
    return registration.pushManager.subscribe(options)
  }
}

/** Must run from a user gesture (the permission prompt needs one). */
export async function subscribeThisDevice(publicKey: string): Promise<SubscribeResult> {
  const registration = await getPushRegistration()
  if (!registration || !('pushManager' in registration)) {
    return {
      ok: false,
      reason: 'no-worker',
      message:
        'The BoilerIndy service worker is not running in this tab yet. Reload the page and try again. (Local development builds never install it.)',
    }
  }

  const permission = await askNotificationPermission()
  if (permission !== 'granted') {
    return {
      ok: false,
      reason: 'denied',
      message:
        permission === 'denied'
          ? 'Notifications are blocked for BoilerIndy in this browser. Allow them in the site settings (the lock icon next to the address bar), then try again.'
          : 'Notifications were not allowed. Try again and choose Allow when the browser asks.',
    }
  }

  let subscription: PushSubscription
  try {
    subscription = await subscribeWithKey(registration, urlBase64ToUint8Array(publicKey))
  } catch (error) {
    return {
      ok: false,
      reason: 'subscribe-failed',
      message: `The browser could not create a push subscription${detail(error)}.`,
    }
  }

  try {
    await registerPushSubscription(subscription)
  } catch (error) {
    return {
      ok: false,
      reason: 'server-failed',
      message: `The subscription was created but the server did not save it${detail(error)}. Try again in a moment.`,
    }
  }
  return { ok: true }
}

/** Unsubscribes locally and tells the server; either side may fail without hiding the other. */
export async function unsubscribeThisDevice(): Promise<UnsubscribeResult> {
  const subscription = await getCurrentPushSubscription()
  if (!subscription) return { ok: true, message: null }
  const { endpoint } = subscription

  let browserOk = true
  try {
    await subscription.unsubscribe()
  } catch {
    browserOk = false
  }
  let serverOk = true
  try {
    await removePushSubscription(endpoint)
  } catch {
    serverOk = false
  }

  if (!browserOk) {
    return {
      ok: false,
      message: serverOk
        ? 'The server forgot this device, but the browser still holds its subscription. Try again, or clear the site data for BoilerIndy.'
        : 'Could not turn off notifications on this device. Try again in a moment.',
    }
  }
  return {
    ok: true,
    message: serverOk
      ? null
      : 'Notifications are off on this device. The server could not be reached, so it will drop this device the next time a send fails.',
  }
}
