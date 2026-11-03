import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Safety from './Safety'
import { PURDUE_ALERT_SIGNUP_URL, type CampusAlertAnswer } from '../lib/campusAlert'

// Issue #550, item 9: /safety, where a campus alert push opens. IU's alert as
// the banner shows it, without the button that hides it, or a line saying
// there is none. Demo text only: never an emergency in a test.

const ACTIVE: CampusAlertAnswer = {
  enabled: true,
  active: true,
  alert: {
    id: 'demo-1',
    source: 'IU Indianapolis',
    sentAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    headline: 'Demo alert: This is sample text, not a real emergency',
    message: 'Sample description from the demo alert.',
    instruction: null,
    severity: 'Severe',
    level: 'danger',
    test: false,
  },
  checkedAt: new Date().toISOString(),
  stale: false,
}

let answer: unknown
let status = 200

beforeEach(() => {
  answer = ACTIVE
  status = 200
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(answer), { status })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Safety />
    </QueryClientProvider>,
  )
}

describe('Safety', () => {
  it("shows the active alert in IU's words, with no button to hide it, and PurdueALERT's sign-up", async () => {
    renderPage()
    const card = await screen.findByTestId('safety-alert')
    expect(within(card).getByRole('alert')).toHaveTextContent('Demo alert: This is sample text, not a real emergency')
    expect(card).toHaveTextContent('Sample description from the demo alert.')
    expect(card).toHaveTextContent(/IU Indianapolis alert · .*4 min ago/)
    expect(within(card).queryByRole('button', { name: 'Hide this alert' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Campus Alerts' })).toBeInTheDocument()
    for (const link of screen.getAllByRole('link', { name: /get purduealert texts/i })) {
      expect(link).toHaveAttribute('href', PURDUE_ALERT_SIGNUP_URL)
    }
  })

  it('after the all clear, says there is no active alert, and when IU was checked', async () => {
    answer = { enabled: true, active: false, alert: null, checkedAt: new Date().toISOString(), stale: false }
    renderPage()
    const line = await screen.findByRole('status')
    expect(line).toHaveTextContent('No active alert. IU Indianapolis has not reported an emergency on campus.')
    expect(line).toHaveTextContent('Last checked')
    expect(screen.queryByTestId('safety-alert')).toBeNull()
  })

  it('says so while the read is off, and when IU cannot be reached', async () => {
    answer = { enabled: false, active: false, alert: null, checkedAt: null, stale: false }
    const { unmount } = renderPage()
    expect(await screen.findByRole('status')).toHaveTextContent('Campus alerts are not available on BoilerIndy right now.')
    unmount()

    status = 503
    answer = { error: { message: 'Campus alerts are not available right now.', status: 503, code: 'campus_alert_unavailable' } }
    renderPage()
    expect(await screen.findByRole('status')).toHaveTextContent("BoilerIndy can't reach IU's alerts right now.")
  })
})
