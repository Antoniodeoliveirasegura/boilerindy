import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { getServerWarmupState, resetServerWarmupForTests, startServerWarmup } from '../lib/serverWarmup'
import ServerWakeNotice from './ServerWakeNotice'

// Issue #164's pill for a Render cold start. The sign-in page says the same
// thing in its own status line, where the student waits (issue #389), so the
// pill stays off it.

// The wake-up ping that never answers, past the point where it counts as slow.
async function serverWaking() {
  void startServerWarmup({ fetchImpl: () => new Promise<Response>(() => {}), slowAfterMs: 0 })
  await waitFor(() => expect(getServerWarmupState().status).toBe('slow'))
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} useTransitions={false}>
      <ServerWakeNotice />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  resetServerWarmupForTests()
})

describe('ServerWakeNotice', () => {
  test('shows the pill once the wake-up ping drags on', async () => {
    await serverWaking()
    renderAt('/dashboard')
    expect(screen.getByTestId('server-wake-notice')).toHaveTextContent('Waking up the server.')
  })

  test('shows nothing on the sign-in page, which says it in its own status line', async () => {
    await serverWaking()
    renderAt('/login?next=%2Fdashboard')
    expect(screen.queryByTestId('server-wake-notice')).not.toBeInTheDocument()
  })
})
