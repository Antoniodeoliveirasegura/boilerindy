import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CampusAlertBanner from './CampusAlertBanner'
import { PURDUE_ALERT_SIGNUP_URL, type CampusAlertAnswer } from '../lib/campusAlert'

// Issue #34: IU's emergency alert for the Indianapolis campus at the top of
// the page. IU's words, the source and time, PurdueALERT's sign-up, and a way
// to hide one alert; nothing while the read is off or quiet.

const ACTIVE: CampusAlertAnswer = {
  enabled: true,
  active: true,
  alert: {
    id: '17892038570001397900001',
    source: 'IU Indianapolis',
    sentAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    headline: 'IU Indy emergency: Dangerous situation near Sports Complex Garage',
    message: 'IU Indianapolis emergency: A dangerous situation is occurring on campus near Sports Complex Garage and Riverwalk Garage.',
    instruction: 'Avoid the area and trust your instincts.',
    severity: 'Severe',
    level: 'danger',
    test: false,
  },
  checkedAt: new Date().toISOString(),
  stale: false,
}

let answer: unknown

beforeEach(() => {
  answer = ACTIVE
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(answer))),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
})

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CampusAlertBanner />
    </QueryClientProvider>,
  )
}

describe('CampusAlertBanner', () => {
  it('shows IU\'s alert in IU\'s words, announced at once, with the source, the age and PurdueALERT\'s sign-up', async () => {
    renderBanner()
    const banner = await screen.findByRole('region', { name: 'Campus alert' })
    const announced = within(banner).getByRole('alert')
    expect(announced).toHaveTextContent('IU Indy emergency: Dangerous situation near Sports Complex Garage')
    expect(announced).toHaveTextContent('A dangerous situation is occurring on campus near Sports Complex Garage and Riverwalk Garage.')
    expect(announced).toHaveTextContent('Avoid the area and trust your instincts.')
    expect(banner).toHaveTextContent(/IU Indianapolis alert · .*12 min ago/)
    const signup = within(banner).getByRole('link', { name: 'Get PurdueALERT texts' })
    expect(signup).toHaveAttribute('href', PURDUE_ALERT_SIGNUP_URL)
    expect(signup).toHaveAttribute('target', '_blank')
    expect(signup).toHaveAttribute('rel', 'noopener noreferrer')
    expect(banner).not.toHaveTextContent('Last checked')
    expect(fetch).toHaveBeenCalledWith('/api/campus-alert', expect.anything())
  })

  it('says when IU was last checked once the server has been serving its last answer for a while', async () => {
    answer = { ...ACTIVE, stale: true, checkedAt: new Date(Date.now() - 5 * 60_000).toISOString() }
    renderBanner()
    expect(await screen.findByRole('region', { name: 'Campus alert' })).toHaveTextContent('Last checked')
  })

  it('shows a test quietly, labeled as one', async () => {
    answer = { ...ACTIVE, alert: { ...ACTIVE.alert!, test: true, level: 'test', headline: 'IU Indy TEST Alert: NWS TEST Tornado Warning' } }
    renderBanner()
    const banner = await screen.findByRole('region', { name: 'Campus alert' })
    expect(within(banner).queryByRole('alert')).toBeNull()
    expect(within(banner).getByRole('status')).toHaveTextContent('Test')
    expect(banner).toHaveTextContent('IU Indianapolis test ·')
  })

  it('hides one alert for the rest of the tab, and a new message from IU shows again', async () => {
    const { unmount } = renderBanner()
    fireEvent.click(await screen.findByRole('button', { name: 'Hide this alert' }))
    expect(screen.queryByRole('region', { name: 'Campus alert' })).toBeNull()
    unmount()

    // Same alert after a reload: still hidden.
    const again = renderBanner()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region', { name: 'Campus alert' })).toBeNull()
    again.unmount()

    // IU's next message (the final, say) has a new id.
    answer = { ...ACTIVE, alert: { ...ACTIVE.alert!, id: '17892038570001397900002', headline: 'IU Indy final alert: There is no longer a threat near the Sports Complex Garage.' } }
    renderBanner()
    expect(await screen.findByRole('region', { name: 'Campus alert' })).toHaveTextContent('There is no longer a threat')
  })

  it.each([
    ['the switch is off', { enabled: false, active: false, alert: null, checkedAt: null, stale: false }],
    ['IU\'s all clear', { enabled: true, active: false, alert: null, checkedAt: new Date().toISOString(), stale: false }],
    ['an unrelated answer', { items: [], ok: true }],
  ])('renders nothing when %s', async (_label, body) => {
    answer = body
    const { container } = renderBanner()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    // Let the answer land, then check that nothing rendered.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Campus alerts are not available right now.', status: 503, code: 'campus_alert_unavailable' } }), { status: 503 })),
    )
    const { container } = renderBanner()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(container).toBeEmptyDOMElement()
  })
})
