import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Schedule from './Schedule'

// Issue #372: with PURDUE_AUTH_MODE=off, needsPurdueConnection is always false,
// and the setup card read that as "linked", telling students who never linked
// Purdue that their Purdue account was linked. The card now says so only when
// the account really has a Purdue link.

// One stable result: a new object per render would loop the page's derived state.
const classes = vi.hoisted(() => ({ data: { items: [] }, isLoading: false, error: null }))
vi.mock('../lib/queries/userData', () => ({ useMyClasses: () => classes }))
const auth = vi.hoisted(() => ({
  user: { id: 'user-1' },
  onboarding: {
    linkedSourceCount: 0,
    classCount: 0,
    hasPurdueLinked: false,
    needsPurdueConnection: false,
    needsScheduleSource: true,
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

afterEach(cleanup)

function renderWith(onboarding: Partial<typeof auth.onboarding>) {
  auth.onboarding = { ...auth.onboarding, ...onboarding }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Schedule />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Schedule setup card', () => {
  test('linking off and never linked: asks for the timetable feed and claims no link', () => {
    renderWith({ hasPurdueLinked: false, needsPurdueConnection: false, needsScheduleSource: true })
    expect(screen.getByText('Connect your timetable feed to sync your recurring class meetings into this page.')).toBeInTheDocument()
    expect(screen.queryByText(/Purdue account is linked/)).toBeNull()
  })

  test('linking on and not linked: asks to link Purdue first', () => {
    renderWith({ hasPurdueLinked: false, needsPurdueConnection: true, needsScheduleSource: false })
    expect(screen.getByText('Link Purdue to import your schedule')).toBeInTheDocument()
    expect(screen.queryByText(/Purdue account is linked/)).toBeNull()
  })

  test('linked with no feed yet: says the Purdue account is linked', () => {
    renderWith({ hasPurdueLinked: true, needsPurdueConnection: false, needsScheduleSource: true })
    expect(screen.getByText(/Your Purdue account is linked\./)).toBeInTheDocument()
  })
})
