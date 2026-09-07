// "Add to Home Screen" guidance (issue #9 follow-up). Pure detection helpers
// for the /install page, kept apart from the page so they can be unit tested.

export type InstallPlatform = 'ios' | 'android' | 'desktop'

export type InstallEnv = {
  userAgent: string
  platform: string
  maxTouchPoints: number
  isStandalone: boolean
}

export function detectInstallPlatform(env: Pick<InstallEnv, 'userAgent' | 'platform' | 'maxTouchPoints'>): InstallPlatform {
  const ua = env.userAgent || ''
  // iPadOS reports itself as a Mac; the touch points give it away.
  if (/iPad|iPhone|iPod/.test(ua) || (env.platform === 'MacIntel' && env.maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'desktop'
}

export function readInstallEnv(): InstallEnv {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { userAgent: '', platform: '', maxTouchPoints: 0, isStandalone: false }
  }
  const nav = navigator as Navigator & { standalone?: boolean }
  let isStandalone = nav.standalone === true
  try {
    isStandalone = isStandalone || window.matchMedia('(display-mode: standalone)').matches
  } catch {
    /* matchMedia missing on very old engines */
  }
  return {
    userAgent: nav.userAgent || '',
    platform: nav.platform || '',
    maxTouchPoints: nav.maxTouchPoints || 0,
    isStandalone,
  }
}

export const PLATFORM_LABEL: Record<InstallPlatform, string> = {
  ios: 'iPhone and iPad',
  android: 'Android',
  desktop: 'Computer',
}

/** Ordered steps per platform. Plain strings so the page stays a simple list. */
export const INSTALL_STEPS: Record<InstallPlatform, string[]> = {
  ios: [
    'Open boilerindy.app in Safari. Other browsers on iPhone cannot add web apps with notifications.',
    'Tap the Share button (the square with an arrow pointing up) at the bottom of the screen.',
    'Scroll the sheet and tap "Add to Home Screen".',
    'Leave "Open as Web App" switched on, then tap "Add" in the top corner.',
    'Close Safari and open BoilerIndy from the new icon on your Home Screen. Always open it from there.',
    'Sign in, then go to Settings and turn on push notifications for this device.',
  ],
  android: [
    'Open boilerindy.app in Chrome.',
    'Tap the three-dot menu in the top corner.',
    'Tap "Add to Home screen" (on some phones it says "Install app"), then confirm with "Install".',
    'Open BoilerIndy from the new icon in your app list or Home screen.',
    'Sign in, then go to Settings and turn on push notifications for this device.',
  ],
  desktop: [
    'Open boilerindy.app in Chrome or Edge.',
    'Click the install icon at the right end of the address bar (a monitor with a down arrow), or open the browser menu and choose "Install BoilerIndy".',
    'Confirm with "Install". BoilerIndy opens in its own window and gets an icon in your dock or start menu.',
    'On a Mac with Safari, use File, then "Add to Dock" instead.',
    'Sign in, then go to Settings and turn on push notifications for this device.',
  ],
}

export const INSTALL_NOTES: Record<InstallPlatform, string> = {
  ios: 'iPhone and iPad only deliver push notifications to web apps on the Home Screen, so this step is required before reminders can reach your phone. Needs iOS 16.4 or newer.',
  android: 'Reminders also work straight from Chrome without installing, but the installed app opens full screen and keeps its icon with the rest of your apps.',
  desktop: 'Notifications work from the browser tab as well; installing just gives BoilerIndy its own window and a dock icon.',
}
