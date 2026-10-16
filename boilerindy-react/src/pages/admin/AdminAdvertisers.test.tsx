import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import AdminAdvertisers from './AdminAdvertisers'
import { createAdminAdvertiser, listAdminAdvertisers } from '../../lib/adminApi'

// The Create advertiser account dialog:
// - Took no focus, let Tab walk out to the page under its scrim, and ignored
//   Escape, though it was marked aria-modal.
// - Showed a refused create behind the scrim, where it could be neither read
//   nor dismissed.
// - Pushed a history entry over /admin/advertisers?lead=..., so Back after
//   creating the account reopened the dialog with the same email and
//   temporary password, and Cancel then Back looped.

vi.mock('../../lib/adminApi', () => ({
  listAdminAdvertisers: vi.fn(),
  createAdminAdvertiser: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(listAdminAdvertisers).mockReset().mockResolvedValue({ advertisers: [] })
  vi.mocked(createAdminAdvertiser)
    .mockReset()
    .mockResolvedValue({ advertiser: { email: 'owner@beanco.test' } })
})

afterEach(cleanup)

function Where() {
  const { pathname, search } = useLocation()
  return <p data-testid="where">{pathname + search}</p>
}

function HistoryBack() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(-1)}>
      History back
    </button>
  )
}

const LEAD_URL = '/admin/advertisers?lead=lead-new&email=owner%40beanco.test&company=Bean%20Co'

function renderPage(entries: string[] = ['/admin/advertisers']) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/admin/leads" element={<p>Access requests</p>} />
        <Route path="/admin/advertisers" element={<AdminAdvertisers />} />
      </Routes>
      <Where />
      <HistoryBack />
    </MemoryRouter>,
  )
}

async function openDialog() {
  renderPage()
  const opener = await screen.findByRole('button', { name: 'Create account' })
  opener.focus()
  fireEvent.click(opener)
  return { opener, dialog: await screen.findByRole('dialog', { name: 'Create advertiser account' }) }
}

describe('AdminAdvertisers create dialog', () => {
  it('moves focus into the dialog, keeps Tab inside it, and Escape closes it back to the opener', async () => {
    const { opener, dialog } = await openDialog()
    const email = within(dialog).getByLabelText('Business email')
    expect(email).toHaveFocus()

    const submit = within(dialog).getByRole('button', { name: 'Create account' })
    submit.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(email).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(submit).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })

  it('shows a refused create inside the dialog, where it can be read and dismissed', async () => {
    vi.mocked(createAdminAdvertiser).mockRejectedValueOnce(
      new Error('Company name is required and must be 200 characters or fewer.'),
    )
    const { dialog } = await openDialog()
    fireEvent.change(within(dialog).getByLabelText('Business email'), { target: { value: 'owner@bean.example' } })
    fireEvent.change(within(dialog).getByLabelText('Company name'), { target: { value: '    ' } })
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Create account' }).closest('form') as HTMLFormElement)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Company name is required and must be 200 characters or fewer.')
    expect(dialog).toContainElement(alert)
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('AdminAdvertisers history', () => {
  it('after creating from an access request, Back returns to the requests', async () => {
    renderPage(['/admin/leads', LEAD_URL])
    const dialog = await screen.findByRole('dialog', { name: 'Create advertiser account' })
    expect(within(dialog).getByLabelText('Business email')).toHaveValue('owner@beanco.test')

    fireEvent.submit(within(dialog).getByRole('button', { name: 'Create account' }).closest('form') as HTMLFormElement)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(createAdminAdvertiser).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'lead-new' }))
    // This router keeps React Router's transitions (App.tsx turns them off), so
    // the cleared prefill commits a render after the one that removes the
    // dialog, and the URL gets its own wait.
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/admin\/advertisers$/))

    fireEvent.click(screen.getByRole('button', { name: 'History back' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/leads')
    expect(screen.getByText('Access requests')).toBeInTheDocument()
  })

  it('Cancel on a prefilled dialog does not leave a step for Back to reopen it from', async () => {
    renderPage(['/admin/leads', LEAD_URL])
    const dialog = await screen.findByRole('dialog', { name: 'Create advertiser account' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'History back' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/leads')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
