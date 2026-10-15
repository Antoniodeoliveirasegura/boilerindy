import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminLeads from './AdminLeads'
import { listAdminLeads } from '../../lib/adminApi'

// A slow answer for the default New filter used to land after the admin
// picked Closed and replace the closed requests, so a new request with its
// Create account, Mark contacted and Close actions showed under the Closed
// pill. The active pill also gave assistive tech no pressed state.

vi.mock('../../lib/adminApi', () => ({
  listAdminLeads: vi.fn(),
  updateAdminLead: vi.fn(),
}))

const NEW_LEAD = { id: 'lead-new', email: 'owner@beanco.test', companyName: 'Bean Co', status: 'new' }
const CLOSED_LEAD = { id: 'lead-closed', email: 'hi@closedco.test', companyName: 'Closed Co', status: 'closed' }

beforeEach(() => {
  vi.mocked(listAdminLeads)
    .mockReset()
    .mockImplementation(async (status) => ({ leads: status === 'closed' ? [CLOSED_LEAD] : [NEW_LEAD] }))
})

afterEach(cleanup)

function renderLeads() {
  return render(
    <MemoryRouter>
      <AdminLeads />
    </MemoryRouter>,
  )
}

it('drops a slow answer for a filter the admin has already left', async () => {
  let resolveNew!: (value: unknown) => void
  vi.mocked(listAdminLeads).mockImplementation(async (status) => {
    if (status === 'new') {
      return new Promise((resolve) => {
        resolveNew = resolve
      })
    }
    return { leads: [CLOSED_LEAD] }
  })
  renderLeads()
  await waitFor(() => expect(listAdminLeads).toHaveBeenCalledWith('new'))

  fireEvent.click(screen.getByRole('button', { name: 'Closed' }))
  expect(await screen.findByText('Closed Co')).toBeInTheDocument()
  await act(async () => {
    resolveNew({ leads: [NEW_LEAD] })
  })

  expect(screen.queryByText('Bean Co')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Mark contacted' })).not.toBeInTheDocument()
  expect(screen.getByText('Closed Co')).toBeInTheDocument()
  expect(screen.queryByText('Loading requests…')).not.toBeInTheDocument()
})

it('marks the active filter pill as pressed', async () => {
  renderLeads()
  await screen.findByText('Bean Co')
  const group = screen.getByRole('group', { name: 'Request status' })
  expect(within(group).getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'true')
  expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')

  fireEvent.click(within(group).getByRole('button', { name: 'Closed' }))
  expect(within(group).getByRole('button', { name: 'Closed' })).toHaveAttribute('aria-pressed', 'true')
  expect(within(group).getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'false')
})
