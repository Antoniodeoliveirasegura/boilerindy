// The campus alert banner (issue #34): the shape of GET /api/campus-alert,
// IU's emergency alert for the Indianapolis campus, and the lines the banner
// shows around IU's own words. docs/campus-alerts.md has the source and the
// rule that ends an alert.

export type CampusAlertLevel = 'danger' | 'warning' | 'test'

export type CampusAlert = {
  id: string | null
  source: string
  sentAt: string | null
  headline: string
  message: string | null
  instruction: string | null
  severity: string
  level: CampusAlertLevel
  test: boolean
}

export type CampusAlertAnswer = {
  enabled?: boolean
  active?: boolean
  alert?: CampusAlert | null
  checkedAt?: string | null
  stale?: boolean
}

/** PurdueALERT's text sign-up, the official channel the banner points to. */
export const PURDUE_ALERT_SIGNUP_URL = 'https://www.purdue.edu/ehps/emergency-preparedness/purduealert-text/'

const CAMPUS_TIME_ZONE = 'America/Indiana/Indianapolis'
const HIDDEN_ALERT_KEY = 'boilerindy-campus-alert-hidden'

/** The alert to show, or null: only an answer that is on, active and carries an alert with a headline. */
export function visibleAlert(answer: CampusAlertAnswer | null | undefined): CampusAlert | null {
  if (!answer?.enabled || !answer.active) return null
  const alert = answer.alert
  return alert && typeof alert.headline === 'string' && alert.headline ? alert : null
}

/** What a hidden alert is remembered by: IU's id, or its time and headline when IU sent none. */
export function alertKey(alert: Pick<CampusAlert, 'id' | 'sentAt' | 'headline'>): string {
  return alert.id ?? `${alert.sentAt ?? ''}|${alert.headline}`
}

function campusDay(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: CAMPUS_TIME_ZONE })
}

/** "3:49 AM" in campus time, with the date in front ("Sep 12, 3:49 AM") when it was not today. */
export function campusClock(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CAMPUS_TIME_ZONE })
  if (campusDay(at) === campusDay(now)) return time
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: CAMPUS_TIME_ZONE })}, ${time}`
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ageLabel(at: Date, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} days ago`
}

function parsed(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "IU Indianapolis alert · 3:49 AM, 12 min ago", or the source alone when the time is unknown. */
export function alertSentLine(alert: Pick<CampusAlert, 'source' | 'sentAt' | 'test'>, now: Date = new Date()): string {
  const source = `${alert.source} ${alert.test ? 'test' : 'alert'}`
  const sent = parsed(alert.sentAt)
  return sent ? `${source} · ${campusClock(sent, now)}, ${ageLabel(sent, now)}` : source
}

/** "Last checked 10:42 PM", for an answer the server kept serving while IU was unreachable. */
export function lastCheckedLine(checkedAt: string | null | undefined, now: Date = new Date()): string | null {
  const checked = parsed(checkedAt)
  return checked ? `Last checked ${campusClock(checked, now)}` : null
}

/** The alert this tab hid, or null. Storage that is missing or throws hides nothing. */
export function readHiddenAlert(): string | null {
  try {
    return window.sessionStorage.getItem(HIDDEN_ALERT_KEY)
  } catch {
    return null
  }
}

/**
 * Hide one alert for the rest of this tab's session. Only that alert: a new
 * message from IU has a new key and shows again, and a new tab shows it too.
 */
export function rememberHiddenAlert(key: string): void {
  try {
    window.sessionStorage.setItem(HIDDEN_ALERT_KEY, key)
  } catch {
    // Without storage the banner still hides until the page reloads.
  }
}
