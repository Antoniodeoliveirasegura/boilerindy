import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ageLabel,
  alertKey,
  alertSentLine,
  campusClock,
  lastCheckedLine,
  readHiddenAlert,
  rememberHiddenAlert,
  visibleAlert,
  type CampusAlert,
} from './campusAlert'

// Issue #34: the campus alert banner's reading of GET /api/campus-alert. The
// times are IU's dangerous-situation alert of 2026-09-12, 3:49 AM campus time.
// ICU may put a narrow no-break space before AM, so lines are compared with
// their spaces made plain.
const plain = (text: string | null) => (text == null ? text : text.replace(/\s/g, ' '))

const ALERT: CampusAlert = {
  id: '17892038570001397900001',
  source: 'IU Indianapolis',
  sentAt: '2026-09-12T07:49:00.000Z',
  headline: 'IU Indy emergency: Dangerous situation near Sports Complex Garage',
  message: 'IU Indianapolis emergency: A dangerous situation is occurring on campus near Sports Complex Garage and Riverwalk Garage.',
  instruction: null,
  severity: 'Severe',
  level: 'danger',
  test: false,
}

afterEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

describe('visibleAlert', () => {
  test('shows an alert only when the read is on, active and carries one with a headline', () => {
    expect(visibleAlert({ enabled: true, active: true, alert: ALERT, checkedAt: '2026-09-12T07:49:30.000Z', stale: false })).toBe(ALERT)
    expect(visibleAlert({ enabled: false, active: false, alert: null, checkedAt: null, stale: false })).toBeNull()
    expect(visibleAlert({ enabled: true, active: false, alert: null })).toBeNull()
    expect(visibleAlert({ enabled: true, active: true, alert: { ...ALERT, headline: '' } })).toBeNull()
    expect(visibleAlert({ enabled: true, active: true, alert: null })).toBeNull()
    // Any other answer, such as the e2e mock's catch-all { items: [], ok: true }, shows nothing.
    expect(visibleAlert({ items: [], ok: true } as never)).toBeNull()
    expect(visibleAlert(undefined)).toBeNull()
  })
})

describe('alertKey', () => {
  test('is IU\'s id, or the time and headline when IU sent none', () => {
    expect(alertKey(ALERT)).toBe('17892038570001397900001')
    expect(alertKey({ ...ALERT, id: null })).toBe(`2026-09-12T07:49:00.000Z|${ALERT.headline}`)
  })
})

describe('times', () => {
  const sent = new Date('2026-09-12T07:49:00.000Z')

  test('campusClock gives the campus time, with the date when it was not today on campus', () => {
    expect(plain(campusClock(sent, new Date('2026-09-12T08:01:00.000Z')))).toBe('3:49 AM')
    expect(plain(campusClock(sent, new Date('2026-09-13T15:00:00.000Z')))).toBe('Sep 12, 3:49 AM')
  })

  test('ageLabel counts minutes, then hours, then days', () => {
    expect(ageLabel(sent, new Date('2026-09-12T07:49:40.000Z'))).toBe('just now')
    expect(ageLabel(sent, new Date('2026-09-12T08:01:00.000Z'))).toBe('12 min ago')
    expect(ageLabel(sent, new Date('2026-09-12T10:50:00.000Z'))).toBe('3 h ago')
    expect(ageLabel(sent, new Date('2026-09-14T08:00:00.000Z'))).toBe('2 days ago')
  })

  test('alertSentLine names the source, the time sent and how long ago', () => {
    const now = new Date('2026-09-12T08:01:00.000Z')
    expect(plain(alertSentLine(ALERT, now))).toBe('IU Indianapolis alert · 3:49 AM, 12 min ago')
    expect(plain(alertSentLine({ ...ALERT, test: true }, now))).toBe('IU Indianapolis test · 3:49 AM, 12 min ago')
    expect(alertSentLine({ ...ALERT, sentAt: null }, now)).toBe('IU Indianapolis alert')
    expect(alertSentLine({ ...ALERT, sentAt: 'soon' }, now)).toBe('IU Indianapolis alert')
  })

  test('lastCheckedLine says when IU last answered, or nothing without a time', () => {
    const now = new Date('2026-09-12T08:01:00.000Z')
    expect(plain(lastCheckedLine('2026-09-12T07:55:00.000Z', now))).toBe('Last checked 3:55 AM')
    expect(lastCheckedLine(null, now)).toBeNull()
  })
})

describe('hiding one alert', () => {
  test('is remembered for this tab by the alert\'s key', () => {
    expect(readHiddenAlert()).toBeNull()
    rememberHiddenAlert(alertKey(ALERT))
    expect(readHiddenAlert()).toBe('17892038570001397900001')
  })

  test('storage that throws hides nothing and never breaks the banner', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => rememberHiddenAlert('x')).not.toThrow()
    expect(readHiddenAlert()).toBeNull()
  })
})
